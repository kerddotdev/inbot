import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, test as base } from "vitest";
import { makeOAuth } from "../../server/src/oauth/service.js";
import {
  OAuthClientsResponse,
  PurgeOAuthClientsResponse,
} from "../../../packages/contracts/src/oauth.js";
import { Event } from "../../../packages/contracts/src/events.js";
import { Webhook, ListWebhooksResponse } from "../../../packages/contracts/src/webhooks.js";
import { readEvents } from "../../server/src/events/log.js";
import { Draft } from "../../../packages/contracts/src/drafts.js";
import { ListInboxesResponse, Inbox } from "../../../packages/contracts/src/inboxes.js";
import { Message, SendMessageResponse } from "../../../packages/contracts/src/messages.js";
import { CreateApiKeyResponse } from "../../../packages/contracts/src/api-keys.js";
import { fixture } from "../../server/src/http/test-fixture.js";
import { runCli, type CliIO } from "./cli.js";
import { errorExitCode } from "./errors.js";
import { ErrorCode, ErrorStatus } from "../../../packages/contracts/src/errors.js";

const inboxId = "agent@example.test";
const parentId = "<first@example.test>";
const test = base.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-cli-test-"));
    try {
      const api = await fixture(home);
      try {
        await use(api);
      } finally {
        await api.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
});
async function invoke(
  api: Awaited<ReturnType<typeof fixture>>,
  args: string[],
  overrides: Partial<CliIO> = {},
) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    env: { INBOT_HOME: api.home },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    ...overrides,
  });
  return { code, stdout, stderr };
}
const agentEnv = (api: Awaited<ReturnType<typeof fixture>>, token: string) => ({
  INBOT_URL: api.url,
  INBOT_API_KEY: token,
});
const payload = {
  to: ["recipient@example.test"],
  subject: "Synthetic CLI message",
  text: "Synthetic content",
};

async function agent(
  api: Awaited<ReturnType<typeof fixture>>,
  send_policy: "direct" | "approval" | "read_only" = "direct",
) {
  return api.run(
    api.keys.create({
      inbox_id: inboxId,
      permissions: {
        inbox_read: true,
        message_read: true,
        message_send: true,
        message_reply: true,
        message_update: true,
        draft_read: true,
        draft_create: true,
        draft_update: true,
        draft_send: true,
        draft_delete: true,
      },
      send_policy,
    }),
  );
}

test("reads the owner connection and returns unchanged snake_case wire JSON", async ({ api }) => {
  const response = await api.request("/v0/inboxes");
  const expected = await response.json();
  const result = await invoke(api, ["inboxes", "list", "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(expected);
  expect(Schema.decodeUnknownSync(ListInboxesResponse)(JSON.parse(result.stdout)).count).toBe(2);
  expect(result.stdout + result.stderr).not.toContain(api.token);
  const human = await invoke(api, ["inboxes", "list"]);
  expect(human.stdout).toContain("INBOX_ID");
  expect(human.stdout).toContain(inboxId);
  const flag = await invoke(api, ["--home", api.home, "inboxes", "get", inboxId, "--json"], {
    env: { INBOT_HOME: join(api.home, "missing") },
  });
  expect(flag.code).toBe(0);
});

test("authenticates scoped agent keys and surfaces concealed scope errors and owner-only 403s", async ({
  api,
}) => {
  const key = await agent(api);
  const env = agentEnv(api, key.api_key);
  const list = await invoke(api, ["inboxes", "list", "--json"], { env });
  expect(
    Schema.decodeUnknownSync(ListInboxesResponse)(JSON.parse(list.stdout)).inboxes.map(
      (entry) => entry.inbox_id,
    ),
  ).toEqual([inboxId]);
  const expected = await (
    await api.request("/v0/inboxes/other@example.test", { token: key.api_key })
  ).json();
  const scope = await invoke(api, ["inboxes", "get", "other@example.test"], { env });
  expect(scope.code).toBe(5);
  expect(JSON.parse(scope.stderr)).toEqual(expected);
  const forbidden = await invoke(api, ["api-keys", "list"], { env });
  expect(forbidden.code).toBe(4);
  expect(JSON.parse(forbidden.stderr)).toMatchObject({ code: "missing_permission" });
  const denied = await invoke(api, ["drafts", "approve", inboxId, "absent"], { env });
  expect(denied.code).toBe(4);
  expect(denied.stderr).toContain("missing_permission");
  expect(list.stdout + scope.stderr + forbidden.stderr).not.toContain(key.api_key);
  const invalid = await invoke(api, ["inboxes", "list"], {
    env: agentEnv(api, "invalid-synthetic-token"),
  });
  expect(invalid.code).toBe(3);
  expect(JSON.parse(invalid.stderr)).toMatchObject({ code: "unauthorized" });
});

test("prints generated send keys and replays send and reply without duplicate effects", async ({
  api,
}) => {
  await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
  const key = await agent(api);
  const env = agentEnv(api, key.api_key);
  const args = ["messages", "send", inboxId, "--data", JSON.stringify(payload), "--json"];
  const first = await invoke(api, args, { env });
  expect(first.code).toBe(0);
  const idempotencyKey = first.stderr.match(/^Idempotency-Key: ([A-Za-z0-9._~-]+)\n$/)?.[1];
  expect(idempotencyKey).toBeDefined();
  if (idempotencyKey === undefined) throw new Error("Missing idempotency key");
  const sent = Schema.decodeUnknownSync(SendMessageResponse)(JSON.parse(first.stdout));
  const replay = await invoke(api, [...args, "--idempotency-key", idempotencyKey], { env });
  expect(replay.stdout).toBe(first.stdout);
  const stored = await api.request(
    `/v0/inboxes/${inboxId}/messages/${encodeURIComponent(sent.message_id)}`,
  );
  expect(Schema.decodeUnknownSync(Message)(await stored.json()).labels).toContain("queued");
  expect(api.sent).toHaveLength(0);
  const changed = await invoke(
    api,
    [
      "messages",
      "send",
      inboxId,
      "--to",
      "recipient@example.test",
      "--text",
      "Changed",
      "--idempotency-key",
      idempotencyKey,
    ],
    { env },
  );
  expect(changed.code).toBe(6);
  expect(changed.stderr).toContain("idempotency_conflict");
  const reply = [
    "messages",
    "reply",
    inboxId,
    parentId,
    "--text",
    "Synthetic reply",
    "--reply-all",
    "--idempotency-key",
    "cli-reply",
    "--json",
  ];
  const firstReply = await invoke(api, reply, { env });
  expect(firstReply.code).toBe(0);
  expect((await invoke(api, reply, { env })).stdout).toBe(firstReply.stdout);
  const forwarded = await invoke(
    api,
    [
      "messages",
      "forward",
      inboxId,
      parentId,
      "--to",
      "recipient@example.test",
      "--text",
      "Synthetic forward",
      "--json",
    ],
    { env },
  );
  expect(forwarded.code).toBe(0);
});

test("preserves server-enforced approval and read-only policies", async ({ api }) => {
  await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
  for (const policy of ["approval", "read_only"] as const) {
    const key = await agent(api, policy);
    const args = [
      "messages",
      "send",
      inboxId,
      "--data",
      JSON.stringify(payload),
      "--idempotency-key",
      `cli-${policy}`,
    ];
    const result = await invoke(api, args, { env: agentEnv(api, key.api_key) });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain(
      policy === "approval" ? "approval_required" : "missing_permission",
    );
    expect(result.stdout).toBe("");
    if (policy === "approval")
      expect((await invoke(api, args, { env: agentEnv(api, key.api_key) })).stderr).toBe(
        result.stderr,
      );
  }
  expect(api.sent).toHaveLength(0);
});

test("creates single-use login links and opens a browser only on explicit request", async ({
  api,
}) => {
  await api.request("/v0/owner/setup", {
    token: null,
    method: "POST",
    body: { password: "synthetic owner password", code: api.setupCode },
  });
  const opened: string[] = [];
  const openBrowser = async (url: string) => {
    opened.push(url);
  };
  const result = await invoke(api, ["open", "--json"], { openBrowser });
  expect(result.code).toBe(0);
  const link: unknown = JSON.parse(result.stdout);
  const { OwnerLoginLink } = await import("../../../packages/contracts/src/owner.js");
  const url = Schema.decodeUnknownSync(OwnerLoginLink)(link).url;
  expect(opened).toEqual([]);
  const token = new URL(url).searchParams.get("token");
  const redeem = () =>
    api.request("/v0/owner/login-links/redeem", { token: null, method: "POST", body: { token } });
  expect((await redeem()).status).toBe(200);
  expect((await redeem()).status).toBe(401);
  const browser = await invoke(api, ["open", "--browser"], { openBrowser });
  expect(browser.code).toBe(0);
  expect(opened).toEqual([browser.stdout.trim()]);
});

test("maps resource commands, pagination, label edits, draft reversals, and key revocation", async ({
  api,
}) => {
  const created = await invoke(api, [
    "inboxes",
    "create",
    "--username",
    "cli",
    "--domain",
    "example.test",
    "--json",
  ]);
  expect(created.code).toBe(0);
  const inbox = Schema.decodeUnknownSync(Inbox)(JSON.parse(created.stdout));
  expect(await invoke(api, ["inboxes", "delete", inbox.inbox_id, "--json"])).toMatchObject({
    code: 0,
    stdout: "null\n",
  });
  const threads = await invoke(api, [
    "threads",
    "list",
    "--inbox",
    inboxId,
    "--limit",
    "1",
    "--labels",
    "unread",
    "--json",
  ]);
  expect(threads.code).toBe(0);
  expect(
    (await invoke(api, ["threads", "get", api.threadId, "--inbox", inboxId, "--json"])).code,
  ).toBe(0);
  expect((await invoke(api, ["messages", "get", inboxId, parentId, "--json"])).code).toBe(0);
  expect(
    (
      await invoke(api, [
        "messages",
        "update",
        inboxId,
        parentId,
        "--add-labels",
        "review",
        "--remove-labels",
        "unread",
        "--json",
      ])
    ).code,
  ).toBe(0);
  const file = join(api.home, "synthetic-draft.json");
  await writeFile(file, JSON.stringify(payload));
  const result = await invoke(api, ["drafts", "create", inboxId, "--data-file", file, "--json"]);
  expect(result.code).toBe(0);
  const draft = Schema.decodeUnknownSync(Draft)(JSON.parse(result.stdout));
  expect(
    (
      await invoke(api, [
        "drafts",
        "update",
        inboxId,
        draft.draft_id,
        "--data",
        '{"subject":null}',
        "--json",
      ])
    ).code,
  ).toBe(0);
  expect(
    (await invoke(api, ["drafts", "get", draft.draft_id, "--inbox", inboxId, "--json"])).code,
  ).toBe(0);
  expect((await invoke(api, ["drafts", "list", "--inbox", inboxId, "--json"])).code).toBe(0);
  expect((await invoke(api, ["drafts", "delete", inboxId, draft.draft_id])).code).toBe(0);
  const keyResult = await invoke(api, [
    "api-keys",
    "create",
    "--inbox",
    inboxId,
    "--permissions",
    '{"inbox_read":true}',
    "--send-policy",
    "read_only",
    "--show-secret",
    "--json",
  ]);
  expect(keyResult.code).toBe(0);
  const key = Schema.decodeUnknownSync(CreateApiKeyResponse)(JSON.parse(keyResult.stdout));
  expect((await invoke(api, ["api-keys", "revoke", key.api_key_id, "--inbox", inboxId])).code).toBe(
    0,
  );
  expect((await invoke(api, ["inboxes", "list"], { env: agentEnv(api, key.api_key) })).code).toBe(
    3,
  );
  const hidden = await invoke(api, [
    "api-keys",
    "create",
    "--permissions",
    "{}",
    "--send-policy",
    "read_only",
    "--json",
  ]);
  expect(hidden.code).toBe(0);
  expect(JSON.parse(hidden.stdout)).not.toHaveProperty("api_key");
});

test("returns stable usage and availability exits without exposing malformed credentials", async ({
  api,
}) => {
  for (const args of [
    ["unknown"],
    ["--home"],
    ["inboxes", "get"],
    ["inboxes", "list", "--oops"],
    ["drafts", "create", inboxId, "--data", '{"unknown":true}'],
    ["messages", "send", inboxId, "--idempotency-key", "bad key"],
    ["inboxes", "list", "--flavor", "unknown"],
  ]) {
    expect((await invoke(api, args)).code).toBe(2);
  }
  const missing = await invoke(api, ["inboxes", "list"], {
    env: { INBOT_HOME: join(api.home, "missing") },
  });
  expect(missing.code).toBe(10);
  const incomplete = await invoke(api, ["inboxes", "list"], { env: { INBOT_URL: api.url } });
  expect(incomplete.code).toBe(2);
  const malformed = await invoke(api, ["inboxes", "list"], {
    env: { INBOT_URL: "http://synthetic-secret@example.test", INBOT_API_KEY: "synthetic-api-key" },
  });
  expect(malformed.code).toBe(2);
  expect(malformed.stderr).not.toContain("synthetic-secret");
  expect(malformed.stderr).not.toContain("synthetic-api-key");
  const unavailable = await invoke(api, [
    "messages",
    "send",
    inboxId,
    "--data",
    JSON.stringify(payload),
  ]);
  expect(unavailable.code).toBe(10);
  expect(unavailable.stderr).toContain("service_unavailable");
});

test("covers every shared server error category with stable exits", () => {
  const categories: Record<number, number> = {
    400: 2,
    413: 2,
    401: 3,
    403: 4,
    404: 5,
    409: 6,
    423: 7,
    429: 8,
    501: 9,
    503: 10,
  };
  for (const code of ErrorCode.literals)
    expect(
      errorExitCode({ name: "Synthetic", code, message: "Synthetic error", fix: "Synthetic fix" }),
    ).toBe(categories[ErrorStatus[code]]);
});

test("sends drafts and preserves owner approval and rejection responses", async ({ api }) => {
  await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
  const key = await agent(api, "approval");
  const create = async (extra: Record<string, unknown> = {}) => {
    const result = await invoke(
      api,
      ["drafts", "create", inboxId, "--data", JSON.stringify({ ...payload, ...extra }), "--json"],
      { env: agentEnv(api, key.api_key) },
    );
    expect(result.code).toBe(0);
    return Schema.decodeUnknownSync(Draft)(JSON.parse(result.stdout));
  };
  const scheduled = await create({ send_at: "2026-10-10T13:00:00Z" });
  const approve = await invoke(api, [
    "drafts",
    "approve",
    inboxId,
    scheduled.draft_id,
    "--idempotency-key",
    "cli-approve",
    "--json",
  ]);
  expect(approve.code).toBe(0);
  expect(Schema.decodeUnknownSync(Draft)(JSON.parse(approve.stdout))).toMatchObject({
    approval_state: "approved",
    send_status: "scheduled",
  });
  const sent = await invoke(api, [
    "drafts",
    "send",
    inboxId,
    scheduled.draft_id,
    "--idempotency-key",
    "cli-draft-send",
    "--json",
  ]);
  expect(sent.code).toBe(0);
  Schema.decodeUnknownSync(SendMessageResponse)(JSON.parse(sent.stdout));
  const rejected = await create();
  const decision = await invoke(api, [
    "drafts",
    "reject",
    inboxId,
    rejected.draft_id,
    "--reason",
    "Synthetic rejection",
    "--json",
  ]);
  expect(decision.code).toBe(0);
  expect(Schema.decodeUnknownSync(Draft)(JSON.parse(decision.stdout))).toMatchObject({
    approval_state: "rejected",
    rejection_reason: "Synthetic rejection",
  });
  const forbidden = await invoke(api, ["drafts", "reject", inboxId, rejected.draft_id], {
    env: agentEnv(api, key.api_key),
  });
  expect(forbidden.code).toBe(4);
  const immediate = await create();
  const approved = await invoke(api, ["drafts", "approve", inboxId, immediate.draft_id, "--json"]);
  expect(approved.code).toBe(0);
  Schema.decodeUnknownSync(SendMessageResponse)(JSON.parse(approved.stdout));
  expect(api.sent).toHaveLength(0);
});

test("list commands use global and inbox endpoints, decode entries, paginate and preserve errors", async ({
  api,
}) => {
  const create = await invoke(api, [
    "lists",
    "create",
    "receive",
    "block",
    "--entry",
    "EXAMPLE.TEST",
    "--reason",
    "Synthetic rule",
    "--json",
  ]);
  expect(create.code).toBe(0);
  expect(JSON.parse(create.stdout)).toMatchObject({
    entry: "example.test",
    entry_type: "domain",
    direction: "receive",
    list_type: "block",
  });
  const get = await invoke(api, ["lists", "get", "receive", "block", "EXAMPLE.TEST", "--json"]);
  expect(get.code).toBe(0);
  expect(JSON.parse(get.stdout)).toEqual(JSON.parse(create.stdout));
  const key = await api.run(
    api.keys.create({
      inbox_id: inboxId,
      permissions: { list_entry_read: true, list_entry_create: true, list_entry_delete: true },
      send_policy: "read_only",
    }),
  );
  const options = { env: agentEnv(api, key.api_key) };
  for (const entry of ["b.test", "a.test"])
    expect(
      (
        await invoke(
          api,
          ["lists", "create", "send", "allow", "--inbox", inboxId, "--entry", entry],
          options,
        )
      ).code,
    ).toBe(0);
  const list = await invoke(
    api,
    ["lists", "list", "send", "allow", "--inbox", inboxId, "--limit", "1", "--json"],
    options,
  );
  const page = JSON.parse(list.stdout);
  expect(list.code).toBe(0);
  expect(page.entries).toHaveLength(1);
  expect(page.entries[0].entry).toBe("a.test");
  const next = await invoke(
    api,
    [
      "lists",
      "list",
      "send",
      "allow",
      "--inbox",
      inboxId,
      "--page-token",
      page.next_page_token,
      "--json",
    ],
    options,
  );
  expect(JSON.parse(next.stdout).entries[0].entry).toBe("b.test");
  const human = await invoke(api, ["lists", "list", "send", "allow", "--inbox", inboxId], options);
  expect(human.stdout).toContain("ENTRY_TYPE");
  expect(human.stdout).toContain("a.test");
  expect(
    (await invoke(api, ["lists", "delete", "send", "allow", "a.test", "--inbox", inboxId], options))
      .code,
  ).toBe(0);
  expect(
    (await invoke(api, ["lists", "get", "send", "allow", "a.test", "--inbox", inboxId], options))
      .code,
  ).toBe(5);
  expect((await invoke(api, ["lists", "list", "receive", "block"], options)).code).toBe(4);
  expect(
    (
      await invoke(
        api,
        ["lists", "list", "send", "allow", "--inbox", "other@example.test"],
        options,
      )
    ).code,
  ).toBe(5);
  expect((await invoke(api, ["lists", "delete", "receive", "block", "example.test"])).code).toBe(0);
  const help = await invoke(api, ["lists", "create", "--help"]);
  expect(help.stdout).toContain("<direction> <type>");
  expect(help.stdout).toContain("--entry");
});

test("webhook commands use shared REST contracts, inbox scope, custom headers and explicit secret output", async ({
  api,
}) => {
  const args = [
    "webhooks",
    "create",
    "--inbox",
    inboxId,
    "--url",
    "http://localhost:1234/",
    "--event-types",
    "message.received",
    "--json",
  ];
  const omitted = await invoke(api, args);
  expect(omitted.code).toBe(0);
  expect(Schema.decodeUnknownSync(Webhook)(JSON.parse(omitted.stdout)).secret).toBeUndefined();
  expect(omitted.stderr).toContain("Secret omitted");
  const result = await invoke(api, [...args, "--show-secret"]);
  const created = Schema.decodeUnknownSync(Webhook)(JSON.parse(result.stdout));
  expect(created.secret).toMatch(/^whsec_/);
  const listed = await invoke(api, ["webhooks", "list", "--inbox", inboxId, "--json"]);
  expect(
    Schema.decodeUnknownSync(ListWebhooksResponse)(JSON.parse(listed.stdout)).webhooks,
  ).toHaveLength(2);
  const update = await invoke(api, [
    "webhooks",
    "update",
    created.webhook_id,
    "--inbox",
    inboxId,
    "--no-enabled",
    "--json",
  ]);
  expect(Schema.decodeUnknownSync(Webhook)(JSON.parse(update.stdout)).enabled).toBe(false);
  expect(
    (
      await invoke(api, [
        "webhooks",
        "update-headers",
        created.webhook_id,
        "--headers",
        '{"X-Trace":"synthetic"}',
      ])
    ).code,
  ).toBe(0);
  const headers = await invoke(api, ["webhooks", "headers", created.webhook_id, "--json"]);
  expect(JSON.parse(headers.stdout)).toEqual({ header_names: ["x-trace"] });
  expect((await invoke(api, ["webhooks", "delete", created.webhook_id])).code).toBe(0);
  expect((await invoke(api, ["webhooks", "get", created.webhook_id])).code).toBe(5);
});

test("events --follow replays typed JSON events through bearer WebSocket and stops on cancellation", async ({
  api,
}) => {
  const previous = await api.run(api.store.use((db) => readEvents(db, 0)));
  const cursor = previous.at(-1)?.event_id;
  if (!cursor) throw new Error("Expected fixture event");
  await api.run(
    api.mailbox.insertMessage({
      inbox_id: inboxId,
      message_id: "<cli-event@example.test>",
      direction: "received",
      from: "sender@example.test",
      to: [inboxId],
      timestamp: "2026-10-10T12:00:00Z",
      text: "Synthetic CLI event",
      raw: Buffer.from("Synthetic raw"),
    }),
  );
  const controller = new AbortController();
  let stdout = "";
  const code = await runCli(
    ["events", "--follow", "--json", "--last-event-id", cursor, "--inbox", inboxId],
    {
      env: { INBOT_HOME: api.home },
      signal: controller.signal,
      stdout: (text) => {
        stdout += text;
        controller.abort();
      },
      stderr: () => {},
    },
  );
  expect(code).toBe(0);
  const event = Schema.decodeUnknownSync(Event)(JSON.parse(stdout));
  expect(event).toMatchObject({
    event_type: "message.received",
    message: { message_id: "<cli-event@example.test>" },
  });
});

test("remote commands use owner REST, validate hostname and preserve agent rejection", async ({
  api,
}) => {
  const initial = await invoke(api, ["remote", "status", "--json"]);
  expect(initial.code).toBe(0);
  expect(JSON.parse(initial.stdout)).toMatchObject({ state: "disabled", hostname: null });
  expect((await invoke(api, ["remote", "enable", "--json"])).code).toBe(2);
  const enabled = await invoke(api, [
    "remote",
    "enable",
    "--hostname",
    "inbot.example.test",
    "--json",
  ]);
  expect(enabled.code).toBe(0);
  expect(JSON.parse(enabled.stdout)).toMatchObject({
    state: "connecting",
    hostname: "inbot.example.test",
  });
  expect(enabled.stdout).not.toContain("token");
  const key = await agent(api);
  const denied = await invoke(api, ["remote", "status"], { env: agentEnv(api, key.api_key) });
  expect(denied.code).toBe(4);
  expect(JSON.parse(denied.stderr)).toMatchObject({ code: "missing_permission" });
  const disabled = await invoke(api, ["remote", "disable", "--json"]);
  expect(disabled.code).toBe(0);
  expect(JSON.parse(disabled.stdout)).toMatchObject({ state: "disabled", hostname: null });
});

test("shows historical unknown sends and resolves only with owner credentials", async ({ api }) => {
  const sent = await api.run(api.outbox.enqueue(inboxId, { kind: "send", request: payload }));
  await api.run(
    api.store.use((db) => {
      db.prepare("UPDATE outbox SET state = 'sending' WHERE message_id = ?").run(sent.message_id);
    }),
  );
  api.advance(5 * 60_000);
  await api.run(api.outbox.processDue());
  const visible = await invoke(api, ["messages", "get", inboxId, sent.message_id]);
  expect(visible.stdout).toContain("send_unknown");
  expect(visible.stdout).toContain("unknown_outcome");
  const key = await agent(api);
  const command = ["messages", "resolve", inboxId, sent.message_id, "--decision", "failed"];
  expect((await invoke(api, command, { env: agentEnv(api, key.api_key) })).code).toBe(4);
  const resolved = await invoke(api, [...command, "--json"]);
  expect(resolved.code).toBe(0);
  expect(Schema.decodeUnknownSync(Message)(JSON.parse(resolved.stdout))).toMatchObject({
    send_status: "failed",
    send_reason: "owner_confirmed_not_sent",
  });
  expect(api.sent).toHaveLength(0);
});

test("owner OAuth CLI lists, purges unused registrations and revokes grants while excluding agent credentials", async ({
  api,
}) => {
  const oauth = makeOAuth(api.store);
  const registered = await api.run(
    oauth.register({
      client_name: "Synthetic CLI client",
      redirect_uris: ["http://127.0.0.1:8765/callback"],
    }),
  );
  await api.run(
    oauth.consent(
      {
        response_type: "code",
        client_id: registered.client_id,
        redirect_uri: registered.redirect_uris[0],
        resource: `${api.url}/mcp`,
        code_challenge_method: "S256",
        code_challenge: "a".repeat(43),
        approved: true,
        grant: {
          inbox_ids: [inboxId],
          permissions: { inbox_read: true },
          send_policy: "read_only",
        },
      },
      api.url,
    ),
  );
  const listed = await invoke(api, ["oauth", "clients", "--json"]);
  expect(listed.code).toBe(0);
  const clients = Schema.decodeUnknownSync(Schema.fromJsonString(OAuthClientsResponse))(
    listed.stdout,
  );
  const approved = clients.grants[0];
  if (!approved) throw new Error("Missing authorized client");
  expect(approved.client_name).toBe("Synthetic CLI client");
  await api.run(oauth.register({ redirect_uris: ["com.example.unused:/callback"] }));
  const purged = await invoke(api, ["oauth", "purge", "--json"]);
  expect(purged.code).toBe(0);
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(PurgeOAuthClientsResponse))(purged.stdout),
  ).toEqual({ deleted_clients: 1 });
  expect((await api.run(oauth.clients())).grants.map((item) => item.grant_id)).toEqual([
    approved.grant_id,
  ]);
  const key = await api.run(
    api.keys.create({ permissions: { inbox_read: true }, send_policy: "read_only" }),
  );
  const agent = await invoke(api, ["oauth", "clients", "--json"], {
    env: { INBOT_URL: api.url, INBOT_API_KEY: key.api_key },
  });
  expect(agent.code).toBe(4);
  expect(JSON.parse(agent.stderr)).toMatchObject({ code: "missing_permission" });
  const agentPurge = await invoke(api, ["oauth", "purge", "--json"], {
    env: { INBOT_URL: api.url, INBOT_API_KEY: key.api_key },
  });
  expect(agentPurge.code).toBe(4);
  expect(JSON.parse(agentPurge.stderr)).toMatchObject({ code: "missing_permission" });
  expect((await invoke(api, ["oauth", "revoke", approved.grant_id])).code).toBe(0);
  const after = await invoke(api, ["oauth", "clients", "--json"]);
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(OAuthClientsResponse))(after.stdout).grants,
  ).toEqual([]);
  expect((await invoke(api, ["inboxes", "list", "--json"])).code).toBe(0);
});
