import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test as base } from "vitest";
import { Mailbox } from "../mailbox/mailbox.js";
import { ingestInbound } from "../inbound/ingest.js";
import { InboundBuffer, BufferError } from "../inbound/cloudflare.js";
import { processInbound, reconcileInbound } from "../inbound/puller.js";
import { fixture, inbox, key, receivedAt } from "../inbound/test-fixture.js";
import { makeLists } from "./lists.js";
import { readEvents } from "../events/log.js";

const test = base.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-list-inbound-test-"));
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
const records = (api: Awaited<ReturnType<typeof fixture>>) =>
  api.run(
    api.store.use((db) =>
      db.prepare("SELECT inbox_id, reason_code, received_at FROM inbound_list_rejections").all(),
    ),
  );

test("records a blocked sender durably before deleting ciphertext, then replays after delete failure", async ({
  api,
}) => {
  const lists = makeLists(api.store);
  await api.run(lists.create(undefined, "receive", "block", { entry: "EXAMPLE.TEST" }));
  await api.put(1);
  const failing = {
    ...api.buffer.service,
    deleteObject: () => Effect.fail(new BufferError({ code: "buffer_unavailable" })),
  };
  expect(
    (await api.process(processInbound().pipe(Effect.provideService(InboundBuffer, failing))))
      .retried,
  ).toBe(1);
  expect(await records(api)).toEqual([
    { inbox_id: inbox, reason_code: "blocked_sender", received_at: receivedAt },
  ]);
  expect(await api.run(api.state.get(key(1)))).toMatchObject({
    state: "committed",
    reason_code: "message_rejected",
  });
  expect(api.buffer.objects.size).toBe(1);
  expect(api.buffer.acks).toHaveLength(0);
  await api.run(lists.delete(undefined, "receive", "block", "example.test"));
  api.time.now += 5000;
  expect((await api.process(processInbound())).processed).toBe(1);
  expect(api.buffer.objects.size).toBe(0);
  expect(api.buffer.acks).toHaveLength(1);
  expect(await records(api)).toHaveLength(1);
  expect(await api.run(api.store.use((db) => readEvents(db, 0)))).toEqual([]);
  expect(
    (
      await api.run(
        api.mailbox.listMessages(inbox, { include_blocked: true, include_unauthenticated: true }),
      )
    ).messages,
  ).toEqual([]);
});

test("keeps ciphertext and retries when writing the rejection record fails", async ({ api }) => {
  await api.run(
    makeLists(api.store).create(inbox, "receive", "block", { entry: "alice@example.test" }),
  );
  await api.run(
    api.store.use((db) =>
      db.exec(
        "CREATE TRIGGER fail_rejection BEFORE INSERT ON inbound_list_rejections BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
      ),
    ),
  );
  await api.put(1);
  expect((await api.process(processInbound())).retried).toBe(1);
  expect(api.buffer.objects.size).toBe(1);
  expect(api.buffer.acks).toHaveLength(0);
  expect(await records(api)).toEqual([]);
  await api.run(api.store.use((db) => db.exec("DROP TRIGGER fail_rejection")));
  api.time.now += 5000;
  expect((await api.process(processInbound())).processed).toBe(1);
  expect(await records(api)).toHaveLength(1);
  expect(api.buffer.objects.size).toBe(0);
});

test("reconciliation applies allow rules and preserves a durable not-allowed reason", async ({
  api,
}) => {
  await api.run(
    makeLists(api.store).create(undefined, "receive", "allow", { entry: "trusted.test" }),
  );
  await api.put(1, { pointer: false });
  api.time.now += 11 * 60 * 1000;
  expect((await api.process(reconcileInbound())).processed).toBe(1);
  expect(await records(api)).toEqual([
    { inbox_id: inbox, reason_code: "sender_not_allowed", received_at: receivedAt },
  ]);
  expect(api.buffer.objects.size).toBe(0);
});

test("evaluates envelope and header senders per recipient without discarding allowed recipients", async ({
  api,
}) => {
  const other = "other@example.test";
  await api.run(api.mailbox.createInbox({ username: "other", domain: "example.test" }));
  const lists = makeLists(api.store);
  await api.run(lists.create(inbox, "receive", "allow", { entry: "trusted.test" }));
  await api.run(lists.create(inbox, "receive", "block", { entry: "bad.test" }));
  const raw = Buffer.from(
    "Message-ID: <sender-test@example.test>\r\nFrom: Person <friend@TRUSTED.TEST>\r\nContent-Type: text/plain\r\n\r\nSynthetic body",
  );
  const input = {
    mail_from: "sender@bad.test",
    rcpt_to: [inbox, other],
    raw,
    received_at: receivedAt,
  };
  const results = await api.run(
    ingestInbound(input).pipe(Effect.provideService(Mailbox, api.mailbox)),
  );
  expect(results[0]).toEqual({
    recipient: inbox,
    status: "skipped_blocked",
    reason_code: "blocked_sender",
  });
  expect(results[1]).toMatchObject({ recipient: other, status: "stored" });
  await api.run(lists.delete(inbox, "receive", "block", "bad.test"));
  expect(
    (await api.run(ingestInbound(input).pipe(Effect.provideService(Mailbox, api.mailbox))))[0],
  ).toEqual(results[0]);
  expect(await records(api)).toHaveLength(1);
  const newRaw = Buffer.from(
    "Message-ID: <new-sender@example.test>\r\nFrom: friend@trusted.test\r\n\r\nNew synthetic body",
  );
  expect(
    (
      await api.run(
        ingestInbound({ ...input, raw: newRaw }).pipe(Effect.provideService(Mailbox, api.mailbox)),
      )
    )[0],
  ).toMatchObject({ status: "skipped_blocked", reason_code: "sender_not_allowed" });
  expect(
    (await api.run(api.mailbox.listMessages(other, { include_unauthenticated: true }))).count,
  ).toBe(2);
});
