import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect } from "effect";
import { expect, test as base } from "vitest";
import { encrypt } from "../../../../packages/envelope/src/index.js";
import { eventVisible, readEvents } from "../events/log.js";
import { BufferError, InboundBuffer } from "./cloudflare.js";
import { makeQuarantine } from "./quarantine.js";
import { processInbound, reconcileInbound } from "./puller.js";
import { config, fixture, inbox, key } from "./test-fixture.js";

const test = base.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-quarantine-"));
    const api = await fixture(home);
    try {
      await use(api);
    } finally {
      await api.close();
      await rm(home, { recursive: true, force: true });
    }
  },
});
async function corrupt(api: Awaited<ReturnType<typeof fixture>>, index = 1) {
  await api.put(index, { bytes: new Uint8Array(64).fill(42) });
  await api.process(processInbound());
  const service = makeQuarantine(api.store);
  const item = (await api.run(service.list())).items.find(
    (entry) => entry.source_kind === "buffer_object",
  );
  if (!item) throw new Error("Expected a quarantine item");
  return { service, item };
}

test("retries through ingestion, keeps permanent failures with the new reason and releases only after cleanup", async ({
  api,
}) => {
  const { service, item } = await corrupt(api);
  const recipient = await api.run(api.inbound.getRecipient());
  if (!recipient) throw new Error("Expected recipient");
  api.buffer.putObject(
    key(1),
    await encrypt(recipient, Buffer.from("invalid frame")),
    item.first_seen,
  );
  expect(await api.process(service.retry(item.quarantine_id))).toMatchObject({
    status: "quarantined",
    item: { reason_code: "invalid_inbound_frame", attempts: 2, first_seen: item.first_seen },
  });
  expect(api.buffer.objects.has(key(1))).toBe(true);
  await api.put(1, { pointer: false });
  const failing = {
    ...api.buffer.service,
    deleteObject: () => Effect.fail(new BufferError({ code: "buffer_unavailable" })),
  };
  await expect(
    api.process(
      service.retry(item.quarantine_id).pipe(Effect.provideService(InboundBuffer, failing)),
    ),
  ).rejects.toThrow();
  expect((await api.run(service.list())).items[0]?.status).toBe("release_pending");
  expect((await api.run(api.mailbox.listMessages(inbox))).messages).toHaveLength(1);
  expect(await api.process(service.retry(item.quarantine_id))).toEqual({ status: "released" });
  expect((await api.run(service.list())).count).toBe(0);
  expect(api.buffer.objects.size).toBe(0);
  expect((await api.run(api.mailbox.listMessages(inbox))).messages).toHaveLength(1);
  const events = await api.run(api.store.use((db) => readEvents(db, 0)));
  const inbound = events.filter((row) => row.payload.event_type.startsWith("inbound."));
  expect(inbound.map((row) => row.payload.event_type)).toEqual([
    "inbound.quarantined",
    "inbound.quarantined",
    "inbound.released",
  ]);
  expect(inbound.every((row) => eventVisible(row, { kind: "owner" }))).toBe(true);
  expect(
    inbound.every(
      (row) =>
        !eventVisible(row, {
          kind: "agent",
          api_key_id: "fake",
          grant: { permissions: { message_read: true }, send_policy: "direct" },
        }),
    ),
  ).toBe(true);
});

test("deletes idempotently, preserves cleanup state on failure and never ingests a late pointer", async ({
  api,
}) => {
  const { service, item } = await corrupt(api);
  const fixed = await api.put(1, { pointer: false });
  const failing = {
    ...api.buffer.service,
    deleteObject: () => Effect.fail(new BufferError({ code: "buffer_unavailable" })),
  };
  await expect(
    api.process(
      service.delete(item.quarantine_id).pipe(Effect.provideService(InboundBuffer, failing)),
    ),
  ).rejects.toThrow();
  expect((await api.run(service.list())).items[0]?.status).toBe("delete_pending");
  await expect(api.process(service.retry(item.quarantine_id))).rejects.toThrow();
  await api.process(service.delete(item.quarantine_id));
  await api.process(service.delete(item.quarantine_id));
  api.buffer.push(config.inbound_queue_id, fixed.pointer);
  await api.process(processInbound());
  expect(api.buffer.objects.size).toBe(0);
  expect((await api.run(api.mailbox.listMessages(inbox))).messages).toHaveLength(0);
  expect((await api.run(service.list())).count).toBe(0);
});

test("reconciles committed cleanup even when ciphertext disappeared before the final record update", async ({
  api,
}) => {
  const { service } = await corrupt(api);
  await api.run(api.state.beginAction(key(1), "delete"));
  await api.run(api.buffer.service.deleteObject(key(1)));
  expect((await api.run(service.list())).count).toBe(1);
  await api.process(reconcileInbound());
  expect((await api.run(service.list())).count).toBe(0);
  expect((await api.run(api.mailbox.listMessages(inbox))).messages).toHaveLength(0);
});

test("serializes retry with the puller and reconciler without duplicate ingestion", async ({
  api,
}) => {
  const { service, item } = await corrupt(api);
  await api.put(1);
  const entered = await api.run(Deferred.make<void>());
  const resume = await api.run(Deferred.make<void>());
  let fetches = 0;
  const paused = {
    ...api.buffer.service,
    getObject: (key: string) =>
      Effect.gen(function* () {
        fetches++;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(resume);
        return yield* api.buffer.service.getObject(key);
      }),
  };
  const retry = api.process(
    service.retry(item.quarantine_id).pipe(Effect.provideService(InboundBuffer, paused)),
  );
  await api.run(Deferred.await(entered).pipe(Effect.timeout("3 seconds")));
  const pull = api.process(processInbound());
  const reconcile = api.process(reconcileInbound());
  await api.run(Deferred.succeed(resume, undefined));
  await Promise.all([retry, pull, reconcile]);
  expect(fetches).toBe(1);
  expect((await api.run(api.mailbox.listMessages(inbox))).messages).toHaveLength(1);
  expect((await api.run(service.list())).count).toBe(0);
});

test("lists legacy metadata without decrypting, paginates both sources and explicitly rejects Queue retry", async ({
  api,
}) => {
  await api.run(api.state.put(key(1), "quarantined", "invalid_pointer"));
  await api.run(api.state.quarantineMessage(config.inbound_queue_id, "invalid", "invalid_pointer"));
  const service = makeQuarantine(api.store);
  const first = await api.run(service.list({ limit: 1 }));
  if (!first.next_page_token) throw new Error("Expected next page token");
  const second = await api.run(service.list({ limit: 1, page_token: first.next_page_token }));
  expect(first.count).toBe(1);
  expect(first.items[0]?.quarantine_id).not.toBe(second.items[0]?.quarantine_id);
  expect(
    [...first.items, ...second.items].every(
      (item) => item.inbox_id === null && item.size === null && item.attempts === null,
    ),
  ).toBe(true);
  await expect(api.run(service.list({ page_token: "invalid" }))).rejects.toThrow();
  const queue = [...first.items, ...second.items].find(
    (entry) => entry.source_kind === "queue_message",
  );
  if (!queue) throw new Error("Expected Queue metadata");
  expect(await api.process(service.retry(queue.quarantine_id).pipe(Effect.result))).toMatchObject({
    failure: { code: "not_supported" },
  });
  await api.process(service.delete(queue.quarantine_id));
  await api.process(service.delete(queue.quarantine_id));
  expect((await api.run(service.list())).count).toBe(1);
});

test("waits for an in-flight retry before deleting the same object", async ({ api }) => {
  const { service, item } = await corrupt(api);
  await api.put(1, { pointer: false });
  const entered = await api.run(Deferred.make<void>());
  const resume = await api.run(Deferred.make<void>());
  const deleteStarted = await api.run(Deferred.make<void>());
  const paused = {
    ...api.buffer.service,
    getObject: (key: string) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(resume);
        return yield* api.buffer.service.getObject(key);
      }),
  };
  const retry = api.process(
    service.retry(item.quarantine_id).pipe(Effect.provideService(InboundBuffer, paused)),
  );
  await api.run(Deferred.await(entered).pipe(Effect.timeout("3 seconds")));
  const remove = api.process(
    Deferred.succeed(deleteStarted, undefined).pipe(
      Effect.andThen(service.delete(item.quarantine_id)),
    ),
  );
  await api.run(Deferred.await(deleteStarted).pipe(Effect.timeout("3 seconds")));
  await api.run(Deferred.succeed(resume, undefined));
  expect(await retry).toEqual({ status: "released" });
  await remove;
  expect(api.buffer.objects.size).toBe(0);
  expect((await api.run(api.mailbox.listMessages(inbox))).messages).toHaveLength(1);
  expect((await api.run(service.list())).count).toBe(0);
});

test("paginates tied timestamps without skipping or duplicating mixed-case stable IDs", async ({
  api,
}) => {
  for (let index = 0; index < 12; index++) {
    await api.run(
      api.state.quarantineMessage(config.inbound_queue_id, `invalid-${index}`, "invalid_pointer"),
    );
  }
  const service = makeQuarantine(api.store);
  const all = await api.run(service.list());
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const page = await api.run(service.list({ limit: 3, ...(token ? { page_token: token } : {}) }));
    ids.push(...page.items.map((item) => item.quarantine_id));
    token = page.next_page_token;
  } while (token);
  expect(ids).toEqual(all.items.map((item) => item.quarantine_id));
  expect(new Set(ids).size).toBe(12);
});
