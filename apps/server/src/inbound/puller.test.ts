import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test as baseTest } from "vitest";
import { encrypt, generateIdentity } from "../../../../packages/envelope/src/index.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { processDeliveryEvents } from "../outbound/events-puller.js";
import { Outbox } from "../outbound/outbox.js";
import { DatabaseError, Store } from "../store.js";
import { BufferError, InboundBuffer } from "./cloudflare.js";
import { generateInboundIdentity } from "./config.js";
import { processInbound, reconcileInbound } from "./puller.js";
import { config, fixture, inbox, key, receivedAt } from "./test-fixture.js";

const test = baseTest.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-puller-test-"));
    const api = await fixture(home);
    try {
      await use(api);
    } finally {
      await api.close();
      await rm(home, { recursive: true, force: true });
    }
  },
});

test("stores real encrypted framed MIME, trusts Cloudflare authentication, deletes and acknowledges", async ({
  api,
}) => {
  await api.put(1);
  const report = await api.process(processInbound());
  expect(report).toEqual({ status: "ready", processed: 1, quarantined: 0, retried: 0 });
  const stored = await api.run(api.mailbox.getMessage(inbox, "<inbound@example.test>"));
  expect(stored.text).toBe("Synthetic body.\n");
  expect(stored.labels).not.toContain("unauthenticated");
  expect(api.buffer.objects.size).toBe(0);
  expect(api.buffer.acks).toHaveLength(1);
});

test("replays after a crash between store commit and object deletion without duplicate messages", async ({
  api,
}) => {
  await api.put(1);
  const failing = {
    ...api.buffer.service,
    deleteObject: () => Effect.fail(new BufferError({ code: "buffer_unavailable" })),
  };
  expect(
    (await api.process(processInbound().pipe(Effect.provideService(InboundBuffer, failing))))
      .retried,
  ).toBe(1);
  expect(api.buffer.objects.size).toBe(1);
  expect(api.buffer.acks).toHaveLength(0);
  api.time.now += 5000;
  expect((await api.process(processInbound())).processed).toBe(1);
  expect((await api.run(api.mailbox.listMessages(inbox))).messages).toHaveLength(1);
  expect(api.buffer.acks).toHaveLength(1);
});

test("acknowledges a replay whose object was deleted before the previous ack failed", async ({
  api,
}) => {
  await api.put(1);
  const failing = {
    ...api.buffer.service,
    ack: () => Effect.fail(new BufferError({ code: "buffer_unavailable" })),
  };
  expect(
    (await api.process(processInbound().pipe(Effect.provideService(InboundBuffer, failing))))
      .retried,
  ).toBe(1);
  expect(api.buffer.objects.size).toBe(0);
  api.time.now += 5000;
  expect((await api.process(processInbound())).processed).toBe(1);
  expect(api.buffer.messages.size).toBe(0);
  expect((await api.run(api.mailbox.listMessages(inbox))).messages).toHaveLength(1);
});

test("does not delete or ack on a store failure and retries the lease with backoff", async ({
  api,
}) => {
  await api.put(1);
  const mailbox = {
    ...api.mailbox,
    insertMessage: () => Effect.fail(new DatabaseError({ operation: "query" })),
  };
  expect(
    (await api.process(processInbound().pipe(Effect.provideService(Mailbox, mailbox)))).retried,
  ).toBe(1);
  expect(api.buffer.acks).toHaveLength(0);
  expect(api.buffer.objects.size).toBe(1);
  expect(api.buffer.retries[0]?.delay_seconds).toBe(5);
  expect((await api.run(api.mailbox.listMessages(inbox))).messages).toHaveLength(0);
  api.time.now += 5000;
  expect((await api.process(processInbound())).processed).toBe(1);
});

test("re-ingests idempotently when the receipt write fails after the mailbox commit", async ({
  api,
}) => {
  await api.put(1);
  let writes = 0;
  const store = {
    use: <A>(operation: Parameters<typeof api.store.use<A>>[0]) => {
      writes++;
      return writes === 3
        ? Effect.fail(new DatabaseError({ operation: "query" }))
        : api.store.use(operation);
    },
  };
  expect(
    (await api.process(processInbound().pipe(Effect.provideService(Store, store)))).retried,
  ).toBe(1);
  expect((await api.run(api.mailbox.listMessages(inbox))).messages).toHaveLength(1);
  expect(api.buffer.objects.size).toBe(1);
  api.time.now += 5000;
  expect((await api.process(processInbound())).processed).toBe(1);
  expect((await api.run(api.mailbox.listMessages(inbox))).messages).toHaveLength(1);
});

test("quarantines corrupt ciphertext, wrong identities, malformed frames and size mismatches", async ({
  api,
}) => {
  await api.put(1, { bytes: new Uint8Array(64).fill(42) });
  await api.put(2, { recipient: (await generateIdentity()).recipient });
  const recipient = await api.run(api.inbound.getRecipient());
  if (recipient === undefined) throw new Error("Expected a recipient");
  await api.put(3, { bytes: await encrypt(recipient, Buffer.from("invalid frame")) });
  const fourth = await api.put(4, { pointer: false });
  api.buffer.push(config.inbound_queue_id, {
    ...fourth.pointer,
    size: fourth.bytes.byteLength + 1,
  });
  expect((await api.process(processInbound())).quarantined).toBe(4);
  expect(api.buffer.objects.size).toBe(4);
  expect(api.buffer.acks).toHaveLength(4);
  expect(api.buffer.retries).toHaveLength(0);
  expect((await api.run(api.state.listQuarantine())).map((entry) => entry.reason_code)).toEqual([
    "invalid_ciphertext",
    "invalid_ciphertext",
    "invalid_inbound_frame",
    "size_mismatch",
  ]);
  api.buffer.push(config.inbound_queue_id, fourth.pointer);
  expect((await api.process(processInbound())).quarantined).toBe(1);
  expect((await api.run(api.state.listQuarantine()))[0]?.first_seen).toBe(receivedAt);
  expect((await api.process(processInbound())).processed).toBe(0);
});

test("records malformed pointers without storing their bodies and keeps referenced objects", async ({
  api,
}) => {
  const valid = await api.put(1, { pointer: false });
  api.buffer.push(config.inbound_queue_id, { ...valid.pointer, version: 2 });
  api.buffer.push(config.inbound_queue_id, "malformed JSON");
  expect((await api.process(processInbound())).quarantined).toBe(2);
  expect(api.buffer.objects.size).toBe(1);
  expect(await api.run(api.state.listMessageQuarantine())).toHaveLength(2);
  expect((await api.run(api.state.listQuarantine()))[0]?.key).toBe(key(1));
});

test("reconciles old orphan objects and skips recent, quarantined and locally pending objects", async ({
  api,
}) => {
  const old = "2026-10-10T11:30:00.000Z";
  await api.put(1, { pointer: false, received_at: old });
  await api.put(2, { pointer: false });
  await api.put(3, { pointer: false, received_at: old });
  await api.put(4, { pointer: false, received_at: old });
  await api.run(api.state.put(key(3), "quarantined", "invalid_ciphertext"));
  await api.run(api.state.put(key(4), "pending", null, api.time.now + 300_000));
  expect((await api.process(reconcileInbound())).processed).toBe(1);
  expect([...api.buffer.objects.keys()]).toEqual([key(2), key(3), key(4)]);
  expect((await api.run(api.mailbox.getMessage(inbox, "<inbound@example.test>"))).timestamp).toBe(
    old,
  );
  api.time.now += 300_000;
  expect((await api.process(reconcileInbound())).processed).toBe(1);
  expect(api.buffer.acks).toHaveLength(0);
});

test("does nothing while locked or unconfigured, retains identity across disable, and rejects token account mismatches", async ({
  api,
}) => {
  expect((await api.run(processInbound())).status).toBe("locked");
  expect((await api.run(reconcileInbound())).status).toBe("locked");
  const recipient = await api.run(api.inbound.getRecipient());
  await api.run(api.inbound.clear());
  expect((await api.process(processInbound())).status).toBe("no_config");
  expect((await api.process(processDeliveryEvents())).status).toBe("no_config");
  await Promise.all([
    api.process(generateInboundIdentity()),
    api.process(generateInboundIdentity()),
  ]);
  expect(await api.run(api.inbound.getRecipient())).toBe(recipient);
  await api.run(api.inbound.set(config));
  await api.run(api.transport.set({ account_id: "other-account", api_token: "fake" }));
  await expect(api.process(processInbound())).rejects.toMatchObject({ code: "invalid_config" });
  expect(api.buffer.acks).toHaveLength(0);
});

function delivery(type = "cf.email.sending.message.delivered") {
  return {
    type,
    source: { zoneId: "synthetic-zone", domain: "example.test", type: "email.sending" },
    metadata: {
      accountId: config.account_id,
      eventSubscriptionId: "synthetic-subscription",
      eventSchemaVersion: 1,
      eventTimestamp: receivedAt,
    },
    payload: {
      eventId: "synthetic-event",
      messageId: "<provider@example.test>",
      sender: inbox,
      recipient: "alice@example.test",
      subject: "Synthetic private subject",
      terminal: true,
      delivery: { status: "delivered", provider: "cloudflare", deliveryTimeMs: 791 },
    },
  };
}

test("applies real-shaped delivery events by provider alias, acknowledges unknown types and quarantines malformed events", async ({
  api,
}) => {
  const sent = await api.run(
    api.outbox.enqueue(inbox, {
      kind: "send",
      request: { to: "alice@example.test", text: "Synthetic outbound" },
    }),
  );
  await api.run(api.outbox.processDue());
  api.buffer.push(config.events_queue_id, delivery());
  api.buffer.push(config.events_queue_id, delivery("cf.email.sending.message.future"));
  api.buffer.push(config.events_queue_id, {
    ...delivery(),
    payload: { subject: "Do not store this payload" },
  });
  api.buffer.push(config.events_queue_id, "malformed JSON");
  expect(await api.process(processDeliveryEvents())).toEqual({
    status: "ready",
    processed: 4,
    applied: 1,
    unknown: 1,
    quarantined: 2,
    retried: 0,
  });
  expect((await api.run(api.mailbox.getMessage(inbox, sent.message_id))).labels).toContain(
    "delivered",
  );
  expect(api.buffer.messages.size).toBe(0);
  expect(api.buffer.retries).toHaveLength(0);
  const quarantine = await api.run(api.state.listMessageQuarantine());
  expect(quarantine).toHaveLength(2);
  expect(JSON.stringify(quarantine)).not.toContain("subject");
  api.buffer.push(config.events_queue_id, delivery());
  await api.process(processDeliveryEvents());
  expect(
    await api.run(api.store.use((db) => db.prepare("SELECT event_id FROM delivery_events").all())),
  ).toHaveLength(1);
});

test("retries event storage errors and safely replays a committed event after an ack failure", async ({
  api,
}) => {
  await api.run(
    api.outbox.enqueue(inbox, {
      kind: "send",
      request: { to: "alice@example.test", text: "Synthetic" },
    }),
  );
  await api.run(api.outbox.processDue());
  api.buffer.push(config.events_queue_id, delivery());
  const outbox = {
    ...api.outbox,
    applyDeliveryEvent: () => Effect.fail(new DatabaseError({ operation: "query" })),
  };
  expect(
    (await api.process(processDeliveryEvents().pipe(Effect.provideService(Outbox, outbox))))
      .retried,
  ).toBe(1);
  expect(api.buffer.acks).toHaveLength(0);
  api.time.now += 5000;
  const buffer = {
    ...api.buffer.service,
    ack: () => Effect.fail(new BufferError({ code: "buffer_unavailable" })),
  };
  expect(
    (await api.process(processDeliveryEvents().pipe(Effect.provideService(InboundBuffer, buffer))))
      .retried,
  ).toBe(1);
  api.time.now += 10_000;
  expect((await api.process(processDeliveryEvents())).applied).toBe(1);
  expect(
    await api.run(api.store.use((db) => db.prepare("SELECT event_id FROM delivery_events").all())),
  ).toHaveLength(1);
});

test("does not acknowledge corrupt data if recording quarantine fails", async ({ api }) => {
  await api.put(1, { bytes: new Uint8Array(64).fill(42) });
  let writes = 0;
  const store = {
    use: <A>(operation: Parameters<typeof api.store.use<A>>[0]) => {
      writes++;
      return writes === 3
        ? Effect.fail(new DatabaseError({ operation: "query" }))
        : api.store.use(operation);
    },
  };
  expect(
    (await api.process(processInbound().pipe(Effect.provideService(Store, store)))).retried,
  ).toBe(1);
  expect(api.buffer.acks).toHaveLength(0);
  expect(api.buffer.objects.size).toBe(1);
  expect(await api.run(api.state.listQuarantine())).toHaveLength(0);
  api.time.now += 5000;
  expect((await api.process(processInbound())).quarantined).toBe(1);
});

test("reconciliation follows R2 cursors and resumes an explicitly released quarantine", async ({
  api,
}) => {
  const old = "2026-10-10T11:30:00.000Z";
  await api.put(1, { pointer: false, received_at: old });
  await api.put(2, { pointer: false, received_at: old });
  await api.run(api.state.put(key(2), "quarantined", "invalid_ciphertext"));
  const cursors: (string | undefined)[] = [];
  const buffer = {
    ...api.buffer.service,
    listObjects: (_prefix: string, cursor?: string) =>
      Effect.sync(() => {
        cursors.push(cursor);
        const index = cursor === undefined ? 1 : 2;
        const object = api.buffer.objects.get(key(index));
        if (object === undefined) throw new Error("Expected a synthetic object");
        return {
          objects: [
            { key: key(index), size: object.bytes.byteLength, last_modified: object.last_modified },
          ],
          ...(cursor === undefined ? { cursor: "next" } : {}),
        };
      }),
  };
  expect(
    (await api.process(reconcileInbound().pipe(Effect.provideService(InboundBuffer, buffer))))
      .processed,
  ).toBe(1);
  expect(cursors).toEqual([undefined, "next"]);
  expect(api.buffer.objects.has(key(2))).toBe(true);
  await api.run(api.state.releaseQuarantine(key(2)));
  expect((await api.process(reconcileInbound())).processed).toBe(1);
  expect(api.buffer.objects.size).toBe(0);
});
