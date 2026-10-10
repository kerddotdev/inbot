import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeSocket } from "@effect/platform-node";
import { Clock, Duration, Effect, Fiber, Queue, Schema } from "effect";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";
import { expect, test as base } from "vitest";
import { WebSocketFrame, Event } from "../../../../packages/contracts/src/events.js";
import { Webhook, ListWebhooksResponse } from "../../../../packages/contracts/src/webhooks.js";
import { OwnerSessionResponse } from "../../../../packages/contracts/src/owner.js";
import { fixture } from "../http/test-fixture.js";
import { SENDING_LEASE_MS } from "../outbound/outbox.js";
import { Store, DatabaseError } from "../store.js";
import {
  appendEvent,
  readEvents,
  eventVisible,
  pruneEvents,
  EVENT_RETENTION_MS,
  EventLog,
} from "./log.js";
import {
  processWebhooks,
  startWebhookLoop,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_LEASE_MS,
  WEBHOOK_MAX_BACKOFF_MS,
} from "./dispatcher.js";
import { verifyWebhook } from "./signature.js";
import { boundedSocketWriter, WEBSOCKET_MAX_BUFFER_BYTES } from "./websocket.js";
import {
  checkedTarget,
  publicAddress,
  webhookUrl,
  webhookSender,
  type WebhookRequest,
} from "./target.js";

const inboxId = "agent@example.test";
const otherId = "other@example.test";
const test = base.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-events-"));
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

const message = (inbox = inboxId, id = "new", labels: readonly string[] = []) => ({
  inbox_id: inbox,
  message_id: `<${id}@example.test>`,
  direction: "received" as const,
  from: "sender@example.test",
  to: [inbox],
  timestamp: "2026-10-10T12:00:00Z",
  raw: Buffer.from("Synthetic raw mail"),
  text: "Synthetic content",
  labels,
});
async function events(api: Awaited<ReturnType<typeof fixture>>) {
  return api.run(api.store.use((db) => readEvents(db, 0, 1000)));
}
async function hook(api: Awaited<ReturnType<typeof fixture>>, body?: unknown, token?: string) {
  const response = await api.request("/v0/webhooks", {
    method: "POST",
    body: body ?? {
      url:
        token === undefined
          ? "http://127.0.0.1:32123/events"
          : "https://receiver.example.test/events",
      event_types: ["message.received"],
    },
    ...(token === undefined ? {} : { token }),
  });
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(Webhook)(await response.json());
}
async function dispatch(
  api: Awaited<ReturnType<typeof fixture>>,
  sender: (input: WebhookRequest) => Promise<number>,
) {
  return api.run(processWebhooks(sender).pipe(Effect.provideService(Store, api.store)));
}
function requiredSecret(created: Webhook) {
  if (!created.secret) throw new Error("Expected a creation secret");
  return created.secret;
}

function bounded<A>(promise: Promise<A>): Promise<A> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for an observable event")),
      5000,
    );
    promise.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}
async function client(
  api: Awaited<ReturnType<typeof fixture>>,
  options: Socket.WebSocketConstructorOptions = {
    headers: { authorization: `Bearer ${api.token}` },
  },
  resume?: string,
) {
  const url = new URL("/v0/ws", api.url);
  url.protocol = "ws:";
  if (resume !== undefined) url.searchParams.set("last_event_id", resume);
  const socket =
    typeof options === "object" && !Array.isArray(options)
      ? new NodeSocket.NodeWS.WebSocket(
          url.href,
          options.headers?.["sec-websocket-protocol"]?.split(",").map((value) => value.trim()) ??
            [],
          options,
        )
      : new NodeSocket.NodeWS.WebSocket(url.href, options);
  const frames: WebSocketFrame[] = [];
  const pending: ((frame: WebSocketFrame) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const data =
      typeof event.data === "string"
        ? event.data
        : event.data instanceof Uint8Array
          ? Buffer.from(event.data).toString()
          : String(event.data);
    const frame = Schema.decodeUnknownSync(WebSocketFrame)(JSON.parse(data));
    const receive = pending.shift();
    if (receive) receive(frame);
    else frames.push(frame);
  });
  const closed = new Promise<Socket.WebSocketEvent>((resolve) =>
    socket.addEventListener("close", resolve, { once: true }),
  );
  await bounded(
    new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket handshake failed")), {
        once: true,
      });
    }),
  );
  return {
    socket,
    closed,
    next: () =>
      bounded(
        new Promise<WebSocketFrame>((resolve) => {
          const frame = frames.shift();
          if (frame) resolve(frame);
          else pending.push(resolve);
        }),
      ),
    subscribe: (filters: Record<string, unknown> = {}) =>
      socket.send(JSON.stringify({ type: "subscribe", ...filters })),
    close: async () => {
      socket.close();
      await bounded(closed);
    },
  };
}
async function rejectedHandshake(
  api: Awaited<ReturnType<typeof fixture>>,
  headers: Record<string, string>,
) {
  return bounded(
    new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${api.url}/v0/ws`,
        {
          agent: false,
          headers: {
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": "c3ludGhldGljLWtleS0xMg==",
            ...headers,
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("upgrade", (_response, socket) => {
        socket.destroy();
        reject(new Error("Unexpected upgrade"));
      });
      request.on("error", reject);
      request.end();
    }),
  );
}

test("event append rolls back with the state change, retains order and does not duplicate ingestion", async ({
  api,
}) => {
  const before = await events(api);
  await api.run(
    api.store.use((db) =>
      db.exec(
        "CREATE TRIGGER reject_event BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'synthetic'); END",
      ),
    ),
  );
  await expect(api.run(api.mailbox.insertMessage(message()))).rejects.toMatchObject({
    code: "database_failed",
  });
  expect(await events(api)).toEqual(before);
  await expect(
    api.run(api.mailbox.getMessage(inboxId, "<new@example.test>")),
  ).rejects.toMatchObject({ code: "not_found" });
  await api.run(api.store.use((db) => db.exec("DROP TRIGGER reject_event")));
  await api.run(api.mailbox.insertMessage(message()));
  await api.run(api.mailbox.insertMessage(message()));
  const log = await events(api);
  expect(log).toHaveLength(before.length + 1);
  expect(log.at(-1)?.sequence).toBeGreaterThan(before.at(-1)?.sequence ?? 0);
  expect(log.at(-1)?.payload).toMatchObject({
    event_type: "message.received",
    message: { text: "Synthetic content" },
  });
});

test("draft and outbound events distinguish approval, queueing, provider acceptance and delivery", async ({
  api,
}) => {
  await api.run(api.transport.set({ account_id: "synthetic", api_token: "synthetic" }));
  const draft = await api.run(
    api.drafts.create(
      inboxId,
      { to: ["recipient@example.test"], text: "Synthetic draft" },
      "owner",
      true,
    ),
  );
  await api.run(
    api.drafts.create(inboxId, { client_id: "repeat", text: "Synthetic" }, "owner", false),
  );
  await api.run(
    api.drafts.create(inboxId, { client_id: "repeat", text: "Synthetic" }, "owner", false),
  );
  const rejection = await api.run(api.drafts.create(inboxId, {}, "owner", true));
  await api.run(api.drafts.reject(inboxId, rejection.draft_id));
  await api.run(api.drafts.reject(inboxId, rejection.draft_id));
  const queued = await api.run(api.drafts.approve(inboxId, draft.draft_id, "approve"));
  expect("message_id" in queued).toBe(true);
  expect(
    (await events(api)).filter((row) => ["message.sent", "draft.sent"].includes(row.event_type)),
  ).toEqual([]);
  await api.run(api.outbox.processDue());
  const sent = (await events(api)).find((row) => row.event_type === "message.sent");
  expect(sent?.payload).not.toHaveProperty("message");
  if (sent?.payload.event_type !== "message.sent") throw new Error("Expected provider acceptance");
  const entry = await api.run(api.outbox.get(inboxId, sent.payload.send.message_id));
  if (entry.provider_message_id === null) throw new Error("Expected a provider ID");
  for (const status of ["delivered", "bounced", "complained", "failed"] as const) {
    const event = {
      event_id: status,
      provider_message_id: entry.provider_message_id,
      status,
      recipient: "recipient@example.test",
      timestamp: "2026-10-10T12:00:00Z",
    };
    await api.run(api.outbox.applyDeliveryEvent(event));
    await api.run(api.outbox.applyDeliveryEvent(event));
  }
  const log = await events(api);
  expect(log.filter((row) => row.event_type === "draft.approved")).toHaveLength(1);
  expect(log.filter((row) => row.event_type === "draft.sent")).toHaveLength(1);
  expect(log.filter((row) => row.event_type === "draft.rejected")).toHaveLength(1);
  for (const type of [
    "message.delivered",
    "message.bounced",
    "message.complained",
    "message.failed",
  ])
    expect(log.filter((row) => row.event_type === type)).toHaveLength(1);
  expect(log.filter((row) => row.event_type === "draft.created")).toHaveLength(3);
});

test("webhook CRUD enforces permissions, creator and inbox scope and returns secrets only at creation", async ({
  api,
}) => {
  const key = await api.run(
    api.keys.create({
      inbox_ids: [inboxId],
      permissions: {
        webhook_read: true,
        webhook_create: true,
        webhook_update: true,
        webhook_delete: true,
        message_read: true,
      },
      send_policy: "read_only",
    }),
  );
  const created = await hook(api, undefined, key.api_key);
  expect(created.inbox_ids).toEqual([inboxId]);
  expect(requiredSecret(created)).toMatch(/^whsec_/);
  const path = `/v0/webhooks/${created.webhook_id}`;
  expect(await (await api.request(path, { token: key.api_key })).json()).not.toHaveProperty(
    "secret",
  );
  expect(
    (
      await api.request(path, {
        token: key.api_key,
        method: "PATCH",
        body: { add_inbox_ids: [otherId] },
      })
    ).status,
  ).toBe(404);
  expect(
    (await api.request(`/v0/inboxes/${otherId}/webhooks`, { token: key.api_key })).status,
  ).toBe(404);
  const ownerHook = await hook(api);
  expect(
    (await api.request(`/v0/webhooks/${ownerHook.webhook_id}`, { token: key.api_key })).status,
  ).toBe(404);
  const listed = Schema.decodeUnknownSync(ListWebhooksResponse)(
    await (await api.request("/v0/webhooks", { token: key.api_key })).json(),
  );
  expect(listed.webhooks.map((item) => item.webhook_id)).toEqual([created.webhook_id]);
  expect(
    (
      await api.request(`${path}/headers`, {
        token: key.api_key,
        method: "PATCH",
        body: { headers: { "X-Receiver": "synthetic-value" } },
      })
    ).status,
  ).toBe(204);
  expect(await (await api.request(`${path}/headers`, { token: key.api_key })).json()).toEqual({
    header_names: ["x-receiver"],
  });
  expect(
    (
      await api.request(`${path}/headers`, {
        token: key.api_key,
        method: "PATCH",
        body: { headers: { "Webhook-Signature": "fake" } },
      })
    ).status,
  ).toBe(400);
  await api.request(`${path}/headers`, {
    token: key.api_key,
    method: "PATCH",
    body: { remove_headers: ["X-RECEIVER"] },
  });
  expect(await (await api.request(`${path}/headers`, { token: key.api_key })).json()).toEqual({
    header_names: [],
  });
  const noPermission = await api.run(api.keys.create({ permissions: {}, send_policy: "direct" }));
  expect((await api.request(path, { token: noPermission.api_key })).status).toBe(403);
  expect((await api.request(path, { token: key.api_key, method: "DELETE" })).status).toBe(200);
  expect((await api.request(path)).status).toBe(404);
});

test.for(["localhost", "receiver.example.test"])(
  "real sender delivers via %s with independently verified signatures",
  async (hostname, { api }) => {
    let receive: (request: {
      headers: import("node:http").IncomingHttpHeaders;
      body: string;
    }) => void = () => {};
    const received = new Promise<{
      headers: import("node:http").IncomingHttpHeaders;
      body: string;
    }>((resolve) => {
      receive = resolve;
    });
    const server = createServer(async (request, response) => {
      const parts: Buffer[] = [];
      for await (const chunk of request) parts.push(Buffer.from(chunk));
      receive({ headers: request.headers, body: Buffer.concat(parts).toString() });
      response.writeHead(204);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Expected a local receiver");
      const created = await hook(api, {
        url: `http://${hostname}:${address.port}/events`,
        event_types: ["message.received"],
      });
      await api.run(api.mailbox.insertMessage(message()));
      const resolved: string[] = [];
      await dispatch(
        api,
        webhookSender(async (name) => {
          resolved.push(name);
          return [{ address: "127.0.0.1", family: 4 }];
        }),
      );
      expect(resolved).toEqual(hostname === "localhost" ? [] : [hostname]);
      expect(await (await api.request(`/v0/webhooks/${created.webhook_id}`)).json()).toMatchObject({
        failure_count: 0,
        last_success_at: expect.any(String),
      });
      const request = await bounded(received);
      const event = Schema.decodeUnknownSync(Event)(JSON.parse(request.body));
      const timestamp = String(request.headers["webhook-timestamp"]);
      const secret = requiredSecret(created);
      const expected = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
        .update(`${event.event_id}.${timestamp}.${request.body}`)
        .digest("base64");
      expect(request.headers["webhook-id"]).toBe(event.event_id);
      expect(request.headers["webhook-signature"]).toBe(`v1,${expected}`);
      expect(
        verifyWebhook(
          secret,
          event.event_id,
          timestamp,
          request.body,
          `v1,${expected}`,
          Number(timestamp) * 1000,
        ),
      ).toBe(true);
      expect(
        verifyWebhook(
          secret,
          event.event_id,
          timestamp,
          `${request.body} `,
          `v1,${expected}`,
          Number(timestamp) * 1000,
        ),
      ).toBe(false);
      expect(
        verifyWebhook(
          secret,
          event.event_id,
          timestamp,
          request.body,
          `v1,${expected}`,
          Number(timestamp) * 1000 + 301_000,
        ),
      ).toBe(false);
      expect(
        Schema.decodeUnknownSync(Webhook)(
          await (await api.request(`/v0/webhooks/${created.webhook_id}`)).json(),
        ).last_success_at,
      ).toBeDefined();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

test("retries with an injected clock, caps backoff, preserves order and stable IDs, disables then re-enables", async ({
  api,
}) => {
  const created = await hook(api);
  await api.run(api.mailbox.insertMessage(message(inboxId, "retry-first")));
  await api.run(api.mailbox.insertMessage(message(inboxId, "retry-second")));
  const attempts: WebhookRequest[] = [];
  const fail = async (input: WebhookRequest) => {
    attempts.push(input);
    return 503;
  };
  let now = Date.parse("2026-10-10T12:00:00Z");
  for (let index = 0; index < WEBHOOK_MAX_ATTEMPTS; index++) {
    expect(await dispatch(api, fail)).toBe(1);
    expect(await dispatch(api, fail)).toBe(0);
    const delay = Math.min(30_000 * 2 ** index, WEBHOOK_MAX_BACKOFF_MS);
    const pending = await api.run(
      api.store.use((db) =>
        Schema.decodeUnknownSync(Schema.Struct({ next_attempt_at: Schema.Int }))(
          db
            .prepare(
              "SELECT next_attempt_at FROM webhook_deliveries WHERE state = 'pending' ORDER BY sequence LIMIT 1",
            )
            .get(),
        ),
      ),
    );
    expect(pending.next_attempt_at - now).toBe(delay);
    api.advance(delay);
    now += delay;
  }
  expect(new Set(attempts.map((input) => input.headers["webhook-id"])).size).toBe(1);
  expect(new Set(attempts.map((input) => input.body)).size).toBe(1);
  const path = `/v0/webhooks/${created.webhook_id}`;
  expect(await (await api.request(path)).json()).toMatchObject({
    enabled: false,
    disabled_reason: "sustained_failure",
    failure_count: 8,
  });
  await api.request(path, { method: "PATCH", body: { enabled: true } });
  const delivered: string[] = [];
  const success = async (input: WebhookRequest) => {
    delivered.push(input.headers["webhook-id"] ?? "");
    return 200;
  };
  expect(await dispatch(api, success)).toBe(1);
  expect(await dispatch(api, success)).toBe(1);
  expect(delivered[0]).toBe(attempts[0]?.headers["webhook-id"]);
  expect(delivered[1]).not.toBe(delivered[0]);
  expect(await (await api.request(path)).json()).toMatchObject({ enabled: true, failure_count: 0 });
});

test("reclaims a crashed lease and rechecks grants before delivery", async ({ api }) => {
  const key = await api.run(
    api.keys.create({
      inbox_id: inboxId,
      permissions: { webhook_create: true, webhook_read: true, message_read: true },
      send_policy: "approval",
    }),
  );
  const created = await hook(
    api,
    { url: "https://receiver.example.test/", event_types: ["message.received"] },
    key.api_key,
  );
  await api.run(api.mailbox.insertMessage(message()));
  const sent: string[] = [];
  let requestSignal: AbortSignal | undefined;
  let observed: () => void = () => {};
  const attempted = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const runner = await api.run(
    processWebhooks(async (input) => {
      sent.push(input.headers["webhook-id"] ?? "");
      requestSignal = input.signal;
      observed();
      return new Promise<number>(() => {});
    }).pipe(Effect.provideService(Store, api.store), Effect.forkScoped),
  );
  await bounded(attempted);
  await api.run(Fiber.interrupt(runner));
  expect(requestSignal?.aborted).toBe(true);
  const success = async (input: WebhookRequest) => {
    sent.push(input.headers["webhook-id"] ?? "");
    return 204;
  };
  expect(await dispatch(api, success)).toBe(0);
  api.advance(WEBHOOK_LEASE_MS);
  expect(await dispatch(api, success)).toBe(1);
  expect(sent[1]).toBe(sent[0]);
  await api.run(api.mailbox.insertMessage(message(inboxId, "no-read")));
  await api.run(
    api.keys.update(key.api_key_id, { permissions: { webhook_create: true, webhook_read: true } }),
  );
  expect(await dispatch(api, success)).toBe(0);
  await api.run(api.keys.delete(key.api_key_id));
  expect(await dispatch(api, success)).toBe(0);
  expect(await (await api.request(`/v0/webhooks/${created.webhook_id}`)).json()).toMatchObject({
    enabled: false,
    disabled_reason: "credential_revoked",
  });
});

test("events enforce resource permissions, hidden labels, inbox filters and owner-only domain visibility", async ({
  api,
}) => {
  const key = await api.run(
    api.keys.create({
      inbox_id: inboxId,
      permissions: { message_read: true, webhook_create: true },
      send_policy: "read_only",
    }),
  );
  const principal = await api.run(api.keys.authenticate(key.api_key));
  if (!principal) throw new Error("Expected principal");
  const created = await hook(
    api,
    {
      url: "https://receiver.example.test/",
      event_types: [
        "message.received",
        "message.received.spam",
        "draft.created",
        "domain.verified",
      ],
    },
    key.api_key,
  );
  await api.run(
    api.store.use((db) =>
      db
        .transaction(() =>
          appendEvent(
            db,
            {
              type: "event",
              event_type: "domain.verified",
              event_id: "synthetic-domain",
              domain: {
                domain_id: "synthetic",
                domain: "agents.example.test",
                feedback_enabled: true,
                subdomains_enabled: true,
                tracking_enabled: false,
                status: "VERIFIED",
                records: [],
                created_at: "2026-10-10T12:00:00Z",
                updated_at: "2026-10-10T12:00:00Z",
              },
            },
            Date.parse("2026-10-10T12:00:00Z"),
          ),
        )
        .immediate(),
    ),
  );
  await api.run(api.mailbox.insertMessage(message(otherId, "other")));
  await api.run(api.mailbox.insertMessage(message(inboxId, "hidden", ["spam"])));
  await api.run(api.drafts.create(inboxId, {}, "owner", false));
  await api.run(api.mailbox.insertMessage(message(inboxId, "visible")));
  const delivered: Event[] = [];
  await dispatch(api, async (input) => {
    delivered.push(Schema.decodeUnknownSync(Event)(JSON.parse(input.body)));
    return 204;
  });
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({
    message: { inbox_id: inboxId, message_id: "<visible@example.test>" },
  });
  const log = await events(api);
  expect(
    log
      .filter((row) => eventVisible(row, principal))
      .every((row) => row.inbox_id === inboxId && row.event_type === "message.received"),
  ).toBe(true);
  expect(log.filter((row) => eventVisible(row, principal, { inbox_ids: [otherId] }))).toEqual([]);
  expect(
    Schema.decodeUnknownSync(Webhook)(
      await (await api.request(`/v0/webhooks/${created.webhook_id}`)).json(),
    ).secret,
  ).toBeUndefined();
});

test("SSRF guard rejects credentials, private DNS, reserved IPv4/IPv6 and rebinding with pinned resolution", async () => {
  for (const target of [
    "http://example.com/",
    "https://127.0.0.1/",
    "https://10.0.0.1/",
    "https://[::1]/",
    "https://user:pass@example.com/",
    "https://example.com/#fragment",
    "http://localhost.example.com/",
  ])
    expect(() =>
      webhookUrl(target, {
        kind: "agent",
        api_key_id: "synthetic",
        grant: { permissions: {}, send_policy: "read_only" },
      }),
    ).toThrow();
  for (const address of [
    "0.0.0.0",
    "127.0.0.1",
    "100.64.0.1",
    "172.31.0.1",
    "169.254.169.254",
    "192.168.0.1",
    "198.18.1.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:8.8.8.8",
    "2001:db8::1",
    "2002:7f00:1::",
  ])
    expect(publicAddress(address), address).toBe(false);
  expect(publicAddress("8.8.8.8")).toBe(true);
  expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  await expect(
    checkedTarget("https://receiver.example.test", { kind: "owner" }, async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]),
  ).rejects.toMatchObject({ code: "validation_error" });
  const target = await checkedTarget(
    "https://receiver.example.test",
    { kind: "owner" },
    async () => [{ address: "8.8.8.8", family: 4 }],
  );
  expect(target.address).toEqual({ address: "8.8.8.8", family: 4 });
  const local = await checkedTarget("http://localhost:1234/", { kind: "owner" }, async () => {
    throw new Error("Local tests must not consult DNS");
  });
  expect(local.address.address).toBe("127.0.0.1");
});

test("WebSocket authenticates, filters scope, replays from a durable cursor, heartbeats and closes on revocation", async ({
  api,
}) => {
  expect(await rejectedHandshake(api, {})).toBe(401);
  const forbidden = await api.run(
    api.keys.create({ permissions: { webhook_read: true }, send_policy: "direct" }),
  );
  expect(await rejectedHandshake(api, { authorization: `Bearer ${forbidden.api_key}` })).toBe(403);
  expect(
    await rejectedHandshake(api, {
      authorization: `Bearer ${api.token}`,
      origin: "http://foreign.example.test",
    }),
  ).toBe(403);
  const key = await api.run(
    api.keys.create({
      inbox_ids: [inboxId],
      permissions: { message_read: true },
      send_policy: "read_only",
    }),
  );
  const ws = await client(api, { headers: { authorization: `Bearer ${key.api_key}` } });
  try {
    ws.subscribe();
    expect(await ws.next()).toMatchObject({ type: "subscribed" });
    await api.run(api.mailbox.insertMessage(message(otherId, "other")));
    await api.run(api.mailbox.insertMessage(message(inboxId, "hidden", ["blocked"])));
    await api.run(api.drafts.create(inboxId, {}, "owner", false));
    await api.run(api.mailbox.insertMessage(message(inboxId, "visible")));
    const first = await ws.next();
    expect(first).toMatchObject({
      event_type: "message.received",
      message: { message_id: "<visible@example.test>" },
    });
    if (first.type !== "event") throw new Error("Expected event");
    await ws.close();
    await api.run(api.mailbox.insertMessage(message(inboxId, "offline")));
    const resumed = await client(
      api,
      { headers: { authorization: `Bearer ${key.api_key}` } },
      first.event_id,
    );
    try {
      resumed.subscribe();
      expect(await resumed.next()).toMatchObject({ type: "subscribed" });
      expect(await resumed.next()).toMatchObject({
        message: { message_id: "<offline@example.test>" },
      });
      api.advance(20_001);
      expect(await resumed.next()).toMatchObject({ type: "ping" });
      resumed.socket.send(JSON.stringify({ type: "pong" }));
      await api.run(api.keys.delete(key.api_key_id));
      expect((await bounded(resumed.closed)).code).toBe(1008);
    } finally {
      if (resumed.socket.readyState !== 3) await resumed.close();
    }
  } finally {
    if (ws.socket.readyState !== 3) await ws.close();
  }
});

test("owner session WebSocket requires same-origin CSRF handshake and closes when the session is revoked", async ({
  api,
}) => {
  const response = await api.request("/v0/owner/setup", {
    token: null,
    method: "POST",
    body: { password: "synthetic owner password", code: api.setupCode },
  });
  const session = Schema.decodeUnknownSync(OwnerSessionResponse)(await response.json());
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Expected cookie");
  expect(await rejectedHandshake(api, { cookie, origin: api.url })).toBe(403);
  expect(
    await rejectedHandshake(api, {
      cookie,
      "sec-websocket-protocol": `inbot.events, csrf.${session.csrf_token}`,
    }),
  ).toBe(403);
  const ws = await client(api, {
    headers: {
      cookie,
      origin: api.url,
      "sec-websocket-protocol": `inbot.events, csrf.${session.csrf_token}`,
    },
  });
  try {
    ws.subscribe({ event_types: ["draft.created"] });
    expect(await ws.next()).toMatchObject({ type: "subscribed" });
    await api.run(api.drafts.create(otherId, {}, "owner", false));
    expect(await ws.next()).toMatchObject({
      event_type: "draft.created",
      draft: { inbox_id: otherId },
    });
    await api.request("/v0/owner/logout", {
      token: null,
      method: "POST",
      headers: { cookie, "x-inbot-csrf": session.csrf_token },
    });
    expect((await bounded(ws.closed)).code).toBe(1008);
  } finally {
    if (ws.socket.readyState !== 3) await ws.close();
  }
});

test("pending events cannot reveal messages hidden or deleted after their original transaction", async ({
  api,
}) => {
  const key = await api.run(
    api.keys.create({
      inbox_id: inboxId,
      permissions: { message_read: true, webhook_create: true },
      send_policy: "read_only",
    }),
  );
  await hook(api, undefined, key.api_key);
  const cursor = (await events(api)).at(-1)?.event_id;
  if (!cursor) throw new Error("Expected cursor");
  await api.run(api.mailbox.insertMessage(message(inboxId, "later-hidden")));
  await api.run(
    api.mailbox.updateMessage(inboxId, "<later-hidden@example.test>", { add_labels: "spam" }),
  );
  await api.run(api.mailbox.insertMessage(message(inboxId, "later-deleted")));
  await api.run(api.mailbox.deleteMessage(inboxId, "<later-deleted@example.test>"));
  await api.run(api.mailbox.insertMessage(message(inboxId, "barrier")));
  const sent: Event[] = [];
  await dispatch(api, async (input) => {
    sent.push(Schema.decodeUnknownSync(Event)(JSON.parse(input.body)));
    return 204;
  });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ message: { message_id: "<barrier@example.test>" } });
  const ws = await client(api, { headers: { authorization: `Bearer ${key.api_key}` } }, cursor);
  try {
    ws.subscribe();
    expect(await ws.next()).toMatchObject({ type: "subscribed" });
    expect(await ws.next()).toMatchObject({ message: { message_id: "<barrier@example.test>" } });
  } finally {
    await ws.close();
  }
});

test("WebSocket rejects unknown and repeated subscriptions and closes expired credentials", async ({
  api,
}) => {
  const ws = await client(api);
  ws.subscribe({ last_event_id: "unknown-cursor" });
  expect((await bounded(ws.closed)).code).toBe(1008);
  const repeated = await client(api);
  repeated.subscribe();
  expect(await repeated.next()).toMatchObject({ type: "subscribed" });
  repeated.subscribe();
  expect((await bounded(repeated.closed)).code).toBe(1008);
  const key = await api.run(
    api.keys.create({
      permissions: { message_read: true },
      send_policy: "read_only",
      expires_at: "2026-10-10T12:00:01Z",
    }),
  );
  const expiring = await client(api, { headers: { authorization: `Bearer ${key.api_key}` } });
  expiring.subscribe();
  expect(await expiring.next()).toMatchObject({ type: "subscribed" });
  api.advance(1000);
  expect((await bounded(expiring.closed)).code).toBe(1008);
});

test("outbox acceptance and event commit are atomic and an interrupted commit reports unknown outcome without resending", async ({
  api,
}) => {
  const queued = await api.run(
    api.outbox.enqueue(inboxId, {
      kind: "send",
      request: { to: ["recipient@example.test"], text: "Synthetic outbound" },
    }),
  );
  const before = await events(api);
  await api.run(
    api.store.use((db) =>
      db.exec(
        "CREATE TRIGGER reject_sent_event BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'synthetic'); END",
      ),
    ),
  );
  await expect(api.run(api.outbox.processDue())).rejects.toMatchObject({ code: "database_failed" });
  expect(api.sent).toHaveLength(1);
  expect((await api.run(api.outbox.get(inboxId, queued.message_id))).state).toBe("sending");
  expect(await events(api)).toEqual(before);
  await api.run(api.store.use((db) => db.exec("DROP TRIGGER reject_sent_event")));
  api.advance(SENDING_LEASE_MS);
  await api.run(api.outbox.processDue());
  expect(api.sent).toHaveLength(1);
  expect((await api.run(api.outbox.get(inboxId, queued.message_id))).last_error_code).toBe(
    "unknown_outcome",
  );
  expect((await events(api)).at(-1)?.payload).toMatchObject({
    event_type: "message.failed",
    failure: { message_id: queued.message_id, reason: "unknown_outcome" },
  });
});

test("agents cannot create loopback receivers or credential headers, including through header updates", async ({
  api,
}) => {
  const key = await api.run(
    api.keys.create({
      inbox_id: inboxId,
      permissions: {
        webhook_create: true,
        webhook_read: true,
        webhook_update: true,
        message_read: true,
      },
      send_policy: "read_only",
    }),
  );
  for (const url of [
    "http://127.0.0.1:80/",
    "http://localhost:32123/",
    "https://127.0.0.1/",
    "http://receiver.example.test/",
  ]) {
    const response = await api.request("/v0/webhooks", {
      token: key.api_key,
      method: "POST",
      body: { url, event_types: ["message.received"] },
    });
    expect(response.status, url).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation_error" });
  }
  const created = await hook(api, undefined, key.api_key);
  for (const token of [key.api_key, api.token]) {
    for (const name of [
      "Authorization",
      "COOKIE",
      "Cookie2",
      "Proxy-Authorization",
      "X-Api-Key",
      "X-Auth-Token",
      "X-Access-Token",
      "X-Secret",
    ]) {
      const headers = { [name]: "synthetic credential" };
      expect(
        (
          await api.request("/v0/webhooks", {
            token,
            method: "POST",
            body: {
              url: "https://receiver.example.test/",
              event_types: ["message.received"],
              headers,
            },
          })
        ).status,
        name,
      ).toBe(400);
      expect(
        (
          await api.request(`/v0/webhooks/${created.webhook_id}/headers`, {
            token,
            method: "PATCH",
            body: { headers },
          })
        ).status,
        name,
      ).toBe(400);
    }
  }
  const principal = await api.run(api.keys.authenticate(key.api_key));
  if (!principal) throw new Error("Expected an agent principal");
  await expect(
    webhookSender()({
      principal,
      url: "http://localhost:32123/",
      body: "{}",
      headers: {},
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "validation_error" });
});

test.for(["loopback", "credentials"])(
  "delivery rechecks the creator and rejects legacy agent %s configuration",
  async (kind, { api }) => {
    const key = await api.run(
      api.keys.create({
        inbox_id: inboxId,
        permissions: { webhook_create: true, webhook_read: true, message_read: true },
        send_policy: "read_only",
      }),
    );
    const created = await hook(api, undefined, key.api_key);
    await api.run(
      api.store.use((db) => {
        if (kind === "loopback")
          db.prepare(
            "UPDATE webhooks SET url = 'http://localhost:32123/' WHERE webhook_id = ?",
          ).run(created.webhook_id);
        else
          db.prepare("UPDATE webhooks SET headers = ? WHERE webhook_id = ?").run(
            JSON.stringify({ authorization: "synthetic" }),
            created.webhook_id,
          );
      }),
    );
    await api.run(api.mailbox.insertMessage(message()));
    let calls = 0;
    expect(
      await dispatch(api, async () => {
        calls++;
        return 204;
      }),
    ).toBe(0);
    expect(calls).toBe(0);
    expect(
      await (
        await api.request(`/v0/webhooks/${created.webhook_id}`, { token: key.api_key })
      ).json(),
    ).toMatchObject({
      enabled: false,
      disabled_reason: "invalid_target",
      last_error_code: "delivery_failed",
    });
  },
);

test("agent failure metadata hides HTTP responses and connection failures on every CRUD response", async ({
  api,
}) => {
  const key = await api.run(
    api.keys.create({
      inbox_id: inboxId,
      permissions: {
        webhook_create: true,
        webhook_read: true,
        webhook_update: true,
        message_read: true,
      },
      send_policy: "read_only",
    }),
  );
  const created = await hook(api, undefined, key.api_key);
  const path = `/v0/webhooks/${created.webhook_id}`;
  await api.run(api.mailbox.insertMessage(message()));
  for (const status of [401, 404, 503, undefined]) {
    await api.request(path, { token: key.api_key, method: "PATCH", body: { enabled: true } });
    await dispatch(api, async () => {
      if (status === undefined) throw new Error("ECONNREFUSED synthetic");
      return status;
    });
    expect(await (await api.request(path, { token: key.api_key })).json()).toMatchObject({
      last_error_code: "delivery_failed",
    });
    expect(await (await api.request("/v0/webhooks", { token: key.api_key })).json()).toMatchObject({
      webhooks: [{ last_error_code: "delivery_failed" }],
    });
    expect(
      await (
        await api.request(path, { token: key.api_key, method: "PATCH", body: { enabled: false } })
      ).json(),
    ).toMatchObject({ last_error_code: "delivery_failed" });
  }
  await api.run(
    api.store.use((db) =>
      db
        .prepare("UPDATE webhooks SET last_error_code = 'http_401' WHERE webhook_id = ?")
        .run(created.webhook_id),
    ),
  );
  expect(await (await api.request(path, { token: key.api_key })).json()).toMatchObject({
    last_error_code: "delivery_failed",
  });
});

test.for(["message", "thread", "inbox"])(
  "%s deletion redacts received content and thread snapshots before owner replay and delivery",
  async (kind, { api }) => {
    const created = await hook(api);
    const stored = await api.run(
      api.mailbox.insertMessage({
        ...message(inboxId, "redacted"),
        subject: "private subject",
        text: "private body",
        html: "<p>private html</p>",
        extracted_text: "private extracted text",
        extracted_html: "private extracted html",
        headers: { "x-private": "private header" },
      }),
    );
    await api.run(
      api.mailbox.insertMessage({ ...message(inboxId, "reply"), in_reply_to: stored.message_id }),
    );
    const before = (await events(api)).find(
      (row) =>
        row.payload.event_type === "message.received" &&
        row.payload.message.message_id === stored.message_id,
    );
    if (!before) throw new Error("Expected received event");
    expect(before.payload).toMatchObject({
      message: { text: "private body" },
      thread: { subject: "private subject" },
    });
    if (kind === "message") await api.run(api.mailbox.deleteMessage(inboxId, stored.message_id));
    else if (kind === "thread") await api.run(api.mailbox.deleteThread(inboxId, stored.thread_id));
    else await api.run(api.mailbox.deleteInbox(inboxId));
    const rows = await events(api);
    const redacted = rows.find((row) => row.event_id === before.event_id);
    const streaming = await api.run(
      EventLog.pipe(Effect.provide(EventLog.Live), Effect.provideService(Store, api.store)),
    );
    expect(await api.run(streaming.readable(before.sequence, { kind: "owner" }, {}))).toEqual(
      redacted?.payload,
    );
    expect(redacted?.payload).toMatchObject({
      message: { message_id: stored.message_id },
      thread: { thread_id: stored.thread_id },
    });
    for (const row of rows) {
      if (
        row.payload.event_type.startsWith("message.received") &&
        "message" in row.payload &&
        row.payload.message.thread_id === stored.thread_id
      ) {
        expect(row.payload.thread).not.toHaveProperty("subject");
        expect(row.payload.thread).not.toHaveProperty("preview");
        expect(row.payload.thread).not.toHaveProperty("attachments");
      }
    }
    for (const field of [
      "text",
      "html",
      "extracted_text",
      "extracted_html",
      "preview",
      "subject",
      "headers",
      "attachments",
    ])
      expect(redacted?.payload).not.toHaveProperty(`message.${field}`);
    const sent: WebhookRequest[] = [];
    await dispatch(api, async (input) => {
      sent.push(input);
      return 204;
    });
    const delivered = sent.find((input) => input.headers["webhook-id"] === before.event_id);
    if (!delivered) throw new Error("Expected a redacted owner delivery");
    expect(delivered.body).not.toContain("private");
    expect(
      verifyWebhook(
        requiredSecret(created),
        before.event_id,
        delivered.headers["webhook-timestamp"] ?? "",
        delivered.body,
        delivered.headers["webhook-signature"] ?? "",
        Date.parse("2026-10-10T12:00:00Z"),
      ),
    ).toBe(true);
  },
);

test("redaction failure rolls back message deletion and all snapshots", async ({ api }) => {
  const stored = await api.run(api.mailbox.insertMessage(message()));
  const before = await events(api);
  await api.run(
    api.store.use((db) =>
      db.exec(
        "CREATE TRIGGER fail_redaction BEFORE UPDATE ON event_log BEGIN SELECT RAISE(ABORT, 'synthetic'); END",
      ),
    ),
  );
  await expect(
    api.run(api.mailbox.deleteMessage(inboxId, stored.message_id)),
  ).rejects.toMatchObject({ code: "database_failed" });
  expect(await events(api)).toEqual(before);
  expect(await api.run(api.mailbox.getMessage(inboxId, stored.message_id))).toMatchObject({
    text: "Synthetic content",
  });
  await api.run(api.store.use((db) => db.exec("DROP TRIGGER fail_redaction")));
});

test("retention prunes old terminal rows while preserving paused deliveries and unfanned events", async ({
  api,
}) => {
  await api.run(api.mailbox.insertMessage(message(inboxId, "unneeded")));
  const created = await hook(api);
  await api.run(api.mailbox.insertMessage(message(inboxId, "pending")));
  await dispatch(api, async () => 503);
  await api.request(`/v0/webhooks/${created.webhook_id}`, {
    method: "PATCH",
    body: { enabled: false },
  });
  await api.run(api.mailbox.insertMessage(message(inboxId, "unfanned")));
  const before = await events(api);
  api.advance(EVENT_RETENTION_MS + 1);
  expect(
    await api.run(
      api.store.use((db) =>
        pruneEvents(db, Date.parse("2026-10-10T12:00:00Z") + EVENT_RETENTION_MS + 1),
      ),
    ),
  ).toBe(before.length - 2);
  expect((await events(api)).map((row) => row.payload)).toMatchObject([
    { message: { message_id: "<pending@example.test>" } },
    { message: { message_id: "<unfanned@example.test>" } },
  ]);
  await api.request(`/v0/webhooks/${created.webhook_id}`, {
    method: "PATCH",
    body: { enabled: true },
  });
  expect(await dispatch(api, async () => 204)).toBe(1);
  expect(await dispatch(api, async () => 204)).toBe(1);
  await dispatch(api, async () => 204);
  expect(await events(api)).toEqual([]);
  expect(
    await api.run(api.store.use((db) => db.prepare("SELECT * FROM webhook_deliveries").all())),
  ).toEqual([]);
});

test("dispatcher quarantines corrupt event, webhook and delivery rows without blocking healthy receivers", async ({
  api,
}) => {
  const bad = await hook(api);
  const good = await hook(api);
  await api.run(api.mailbox.insertMessage(message(inboxId, "poison")));
  const poisoned = (await events(api)).at(-1);
  if (!poisoned) throw new Error("Expected event");
  await api.run(
    api.store.use((db) =>
      db
        .transaction(() => {
          db.prepare("UPDATE webhooks SET headers = 'bad json' WHERE webhook_id = ?").run(
            bad.webhook_id,
          );
          db.prepare("UPDATE event_log SET labels = 'bad json' WHERE sequence = ?").run(
            poisoned.sequence,
          );
          db.prepare(
            "INSERT INTO webhook_deliveries (webhook_id, sequence, next_attempt_at) VALUES (?, ?, 0)",
          ).run(good.webhook_id, poisoned.sequence);
        })
        .immediate(),
    ),
  );
  await api.run(api.mailbox.insertMessage(message(inboxId, "healthy")));
  const sent: string[] = [];
  expect(
    await dispatch(api, async (input) => {
      sent.push(input.body);
      return 204;
    }),
  ).toBe(1);
  expect(sent[0]).toContain("<healthy@example.test>");
  expect(await (await api.request(`/v0/webhooks/${bad.webhook_id}`)).json()).toMatchObject({
    enabled: false,
    disabled_reason: "invalid_record",
  });
  expect(
    await api.run(
      api.store.use((db) =>
        db
          .prepare("SELECT state FROM webhook_deliveries WHERE sequence = ?")
          .all(poisoned.sequence),
      ),
    ),
  ).toEqual([{ state: "failed" }]);
  expect((await events(api)).some((row) => row.sequence === poisoned.sequence)).toBe(false);
  await api.run(api.mailbox.insertMessage(message(inboxId, "bad-delivery")));
  await dispatch(api, async () => 503);
  await api.run(
    api.store.use((db) =>
      db
        .prepare(
          "UPDATE webhook_deliveries SET attempts = 'bad', next_attempt_at = 0 WHERE state = 'pending'",
        )
        .run(),
    ),
  );
  expect(
    await dispatch(api, async () => {
      throw new Error("Poison must not be sent");
    }),
  ).toBe(0);
  await api.run(api.mailbox.insertMessage(message(inboxId, "after-poison")));
  expect(await dispatch(api, async () => 204)).toBe(1);
});

test("dispatcher loop survives a transient database failure and delivers on the next tick", async ({
  api,
}) => {
  await hook(api);
  await api.run(api.mailbox.insertMessage(message()));
  const clock = await api.run(TestClock.make());
  await api.run(clock.setTime(Date.parse("2026-10-10T12:00:00Z")));
  const sleeps = await api.run(Queue.unbounded<number>());
  const observed: Clock.Clock = {
    ...clock,
    sleep: (duration) =>
      Effect.andThen(
        Duration.toMillis(duration) === 1000 ? Queue.offer(sleeps, 1000) : Effect.void,
        clock.sleep(duration),
      ),
  };
  let failed = false;
  let delivered = 0;
  const runner = await api.run(
    startWebhookLoop(async () => {
      delivered++;
      return 204;
    }).pipe(
      Effect.provideService(Store, {
        use: (operation) => {
          if (!failed) {
            failed = true;
            return Effect.fail(new DatabaseError({ operation: "query" }));
          }
          return api.store.use(operation);
        },
      }),
      Effect.provideService(Clock.Clock, observed),
    ),
  );
  try {
    expect(await api.run(Queue.take(sleeps).pipe(Effect.timeout("3 seconds")))).toBe(1000);
    expect(delivered).toBe(0);
    await api.run(clock.adjust("1 second"));
    expect(await api.run(Queue.take(sleeps).pipe(Effect.timeout("3 seconds")))).toBe(1000);
    expect(delivered).toBe(1);
    expect(runner.pollUnsafe()).toBeUndefined();
  } finally {
    await api.run(Fiber.interrupt(runner));
  }
});

test("WebSocket caps queued bytes before sending another frame and closes slow consumers with 1013", async () => {
  const sent: (string | Uint8Array | Socket.CloseEvent)[] = [];
  let buffered = 0;
  const writer: Socket.Writer = {
    write: (data) =>
      Effect.sync(() => {
        sent.push(data);
        if (typeof data === "string") buffered += Buffer.byteLength(data) + 14;
      }),
    writeAll: () => Effect.die("Unexpected batch write"),
  };
  const write = boundedSocketWriter(writer, () => buffered);
  expect(await Effect.runPromise(write("é".repeat(100_000)))).toBe(true);
  expect(
    await Effect.runPromise(write("x".repeat(WEBSOCKET_MAX_BUFFER_BYTES - buffered - 14))),
  ).toBe(true);
  expect(await Effect.runPromise(write("next"))).toBe(false);
  expect(buffered).toBe(WEBSOCKET_MAX_BUFFER_BYTES);
  expect(sent.at(-1)).toMatchObject({ code: 1013, reason: "Client too slow or event too large" });
});

test("WebSocket closes oversized event streams at the real transport boundary", async ({ api }) => {
  const ws = await client(api);
  try {
    ws.subscribe();
    expect(await ws.next()).toMatchObject({ type: "subscribed" });
    await api.run(
      api.mailbox.insertMessage({ ...message(), text: "x".repeat(WEBSOCKET_MAX_BUFFER_BYTES) }),
    );
    expect((await bounded(ws.closed)).code).toBe(1013);
  } finally {
    if (ws.socket.readyState !== 3) await ws.close();
  }
});

test("blocked messages inserted through the shared mailbox path emit the blocked received contract", async ({
  api,
}) => {
  await api.run(api.mailbox.insertMessage(message(inboxId, "blocked", ["blocked"])));
  expect((await events(api)).at(-1)?.payload).toMatchObject({
    event_type: "message.received.blocked",
    message: { labels: ["blocked"] },
  });
});

test("owner HTTP hostnames must resolve exclusively to IPv4 loopback on every attempt", async () => {
  for (const addresses of [
    [{ address: "8.8.8.8", family: 4 }],
    [
      { address: "127.0.0.1", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ],
    [{ address: "::1", family: 6 }],
  ]) {
    await expect(
      checkedTarget("http://receiver.example.test/", { kind: "owner" }, async () => addresses),
    ).rejects.toMatchObject({ code: "validation_error" });
  }
  for (const url of ["http://10.0.0.1/", "http://8.8.8.8/", "http://[::1]/"])
    expect(() => webhookUrl(url, { kind: "owner" })).toThrow();
});

test("retention bounds each prune and expired replay cursors fail explicitly", async ({ api }) => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  await api.run(
    api.store.use((db) =>
      db
        .transaction(() => {
          for (let index = 0; index < 501; index++)
            appendEvent(
              db,
              {
                type: "event",
                event_type: "draft.created",
                event_id: `retention-${index}`,
                draft: {
                  inbox_id: inboxId,
                  draft_id: `draft-${index}`,
                  timestamp: new Date(now).toISOString(),
                },
              },
              now - EVENT_RETENTION_MS - 1,
            );
        })
        .immediate(),
    ),
  );
  expect(await api.run(api.store.use((db) => pruneEvents(db, now)))).toBe(500);
  expect((await events(api)).filter((row) => row.event_id.startsWith("retention-"))).toHaveLength(
    1,
  );
  const streaming = await api.run(
    EventLog.pipe(Effect.provide(EventLog.Live), Effect.provideService(Store, api.store)),
  );
  await expect(api.run(streaming.cursor("retention-0"))).rejects.toMatchObject({
    code: "validation_error",
  });
  expect(await api.run(api.store.use((db) => pruneEvents(db, now)))).toBe(1);
});
