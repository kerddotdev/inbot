import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { expect, test as base } from "vitest";
import {
  Message,
  SendMessageResponse,
  ListMessagesResponse,
  SearchMessagesResponse,
} from "../../../../packages/contracts/src/messages.js";
import { Thread } from "../../../../packages/contracts/src/threads.js";
import { CurrentPrincipal } from "../../../../packages/contracts/src/security.js";
import { Connection } from "../auth/owner.js";
import { readEvents } from "../events/log.js";
import { OutboundProvider } from "../outbound/cloudflare.js";
import { client } from "../mcp/test-client.js";
import { fixture } from "./test-fixture.js";

const inboxId = "agent@example.test";
const route = `/v0/inboxes/${inboxId}/messages`;
const request = { to: "recipient@example.test", text: "Synthetic outcome message" };
type Mode = "timeout" | "lost_response" | "rejected" | "sent";
const test = base.extend<{
  api: Awaited<ReturnType<typeof fixture>>;
  provider: { mode: Mode; calls: number };
}>({
  provider: async ({ task: _task }, use) => use({ mode: "timeout", calls: 0 }),
  api: async ({ provider }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-outcome-test-"));
    const fakeFetch: typeof fetch = async (_url, init) => {
      provider.calls++;
      if (provider.mode === "timeout")
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("Synthetic timeout")), {
            once: true,
          });
        });
      if (provider.mode === "lost_response") return new Response("Synthetic incomplete response");
      if (provider.mode === "rejected") return Response.json({ success: false }, { status: 400 });
      return Response.json({
        success: true,
        result: { message_id: `<provider-${provider.calls}@example.test>` },
      });
    };
    const api = await fixture(home, {
      outboundSend: (message) =>
        OutboundProvider.use((provider) => provider.send(message)).pipe(
          Effect.provide(
            OutboundProvider.live({
              account_id: "synthetic",
              api_token: "synthetic",
              timeout_ms: 10,
              fetch: fakeFetch,
            }),
          ),
        ),
    });
    try {
      await use(api);
    } finally {
      await api.close();
      await rm(home, { recursive: true, force: true });
    }
  },
});
async function queue(api: Awaited<ReturnType<typeof fixture>>) {
  await api.run(api.transport.set({ account_id: "synthetic", api_token: "synthetic" }));
  const response = await api.request(`${route}/send`, {
    method: "POST",
    body: request,
    headers: { "idempotency-key": "outcome-send" },
  });
  expect(response.status).toBe(200);
  const sent = Schema.decodeUnknownSync(SendMessageResponse)(await response.json());
  await api.run(api.outbox.processDue());
  return sent;
}
const read = async (api: Awaited<ReturnType<typeof fixture>>, id: string) =>
  Schema.decodeUnknownSync(Message)(
    await (await api.request(`${route}/${encodeURIComponent(id)}`)).json(),
  );
const events = (api: Awaited<ReturnType<typeof fixture>>) =>
  api.run(api.store.use((db) => readEvents(db, 0)));

for (const mode of ["timeout", "lost_response"] as const) {
  test(`${mode} exposes send_unknown through REST, MCP, lists and threads without resending`, async ({
    api,
    provider,
  }) => {
    provider.mode = mode;
    const sent = await queue(api);
    const message = await read(api, sent.message_id);
    expect(message).toMatchObject({
      labels: ["send_unknown"],
      send_status: "send_unknown",
      send_reason: "unknown_outcome",
    });
    const key = await api.run(
      api.keys.create({
        inbox_id: inboxId,
        permissions: { message_read: true, message_send: true, message_update: true },
        send_policy: "direct",
      }),
    );
    const mcp = await client(api, key.api_key);
    expect(
      (await mcp.call("get_message", { inboxId, messageId: sent.message_id })).structuredContent,
    ).toMatchObject({
      send_status: "send_unknown",
      labels: ["send_unknown"],
      send_reason: "unknown_outcome",
    });
    expect((await mcp.list()).tools.some((tool) => tool.name.includes("resolve"))).toBe(false);
    const list = Schema.decodeUnknownSync(ListMessagesResponse)(
      await (await api.request(`${route}?labels=send_unknown`)).json(),
    );
    expect(list.messages).toContainEqual(
      expect.objectContaining({ message_id: sent.message_id, send_status: "send_unknown" }),
    );
    const search = Schema.decodeUnknownSync(SearchMessagesResponse)(
      await (await api.request(`${route}/search?q=outcome`)).json(),
    );
    expect(search.messages).toContainEqual(
      expect.objectContaining({ message_id: sent.message_id, send_reason: "unknown_outcome" }),
    );
    const thread = Schema.decodeUnknownSync(Thread)(
      await (await api.request(`/v0/inboxes/${inboxId}/threads/${sent.thread_id}`)).json(),
    );
    expect(thread.labels).toContain("send_unknown");
    expect(thread.messages[0]?.send_status).toBe("send_unknown");
    const resolvePath = `${route}/${encodeURIComponent(sent.message_id)}/resolve`;
    expect(
      (
        await api.request(resolvePath, {
          token: key.api_key,
          method: "POST",
          body: { decision: "sent" },
        })
      ).status,
    ).toBe(403);
    await expect(
      api.run(
        api.outbox.resolve(inboxId, sent.message_id, { decision: "failed" }).pipe(
          Effect.provideService(CurrentPrincipal, {
            kind: "agent",
            api_key_id: key.api_key_id,
            grant: key,
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "missing_permission" });
    expect(
      (
        await api.request(`${route}/${encodeURIComponent(sent.message_id)}`, {
          token: key.api_key,
          method: "PATCH",
          body: { remove_labels: "send_unknown", add_labels: "sent" },
        })
      ).status,
    ).toBe(400);
    expect((await read(api, sent.message_id)).labels).toEqual(["send_unknown"]);
    await api.run(
      api.store.use((db) => {
        db.prepare("DELETE FROM message_labels WHERE inbox_id = ? AND message_id = ?").run(
          inboxId,
          sent.message_id,
        );
        db.prepare("INSERT INTO message_labels VALUES (?, ?, 'failed')").run(
          inboxId,
          sent.message_id,
        );
      }),
    );
    expect((await read(api, sent.message_id)).labels).toEqual(["send_unknown"]);
    const legacy = Schema.decodeUnknownSync(ListMessagesResponse)(
      await (await api.request(`${route}?labels=send_unknown`)).json(),
    );
    expect(legacy.messages.map((message) => message.message_id)).toContain(sent.message_id);
    const failures = Schema.decodeUnknownSync(ListMessagesResponse)(
      await (await api.request(`${route}?labels=failed`)).json(),
    );
    expect(failures.messages.map((message) => message.message_id)).not.toContain(sent.message_id);
    await api.run(
      api.store.use((db) =>
        db
          .prepare("UPDATE messages SET headers = ? WHERE inbox_id = ? AND message_id = ?")
          .run(JSON.stringify({ "X-Synthetic": "x".repeat(30_000) }), inboxId, sent.message_id),
      ),
    );
    expect(
      (await mcp.call("get_message", { inboxId, messageId: sent.message_id })).structuredContent,
    ).toMatchObject({
      truncated: true,
      send_status: "send_unknown",
      send_reason: "unknown_outcome",
    });
    api.advance(24 * 60 * 60_000);
    expect(await api.run(api.outbox.processDue())).toBe(0);
    expect(provider.calls).toBe(1);
    expect((await events(api)).at(-1)?.payload).toMatchObject({
      event_type: "message.send_unknown",
      outcome: { message_id: sent.message_id, reason: "unknown_outcome" },
    });
  });
}

test("a definite provider rejection exposes failed with a reason", async ({ api, provider }) => {
  provider.mode = "rejected";
  const sent = await queue(api);
  expect(await read(api, sent.message_id)).toMatchObject({
    labels: ["failed"],
    send_status: "failed",
    send_reason: "validation_error",
  });
  expect((await events(api)).at(-1)?.payload).toMatchObject({
    event_type: "message.failed",
    failure: { reason: "validation_error" },
  });
  expect(
    (
      await api.request(`${route}/${encodeURIComponent(sent.message_id)}/resolve`, {
        method: "POST",
        body: { decision: "sent" },
      })
    ).status,
  ).toBe(400);
  expect(provider.calls).toBe(1);
});

for (const decision of ["sent", "failed"] as const) {
  test(`owner resolution to ${decision} persists with one event and never reuses the old send`, async ({
    api,
    provider,
  }) => {
    const sent = await queue(api);
    const path = `${route}/${encodeURIComponent(sent.message_id)}/resolve`;
    const before = await events(api);
    for (let replay = 0; replay < 2; replay++) {
      const response = await api.request(path, { method: "POST", body: { decision } });
      expect(response.status).toBe(200);
      expect(Schema.decodeUnknownSync(Message)(await response.json())).toMatchObject({
        labels: [decision],
        send_status: decision,
        send_reason: decision === "sent" ? "owner_confirmed_sent" : "owner_confirmed_not_sent",
      });
    }
    const after = await events(api);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)?.payload).toMatchObject(
      decision === "sent"
        ? { event_type: "message.sent", send: { reason: "owner_confirmed_sent" } }
        : { event_type: "message.failed", failure: { reason: "owner_confirmed_not_sent" } },
    );
    expect(
      (
        await api.request(path, {
          method: "POST",
          body: { decision: decision === "sent" ? "failed" : "sent" },
        })
      ).status,
    ).toBe(400);
    const restarted = await api.restart();
    try {
      const connection = Schema.decodeUnknownSync(Schema.fromJsonString(Connection))(
        await readFile(join(api.home, "connection.json"), "utf8"),
      );
      const response = await fetch(
        `${restarted.url}${route}/${encodeURIComponent(sent.message_id)}`,
        { headers: { authorization: `Bearer ${connection.token}` } },
      );
      expect(response.status).toBe(200);
      expect(Schema.decodeUnknownSync(Message)(await response.json()).send_status).toBe(decision);
    } finally {
      await restarted.close();
    }
    expect(await api.run(api.outbox.processDue())).toBe(0);
    expect(provider.calls).toBe(1);
    if (decision === "failed") {
      provider.mode = "sent";
      const response = await api.request(`${route}/send`, {
        method: "POST",
        body: request,
        headers: { "idempotency-key": "deliberate-new-send" },
      });
      const replacement = Schema.decodeUnknownSync(SendMessageResponse)(await response.json());
      expect(replacement.message_id).not.toBe(sent.message_id);
      await api.run(api.outbox.processDue());
      expect(provider.calls).toBe(2);
      expect((await read(api, sent.message_id)).send_status).toBe("failed");
      expect((await read(api, replacement.message_id)).send_status).toBe("sent");
    }
  });
}

test("owner resolution rolls back when the durable event cannot be recorded", async ({ api }) => {
  const sent = await queue(api);
  const before = await events(api);
  await api.run(
    api.store.use((db) =>
      db.exec(
        "CREATE TRIGGER reject_resolution BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'synthetic'); END",
      ),
    ),
  );
  expect(
    (
      await api.request(`${route}/${encodeURIComponent(sent.message_id)}/resolve`, {
        method: "POST",
        body: { decision: "sent" },
      })
    ).status,
  ).toBe(503);
  expect((await read(api, sent.message_id)).send_status).toBe("send_unknown");
  expect(await events(api)).toEqual(before);
});
