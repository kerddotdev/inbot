import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { expect, test as base } from "vitest";
import { ListRejectionsResponse } from "../../../../packages/contracts/src/lists.js";
import { OwnerSessionResponse } from "../../../../packages/contracts/src/owner.js";
import { migrate, migrations } from "../store.js";
import { listsSchema } from "../lists/schema.js";
import { Connection } from "../auth/owner.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { ingestInbound } from "../inbound/ingest.js";
import { makeLists } from "../lists/lists.js";
import { client } from "../mcp/test-client.js";
import { tunnelRoute } from "./tunnel-policy.js";
import { fixture } from "./test-fixture.js";

const inbox = "agent@example.test";
const path = "/v0/owner/lists/rejections";
const test = base.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-rejections-"));
    const api = await fixture(home);
    try {
      await use(api);
    } finally {
      await api.close();
      await rm(home, { recursive: true, force: true });
    }
  },
});
const payload = (id: string, recipients = [inbox]) => ({
  mail_from: "sender@blocked.test",
  rcpt_to: recipients,
  raw: Buffer.from(
    `Message-ID: <${id}@blocked.test>\r\nFrom: Sender <sender@blocked.test>\r\nSubject: Private subject\r\n\r\nPrivate body`,
  ),
  received_at: "2026-10-11T12:00:00Z",
});
const ingest = (api: Awaited<ReturnType<typeof fixture>>, id: string, recipients?: string[]) =>
  api.run(ingestInbound(payload(id, recipients)).pipe(Effect.provideService(Mailbox, api.mailbox)));
async function list(api: Awaited<ReturnType<typeof fixture>>, query = "") {
  const response = await api.request(`${path}${query}`);
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(ListRejectionsResponse)(await response.json());
}

test("lists blocked inbound metadata with stable pagination and deletes without accepting a replay", async ({
  api,
}) => {
  const lists = makeLists(api.store);
  await api.run(lists.create(undefined, "receive", "block", { entry: "blocked.test" }));
  await ingest(api, "first", [inbox, "other@example.test"]);
  await ingest(api, "second");
  const all = await list(api);
  expect(all.count).toBe(3);
  expect(all.rejections[0]).toMatchObject({
    received_at: "2026-10-11T12:00:00Z",
    sender_address: "sender@blocked.test",
    reason_code: "blocked_sender",
    rules: [{ entry: "blocked.test", entry_type: "domain", list_type: "block", inbox_id: null }],
  });
  expect(JSON.stringify(all)).not.toMatch(/Private subject|Private body|payload_hash/);
  const first = await list(api, "?limit=1");
  const second = await list(
    api,
    `?limit=1&page_token=${encodeURIComponent(first.next_page_token ?? "")}`,
  );
  expect(second.rejections[0]?.rejection_id).not.toBe(first.rejections[0]?.rejection_id);
  expect(
    (
      await api.request(
        `${path}?inbox_id=${inbox}&page_token=${encodeURIComponent(first.next_page_token ?? "")}`,
      )
    ).status,
  ).toBe(409);
  expect((await list(api, `?inbox_id=${inbox}`)).count).toBe(2);
  const removed = all.rejections.find((item) => item.inbox_id === "other@example.test");
  if (!removed) throw new Error("Expected a rejection for the other inbox");
  await api.run(lists.delete(undefined, "receive", "block", "blocked.test"));
  expect((await api.request(`${path}/${removed.rejection_id}`, { method: "DELETE" })).status).toBe(
    200,
  );
  expect((await api.request(`${path}/${removed.rejection_id}`, { method: "DELETE" })).status).toBe(
    404,
  );
  expect((await ingest(api, "first", ["other@example.test"]))[0]?.status).toBe("skipped_blocked");
  expect((await list(api)).count).toBe(2);
  expect(await api.run(lists.rejections({ inbox_id: "other@example.test" }))).toMatchObject({
    count: 0,
  });
  const restarted = await api.restart();
  try {
    const connection = Schema.decodeUnknownSync(Schema.fromJsonString(Connection))(
      await readFile(join(api.home, "connection.json"), "utf8"),
    );
    const response = await fetch(`${restarted.url}${path}`, {
      headers: { authorization: `Bearer ${connection.token}` },
    });
    expect(response.status).toBe(200);
    expect(Schema.decodeUnknownSync(ListRejectionsResponse)(await response.json()).count).toBe(2);
  } finally {
    await restarted.close();
  }
  expect(await readFile(join(api.home, "inbot.db"), "utf8")).not.toContain("sender@blocked.test");
});

test("keeps rejections owner-only across grants, browser CSRF, MCP, and tunnel routes", async ({
  api,
}) => {
  await api.run(makeLists(api.store).create(inbox, "receive", "allow", { entry: "trusted.test" }));
  await ingest(api, "denied");
  const item = (await list(api)).rejections[0];
  if (!item) throw new Error("Expected a rejection");
  expect(item).toMatchObject({
    reason_code: "sender_not_allowed",
    rules: [{ entry: "trusted.test", inbox_id: inbox }],
  });
  for (const inbox_id of [undefined, inbox, "other@example.test"]) {
    const key = await api.run(
      api.keys.create({
        ...(inbox_id ? { inbox_id } : {}),
        permissions: { list_entry_read: true, list_entry_delete: true, message_read: true },
        send_policy: "direct",
      }),
    );
    for (const [url, method] of [
      [path, "GET"],
      [`${path}/${item.rejection_id}`, "DELETE"],
    ])
      expect(
        (await api.request(url ?? path, { method: method ?? "GET", token: key.api_key })).status,
      ).toBe(403);
  }
  expect((await api.request(path, { token: null })).status).toBe(401);
  const login = await api.request("/v0/owner/setup", {
    token: null,
    method: "POST",
    body: { password: "synthetic owner password", code: api.setupCode },
  });
  const session = Schema.decodeUnknownSync(OwnerSessionResponse)(await login.json());
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect((await api.request(path, { token: null, headers: { cookie } })).status).toBe(200);
  expect(
    (
      await api.request(`${path}/${item.rejection_id}`, {
        token: null,
        method: "DELETE",
        headers: { cookie },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await api.request(`${path}/${item.rejection_id}`, {
        token: null,
        method: "DELETE",
        headers: { cookie, "x-inbot-csrf": session.csrf_token, origin: api.url },
      })
    ).status,
  ).toBe(200);
  const mcp = await client(api, api.token);
  expect((await mcp.list()).tools.some((tool) => /rejection/i.test(tool.name))).toBe(false);
  expect(tunnelRoute(path)).toBe("blocked");
  expect(tunnelRoute(`${path}/${item.rejection_id}`)).toBe("blocked");
});

test("migration 14 keeps legacy rejection decisions without inventing missing metadata", async ({
  api,
}) => {
  await api.run(
    api.store.use((db) => {
      db.exec("DROP TABLE inbound_list_rejection_receipts; DROP TABLE inbound_list_rejections");
      db.exec(listsSchema.slice(listsSchema.indexOf("CREATE TABLE inbound_list_rejections")));
      db.prepare(
        "INSERT INTO inbound_list_rejections (inbox_id, payload_hash, reason_code, received_at) VALUES (?, ?, ?, ?)",
      ).run(inbox, "legacy-hash", "blocked_sender", "2026-10-10T12:00:00Z");
      db.pragma("user_version = 13");
      Effect.runSync(migrate(db));
      expect(db.pragma("user_version", { simple: true })).toBe(migrations.at(-1)?.version);
      Effect.runSync(migrate(db));
    }),
  );
  const page = await list(api);
  expect(page.rejections).toEqual([
    {
      rejection_id: expect.any(String),
      inbox_id: inbox,
      received_at: "2026-10-10T12:00:00Z",
      reason_code: "blocked_sender",
      sender_address: null,
      rules: [],
    },
  ]);
});
