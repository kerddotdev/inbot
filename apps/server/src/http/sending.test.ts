import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redacted, Schema } from "effect";
import { expect, test as baseTest } from "vitest";
import { SendMessageResponse, Message } from "../../../../packages/contracts/src/messages.js";
import { ErrorResponse } from "../../../../packages/contracts/src/errors.js";
import type { SendPolicy } from "../../../../packages/contracts/src/api-keys.js";
import { fixture } from "./test-fixture.js";

const inboxId = "agent@example.test";
const parentId = "<first@example.test>";
const route = `/v0/inboxes/${inboxId}/messages`;
const request = { to: "recipient@example.test", subject: "Synthetic mail", text: "Hello" };
const test = baseTest.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-send-test-"));
    const api = await fixture(home);
    try {
      await use(api);
    } finally {
      await api.close();
      await rm(home, { recursive: true, force: true });
    }
  },
});

async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const value = Schema.decodeUnknownSync(ErrorResponse)(await response.json());
  expect(value.code).toBe(code);
  return value;
}

test("persists transport settings only in encrypted Store and supports replacement and clearing", async ({
  api,
}) => {
  expect(await api.run(api.transport.get())).toBeUndefined();
  const secret = "synthetic-cloudflare-token-private-01";
  await api.run(api.transport.set({ account_id: "account", api_token: secret }));
  const settings = await api.run(api.transport.get());
  expect(settings?.account_id).toBe("account");
  expect(settings === undefined ? undefined : Redacted.value(settings.api_token)).toBe(secret);
  expect(JSON.stringify(settings)).not.toContain(secret);
  for (const file of await readdir(api.home))
    expect((await readFile(join(api.home, file))).includes(Buffer.from(secret))).toBe(false);
  await api.run(api.transport.set({ account_id: "replacement", api_token: "replacement-token" }));
  expect((await api.run(api.transport.get()))?.account_id).toBe("replacement");
  await api.run(api.transport.clear());
  expect(await api.run(api.transport.get())).toBeUndefined();
});

test("queues via REST, replays and rejects conflicting idempotency keys, then records fake acceptance", async ({
  api,
}) => {
  await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
  const options = { method: "POST", body: request, headers: { "idempotency-key": "rest-send-1" } };
  const response = await api.request(`${route}/send`, options);
  expect(response.status).toBe(200);
  const sent = Schema.decodeUnknownSync(SendMessageResponse)(await response.json());
  expect((await api.run(api.outbox.get(inboxId, sent.message_id))).state).toBe("queued");
  expect(api.sent).toHaveLength(0);
  const replay = Schema.decodeUnknownSync(SendMessageResponse)(
    await (await api.request(`${route}/send`, options)).json(),
  );
  expect(replay).toEqual(sent);
  await error(
    await api.request(`${route}/send`, { ...options, body: { ...request, text: "Changed" } }),
    409,
    "idempotency_conflict",
  );
  expect(await api.run(api.outbox.processDue())).toBe(1);
  expect((await api.run(api.outbox.get(inboxId, sent.message_id))).state).toBe("sent");
  expect((await api.run(api.mailbox.getMessage(inboxId, sent.message_id))).labels).toContain(
    "sent",
  );
  expect(api.sent).toHaveLength(1);
  expect(
    Schema.decodeUnknownSync(SendMessageResponse)(
      await (await api.request(`${route}/send`, options)).json(),
    ),
  ).toEqual(sent);
});

test("replies and reply-all stay in the parent's thread while forwards start a new one", async ({
  api,
}) => {
  await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
  for (const kind of ["reply", "reply-all", "forward"]) {
    const response = await api.request(`${route}/${encodeURIComponent(parentId)}/${kind}`, {
      method: "POST",
      body: kind === "forward" ? { to: "forward@example.test", text: "Note" } : { text: "Reply" },
    });
    expect(response.status).toBe(200);
    const sent = Schema.decodeUnknownSync(SendMessageResponse)(await response.json());
    expect(sent.thread_id === api.threadId).toBe(kind !== "forward");
    const mail = Schema.decodeUnknownSync(Message)(
      await (await api.request(`${route}/${encodeURIComponent(sent.message_id)}`)).json(),
    );
    if (kind !== "forward") expect(mail.in_reply_to).toBe(parentId);
  }
  expect(await api.run(api.outbox.processDue())).toBe(3);
  expect(api.sent).toHaveLength(3);
});

for (const policy of ["read_only", "approval"] satisfies SendPolicy[]) {
  test(`blocks ${policy} sends and all parent-based sends before enqueueing`, async ({ api }) => {
    await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
    const key = await api.run(
      api.keys.create({
        inbox_id: inboxId,
        permissions: { message_send: true, message_reply: true, message_read: true },
        send_policy: policy,
      }),
    );
    for (const path of [
      "send",
      `${encodeURIComponent(parentId)}/reply`,
      `${encodeURIComponent(parentId)}/reply-all`,
      `${encodeURIComponent(parentId)}/forward`,
    ]) {
      const failure = await error(
        await api.request(`${route}/${path}`, {
          token: key.api_key,
          method: "POST",
          body: path === "send" || path.endsWith("/forward") ? request : { text: "Reply" },
        }),
        403,
        policy === "approval" ? "approval_required" : "missing_permission",
      );
      if (policy === "approval") expect(failure.fix).toMatch(/Ask the owner to approve draft /);
    }
    expect(await api.run(api.outbox.processDue())).toBe(0);
    expect(api.sent).toHaveLength(0);
  });
}

test("rejects missing transport and missing permission without enqueueing", async ({ api }) => {
  const failure = await error(
    await api.request(`${route}/send`, { method: "POST", body: request }),
    503,
    "service_unavailable",
  );
  expect(failure.fix).toBe("Configure the Cloudflare mail transport");
  for (const kind of ["reply", "reply-all", "forward"])
    await error(
      await api.request(`${route}/${encodeURIComponent(parentId)}/${kind}`, {
        method: "POST",
        body: kind === "forward" ? request : { text: "Reply" },
      }),
      503,
      "service_unavailable",
    );
  await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
  const key = await api.run(
    api.keys.create({ permissions: { message_read: true }, send_policy: "direct" }),
  );
  await error(
    await api.request(`${route}/send`, { token: key.api_key, method: "POST", body: request }),
    403,
    "missing_permission",
  );
  expect(await api.run(api.outbox.processDue())).toBe(0);
});

test("conceals foreign and hidden parents, requires parent read permission and maps composition errors", async ({
  api,
}) => {
  await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
  const key = await api.run(
    api.keys.create({
      inbox_id: inboxId,
      permissions: { message_send: true, message_reply: true },
      send_policy: "direct",
    }),
  );
  await error(
    await api.request(`${route}/${encodeURIComponent(parentId)}/reply`, {
      token: key.api_key,
      method: "POST",
      body: { text: "Reply" },
    }),
    403,
    "missing_permission",
  );
  await api.run(
    api.keys.update(key.api_key_id, {
      permissions: { message_send: true, message_reply: true, message_read: true },
    }),
  );
  await error(
    await api.request(`/v0/inboxes/other@example.test/messages/send`, {
      token: key.api_key,
      method: "POST",
      body: request,
    }),
    404,
    "not_found",
  );
  await api.run(api.mailbox.updateMessage(inboxId, parentId, { add_labels: "spam" }));
  await error(
    await api.request(`${route}/${encodeURIComponent(parentId)}/forward`, {
      token: key.api_key,
      method: "POST",
      body: request,
    }),
    404,
    "not_found",
  );
  await error(
    await api.request(`${route}/send`, { method: "POST", body: { text: "No recipients" } }),
    400,
    "validation_error",
  );
  await error(
    await api.request(`${route}/send`, {
      method: "POST",
      body: { ...request, attachments: [{ url: "https://example.test/file" }] },
    }),
    501,
    "not_supported",
  );
  await error(
    await api.request(`${route}/send`, {
      method: "POST",
      body: { ...request, text: "x".repeat(6 * 1024 * 1024) },
    }),
    413,
    "payload_too_large",
  );
  expect(await api.run(api.outbox.processDue())).toBe(0);
});
