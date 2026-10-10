import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clock, Deferred, Effect, Fiber, Layer } from "effect";
import { expect, test as baseTest } from "vitest";
import type {
  DeliveryEvent,
  OutboundRequest,
} from "../../../../packages/contracts/src/outbound.js";
import { Home } from "../home.js";
import { ingestInbound } from "../inbound/ingest.js";
import { Mailbox, type MailboxService } from "../mailbox/mailbox.js";
import { Store, type StoreService } from "../store.js";
import {
  OutboundProvider,
  type OutboundProviderService,
  type ProviderMessage,
} from "./cloudflare.js";
import { parseDeliveryEvent } from "./delivery.js";
import { OutboundError } from "./errors.js";
import { MAX_ATTEMPTS, Outbox, SENDING_LEASE_MS, type OutboxService } from "./outbox.js";

const initialNow = Date.parse("2026-10-10T12:00:00Z");
const test = baseTest.extend<{ home: string; key: Uint8Array; time: { now: number } }>({
  home: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-outbound-test-"));
    try {
      await use(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  key: async ({ home: _home }, use) => {
    const key = randomBytes(32);
    try {
      await use(key);
    } finally {
      key.fill(0);
    }
  },
  time: async ({ home: _home }, use) => {
    await use({ now: initialNow });
  },
});

function withServices<A, E>(
  home: string,
  key: Uint8Array,
  time: { now: number },
  send: OutboundProviderService["send"],
  use: (
    outbox: OutboxService,
    mailbox: MailboxService,
    store: StoreService,
  ) => Effect.Effect<A, E, Mailbox>,
) {
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => time.now,
    currentTimeMillis: Effect.sync(() => time.now),
    currentTimeNanosUnsafe: () => BigInt(time.now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(time.now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => 0n,
    monotonicTimeNanos: Effect.succeed(0n),
    sleep: () => Effect.never,
  };
  const store = Store.layer(key).pipe(
    Layer.provide(Home.layer({ flag: home, flavor: "development" })),
  );
  const services = Layer.merge(Outbox.Live, Mailbox.Live).pipe(
    Layer.provideMerge(store),
    Layer.provide(OutboundProvider.fake(send)),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* Outbox, yield* Mailbox, yield* Store);
    }).pipe(Effect.provide(services), Effect.provideService(Clock.Clock, clock)),
  );
}

function fake() {
  const calls: ProviderMessage[] = [];
  return {
    calls,
    send: (message: ProviderMessage) =>
      Effect.sync(() => {
        calls.push(message);
        return { provider_message_id: `<provider-${calls.length}@example.test>` };
      }),
  };
}

function sendRequest(text = "Synthetic private outgoing body"): OutboundRequest {
  return { kind: "send", request: { to: "alice@example.test", subject: "Project", text } };
}

function createInbox(mailbox: MailboxService, username = "agent") {
  return mailbox.createInbox({ username, domain: "example.test" });
}

function parent(mailbox: MailboxService, inboxId: string) {
  return mailbox.insertMessage({
    inbox_id: inboxId,
    message_id: "<parent@example.test>",
    from: "alice@example.test",
    to: [inboxId],
    subject: "Project",
    text: "Original body",
    direction: "received",
    labels: ["received"],
    timestamp: new Date(initialNow).toISOString(),
    raw: Buffer.from("Message-ID: <parent@example.test>\r\n\r\nOriginal body"),
  });
}

test("enqueue stores queued replies atomically, acceptance adds an alias, and inbound replies join the original thread", async ({
  home,
  key,
  time,
}) => {
  const provider = fake();
  await withServices(home, key, time, provider.send, (outbox, mailbox) =>
    Effect.gen(function* () {
      const inbox = yield* createInbox(mailbox);
      const original = yield* parent(mailbox, inbox.inbox_id);
      const reply = yield* outbox.enqueue(inbox.inbox_id, {
        kind: "reply",
        message_id: original.message_id,
        request: { text: "Reply", labels: ["custom", "sent", "delivered"] },
      });
      expect(reply.thread_id).toBe(original.thread_id);
      expect(reply.message_id).toMatch(/^<[\w-]+@inbot\.local>$/);
      expect((yield* mailbox.getMessage(inbox.inbox_id, reply.message_id)).labels).toEqual([
        "custom",
        "queued",
      ]);
      expect(yield* outbox.get(inbox.inbox_id, reply.message_id)).toMatchObject({
        state: "queued",
        attempts: 0,
      });
      expect(provider.calls).toHaveLength(0);
      expect(yield* outbox.processDue()).toBe(1);
      expect((yield* mailbox.getMessage(inbox.inbox_id, reply.message_id)).labels).toEqual([
        "custom",
        "sent",
      ]);
      expect(yield* outbox.get(inbox.inbox_id, reply.message_id)).toMatchObject({
        state: "sent",
        attempts: 1,
        provider_message_id: "<provider-1@example.test>",
      });
      const raw = Buffer.from(
        `Message-ID: <incoming-reply@example.test>\r\nFrom: alice@example.test\r\nTo: ${inbox.inbox_id}\r\nIn-Reply-To: <provider-1@example.test>\r\nSubject: Re: Project\r\n\r\nThanks`,
      );
      const ingested = yield* ingestInbound({
        mail_from: "alice@example.test",
        rcpt_to: [inbox.inbox_id],
        raw,
        received_at: new Date(time.now).toISOString(),
      });
      expect(ingested[0]).toMatchObject({ status: "stored", thread_id: original.thread_id });
      const next = yield* outbox.enqueue(inbox.inbox_id, {
        kind: "reply",
        message_id: reply.message_id,
        request: { text: "Follow-up", to: "alice@example.test" },
      });
      expect((yield* mailbox.getMessage(inbox.inbox_id, next.message_id)).in_reply_to).toBe(
        "<provider-1@example.test>",
      );
      expect(next.thread_id).toBe(original.thread_id);
      expect(yield* outbox.processDue()).toBe(1);
      expect(yield* outbox.processDue()).toBe(0);
    }),
  );
});

test("outgoing bodies and persisted provider payloads stay encrypted at rest", async ({
  home,
  key,
  time,
}) => {
  const provider = fake();
  await withServices(home, key, time, provider.send, (outbox, mailbox) =>
    Effect.gen(function* () {
      const inbox = yield* createInbox(mailbox);
      yield* outbox.enqueue(inbox.inbox_id, sendRequest());
      const wal = yield* Effect.promise(() => readFile(join(home, "inbot.db-wal")));
      expect(wal.includes(Buffer.from("Synthetic private outgoing body"))).toBe(false);
    }),
  );
  expect(
    (await readFile(join(home, "inbot.db"))).includes(
      Buffer.from("Synthetic private outgoing body"),
    ),
  ).toBe(false);
});

test("retryable errors back off, respect Retry-After, and eventually succeed", async ({
  home,
  key,
  time,
}) => {
  let calls = 0;
  const send: OutboundProviderService["send"] = () =>
    Effect.suspend(() => {
      calls++;
      return calls <= 2
        ? Effect.fail(
            new OutboundError({
              code: "rate_limit_exceeded",
              message: "Quota",
              fix: "Wait",
              retryable: true,
              ...(calls === 1 ? { retry_after_ms: 5000 } : {}),
            }),
          )
        : Effect.succeed({ provider_message_id: "<accepted@example.test>" });
    });
  await withServices(home, key, time, send, (outbox, mailbox) =>
    Effect.gen(function* () {
      const inbox = yield* createInbox(mailbox);
      const message = yield* outbox.enqueue(inbox.inbox_id, sendRequest());
      yield* outbox.processDue();
      expect(yield* outbox.get(inbox.inbox_id, message.message_id)).toMatchObject({
        state: "queued",
        attempts: 1,
        next_attempt_at: initialNow + 5000,
        last_error_code: "rate_limit_exceeded",
      });
      expect(yield* outbox.processDue()).toBe(0);
      time.now += 5000;
      yield* outbox.processDue();
      expect((yield* outbox.get(inbox.inbox_id, message.message_id)).next_attempt_at).toBe(
        time.now + 2000,
      );
      time.now += 2000;
      yield* outbox.processDue();
      expect((yield* outbox.get(inbox.inbox_id, message.message_id)).state).toBe("sent");
      expect(calls).toBe(3);
    }),
  );
});

for (const code of ["domain_not_verified", "service_unavailable"] as const) {
  test(`permanent and exhausted ${code} failures stop sending`, async ({ home, key, time }) => {
    let calls = 0;
    const send: OutboundProviderService["send"] = () =>
      Effect.suspend(() => {
        calls++;
        return Effect.fail(
          new OutboundError({
            code,
            message: "Rejected",
            fix: "Check provider",
            retryable: code === "service_unavailable",
          }),
        );
      });
    await withServices(home, key, time, send, (outbox, mailbox) =>
      Effect.gen(function* () {
        const inbox = yield* createInbox(mailbox);
        const message = yield* outbox.enqueue(inbox.inbox_id, sendRequest());
        const attempts = code === "service_unavailable" ? MAX_ATTEMPTS : 1;
        for (let i = 0; i < attempts; i++) {
          yield* outbox.processDue();
          time.now += 60 * 60 * 1000;
        }
        expect(yield* outbox.get(inbox.inbox_id, message.message_id)).toMatchObject({
          state: "failed",
          attempts,
          last_error_code: code,
        });
        expect((yield* mailbox.getMessage(inbox.inbox_id, message.message_id)).labels).toEqual([
          "failed",
        ]);
        expect(yield* outbox.processDue()).toBe(0);
        expect(calls).toBe(attempts);
      }),
    );
  });
}

test("uncertain provider outcomes fail honestly without retrying", async ({ home, key, time }) => {
  let calls = 0;
  const send: OutboundProviderService["send"] = () =>
    Effect.suspend(() => {
      calls++;
      return Effect.fail(
        new OutboundError({
          code: "service_unavailable",
          message: "Unknown",
          fix: "Reconcile",
          retryable: true,
          outcome_unknown: true,
        }),
      );
    });
  await withServices(home, key, time, send, (outbox, mailbox) =>
    Effect.gen(function* () {
      const inbox = yield* createInbox(mailbox);
      const message = yield* outbox.enqueue(inbox.inbox_id, sendRequest());
      yield* outbox.processDue();
      time.now += SENDING_LEASE_MS;
      expect(yield* outbox.processDue()).toBe(0);
      expect(yield* outbox.get(inbox.inbox_id, message.message_id)).toMatchObject({
        state: "failed",
        last_error_code: "unknown_outcome",
      });
      expect(calls).toBe(1);
    }),
  );
});

test("idempotency is canonical, durable, scoped per inbox, and expires 24 hours after completion", async ({
  home,
  key,
  time,
}) => {
  const provider = fake();
  const result = await withServices(home, key, time, provider.send, (outbox, mailbox) =>
    Effect.gen(function* () {
      const inbox = yield* createInbox(mailbox);
      const other = yield* createInbox(mailbox, "other");
      const message = yield* outbox.enqueue(inbox.inbox_id, sendRequest(), "stable-key");
      expect(
        yield* outbox.enqueue(
          inbox.inbox_id,
          {
            request: {
              text: "Synthetic private outgoing body",
              subject: "Project",
              to: "alice@example.test",
            },
            kind: "send",
          },
          "stable-key",
        ),
      ).toEqual(message);
      expect(
        (yield* Effect.flip(
          outbox.enqueue(inbox.inbox_id, sendRequest("Different body"), "stable-key"),
        )).code,
      ).toBe("idempotency_conflict");
      expect(
        (yield* Effect.flip(
          outbox.enqueue(
            inbox.inbox_id,
            { kind: "forward", message_id: message.message_id, request: sendRequest().request },
            "stable-key",
          ),
        )).code,
      ).toBe("idempotency_conflict");
      expect(
        (yield* outbox.enqueue(other.inbox_id, sendRequest(), "stable-key")).message_id,
      ).not.toBe(message.message_id);
      yield* outbox.processDue();
      expect(provider.calls).toHaveLength(2);
      return { inbox: inbox.inbox_id, message };
    }),
  );
  await withServices(home, key, time, provider.send, (outbox) =>
    Effect.gen(function* () {
      expect(yield* outbox.enqueue(result.inbox, sendRequest(), "stable-key")).toEqual(
        result.message,
      );
      time.now += 24 * 60 * 60 * 1000 - 1;
      expect(yield* outbox.enqueue(result.inbox, sendRequest(), "stable-key")).toEqual(
        result.message,
      );
      time.now++;
      const newMessage = yield* outbox.enqueue(result.inbox, sendRequest("New body"), "stable-key");
      expect(newMessage.message_id).not.toBe(result.message.message_id);
      expect(yield* outbox.processDue()).toBe(1);
    }),
  );
});

test("pending idempotency keys survive long outages and invalid keys never create mail", async ({
  home,
  key,
  time,
}) => {
  const provider = fake();
  await withServices(home, key, time, provider.send, (outbox, mailbox) =>
    Effect.gen(function* () {
      const inbox = yield* createInbox(mailbox);
      for (const key of ["", "bad key", "a".repeat(257)])
        expect((yield* Effect.flip(outbox.enqueue(inbox.inbox_id, sendRequest(), key))).code).toBe(
          "validation_error",
        );
      expect((yield* mailbox.listMessages(inbox.inbox_id)).count).toBe(0);
      const message = yield* outbox.enqueue(inbox.inbox_id, sendRequest(), "pending");
      time.now += 48 * 60 * 60 * 1000;
      expect(yield* outbox.enqueue(inbox.inbox_id, sendRequest(), "pending")).toEqual(message);
      expect((yield* mailbox.listMessages(inbox.inbox_id)).count).toBe(1);
    }),
  );
});

test("an interrupted send survives restart as unknown_outcome and is never blindly resent", async ({
  home,
  key,
  time,
}) => {
  const started = await Effect.runPromise(Deferred.make<void>());
  const stalled: OutboundProviderService["send"] = () =>
    Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
  const ids = await withServices(home, key, time, stalled, (outbox, mailbox) =>
    Effect.gen(function* () {
      const inbox = yield* createInbox(mailbox);
      const message = yield* outbox.enqueue(inbox.inbox_id, sendRequest(), "crashed");
      const fiber = yield* outbox.processDue().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      expect((yield* outbox.get(inbox.inbox_id, message.message_id)).state).toBe("sending");
      yield* Fiber.interrupt(fiber);
      return { inbox: inbox.inbox_id, message };
    }),
  );
  const provider = fake();
  time.now += SENDING_LEASE_MS;
  await withServices(home, key, time, provider.send, (outbox, mailbox) =>
    Effect.gen(function* () {
      expect(yield* outbox.processDue()).toBe(0);
      expect(yield* outbox.get(ids.inbox, ids.message.message_id)).toMatchObject({
        state: "failed",
        attempts: 1,
        last_error_code: "unknown_outcome",
      });
      expect((yield* mailbox.getMessage(ids.inbox, ids.message.message_id)).labels).toEqual([
        "failed",
      ]);
      expect(yield* outbox.enqueue(ids.inbox, sendRequest(), "crashed")).toEqual(ids.message);
      expect(provider.calls).toHaveLength(0);
    }),
  );
});

test("concurrent workers claim each message once and new sends create distinct threads", async ({
  home,
  key,
  time,
}) => {
  const provider = fake();
  await withServices(home, key, time, provider.send, (outbox, mailbox) =>
    Effect.gen(function* () {
      const inbox = yield* createInbox(mailbox);
      const messages = yield* Effect.all(
        [
          outbox.enqueue(inbox.inbox_id, sendRequest(), "same"),
          outbox.enqueue(inbox.inbox_id, sendRequest(), "same"),
        ],
        { concurrency: "unbounded" },
      );
      expect(messages[0]).toEqual(messages[1]);
      yield* outbox.enqueue(inbox.inbox_id, sendRequest());
      yield* Effect.all([outbox.processDue(), outbox.processDue()], { concurrency: "unbounded" });
      expect(provider.calls).toHaveLength(2);
      expect((yield* mailbox.listThreads({ inbox_id: inbox.inbox_id })).count).toBe(2);
    }),
  );
});

test("delivery envelopes decode safely and apply all six event labels by provider alias", async ({
  home,
  key,
  time,
}) => {
  const provider = fake();
  await withServices(home, key, time, provider.send, (outbox, mailbox) =>
    Effect.gen(function* () {
      const inbox = yield* createInbox(mailbox);
      const message = yield* outbox.enqueue(inbox.inbox_id, sendRequest());
      yield* outbox.processDue();
      for (const status of [
        "delivered",
        "bounced",
        "complained",
        "failed",
        "rejected",
        "deferred",
      ] as const) {
        const event = yield* parseDeliveryEvent({
          type: `cf.email.sending.message.${status}`,
          source: { type: "email.sending", zoneId: "synthetic", domain: "example.test" },
          payload: {
            eventId: status,
            messageId: "<provider-1@example.test>",
            recipient: "alice@example.test",
            subject: "private content",
            terminal: status !== "deferred",
            delivery: { status },
          },
          metadata: { eventSchemaVersion: 1, eventTimestamp: new Date(time.now).toISOString() },
        });
        expect("subject" in event).toBe(false);
        expect(yield* outbox.applyDeliveryEvent(event)).toBe(true);
        expect(yield* outbox.applyDeliveryEvent(event)).toBe(true);
      }
      expect((yield* mailbox.getMessage(inbox.inbox_id, message.message_id)).labels).toEqual([
        "bounced",
        "complained",
        "deferred",
        "delivered",
        "failed",
        "rejected",
        "sent",
      ]);
      const unknown: DeliveryEvent = {
        event_id: "unknown",
        provider_message_id: "<unknown@example.test>",
        status: "delivered",
        recipient: "alice@example.test",
        timestamp: new Date(time.now).toISOString(),
      };
      expect(yield* outbox.applyDeliveryEvent(unknown)).toBe(false);
      expect((yield* outbox.get(inbox.inbox_id, message.message_id)).state).toBe("sent");
      expect((yield* Effect.flip(parseDeliveryEvent({}))).code).toBe("validation_error");
    }),
  );
});

test("inbox isolation, pausing, and failed composition do not leak or store messages", async ({
  home,
  key,
  time,
}) => {
  const provider = fake();
  await withServices(home, key, time, provider.send, (outbox, mailbox) =>
    Effect.gen(function* () {
      const inbox = yield* createInbox(mailbox);
      const other = yield* createInbox(mailbox, "other");
      const original = yield* parent(mailbox, other.inbox_id);
      expect(
        (yield* Effect.flip(
          outbox.enqueue(inbox.inbox_id, {
            kind: "reply",
            message_id: original.message_id,
            request: { text: "Reply" },
          }),
        )).code,
      ).toBe("not_found");
      expect(
        (yield* Effect.flip(
          outbox.enqueue(inbox.inbox_id, {
            kind: "send",
            request: { to: "alice@example.test", text: "Body", headers: { Date: "forbidden" } },
          }),
        )).code,
      ).toBe("validation_error");
      expect((yield* mailbox.listMessages(inbox.inbox_id)).count).toBe(0);
      const message = yield* outbox.enqueue(inbox.inbox_id, sendRequest());
      expect(
        (yield* Effect.flip(
          outbox.enqueue(inbox.inbox_id, {
            kind: "reply",
            message_id: message.message_id,
            request: { text: "Reply" },
          }),
        )).code,
      ).toBe("validation_error");
      yield* mailbox.updateInbox(inbox.inbox_id, { status: "paused" });
      expect((yield* Effect.flip(outbox.enqueue(inbox.inbox_id, sendRequest()))).code).toBe(
        "inbox_paused",
      );
      expect(yield* outbox.processDue()).toBe(0);
      yield* mailbox.updateInbox(inbox.inbox_id, { status: "active" });
      expect(yield* outbox.processDue()).toBe(1);
      expect(provider.calls).toHaveLength(1);
    }),
  );
});

test("the scoped runner completes observable work and stops on interruption", async ({
  home,
  key,
  time,
}) => {
  const accepted = await Effect.runPromise(Deferred.make<void>());
  const provider = fake();
  const send: OutboundProviderService["send"] = (message) =>
    provider.send(message).pipe(Effect.tap(() => Deferred.succeed(accepted, undefined)));
  await withServices(home, key, time, send, (outbox, mailbox) =>
    Effect.gen(function* () {
      const inbox = yield* createInbox(mailbox);
      const message = yield* outbox.enqueue(inbox.inbox_id, sendRequest());
      yield* Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* outbox.start();
          yield* Deferred.await(accepted);
          for (let i = 0; i < 100; i++) {
            if ((yield* outbox.get(inbox.inbox_id, message.message_id)).state === "sent") break;
            yield* Effect.yieldNow;
          }
          expect((yield* outbox.get(inbox.inbox_id, message.message_id)).state).toBe("sent");
          yield* Fiber.interrupt(fiber);
        }),
      );
      expect((yield* outbox.get(inbox.inbox_id, message.message_id)).state).toBe("sent");
      yield* outbox.enqueue(inbox.inbox_id, sendRequest("After stop"));
      expect(provider.calls).toHaveLength(1);
    }),
  );
});

test("forwarding reads original attachment bytes from the encrypted mailbox and starts a new thread", async ({
  home,
  key,
  time,
}) => {
  const provider = fake();
  await withServices(home, key, time, provider.send, (outbox, mailbox) =>
    Effect.gen(function* () {
      const inbox = yield* createInbox(mailbox);
      const original = yield* mailbox.insertMessage({
        inbox_id: inbox.inbox_id,
        message_id: "<attachment-parent@example.test>",
        from: "alice@example.test",
        to: [inbox.inbox_id],
        subject: "Report",
        text: "Original report",
        html: '<p>Original report</p><img src="cid:logo">',
        direction: "received",
        timestamp: new Date(time.now).toISOString(),
        raw: Buffer.from("synthetic MIME"),
        attachments: [
          { filename: "report.txt", content_type: "text/plain", content: Buffer.from("report") },
          {
            filename: "logo.png",
            content_type: "image/png",
            content_disposition: "inline",
            content_id: "<logo>",
            content: Buffer.from("image"),
          },
        ],
      });
      const forwarded = yield* outbox.enqueue(inbox.inbox_id, {
        kind: "forward",
        message_id: original.message_id,
        request: { to: "reviewer@example.test", text: "Review" },
      });
      expect(forwarded.thread_id).not.toBe(original.thread_id);
      const stored = yield* mailbox.getMessage(inbox.inbox_id, forwarded.message_id);
      expect(stored.text).toContain("Original report");
      expect(stored.attachments).toHaveLength(2);
      yield* outbox.processDue();
      const outgoing = provider.calls[0];
      expect(
        outgoing?.attachments.find((attachment) => attachment.filename === "logo.png"),
      ).toMatchObject({
        content: Buffer.from("image").toString("base64"),
        content_id: "logo",
        disposition: "inline",
      });
      expect(
        outgoing?.attachments.find((attachment) => attachment.filename === "report.txt"),
      ).toMatchObject({ content: Buffer.from("report").toString("base64") });
    }),
  );
});

test("an acceptance alias cannot shadow another message", async ({ home, key, time }) => {
  const send: OutboundProviderService["send"] = () =>
    Effect.succeed({ provider_message_id: "<parent@example.test>" });
  await withServices(home, key, time, send, (outbox, mailbox) =>
    Effect.gen(function* () {
      const inbox = yield* createInbox(mailbox);
      const original = yield* parent(mailbox, inbox.inbox_id);
      const outgoing = yield* outbox.enqueue(inbox.inbox_id, sendRequest());
      yield* outbox.processDue();
      expect(yield* outbox.get(inbox.inbox_id, outgoing.message_id)).toMatchObject({
        state: "failed",
        last_error_code: "unknown_outcome",
        provider_message_id: original.message_id,
      });
      expect((yield* mailbox.getMessage(inbox.inbox_id, original.message_id)).text).toBe(
        "Original body",
      );
      expect((yield* mailbox.getMessage(inbox.inbox_id, outgoing.message_id)).labels).toEqual([
        "failed",
      ]);
    }),
  );
});

test("deleting a sent message cannot bypass its durable idempotency guard", async ({
  home,
  key,
  time,
}) => {
  const provider = fake();
  const result = await withServices(home, key, time, provider.send, (outbox, mailbox) =>
    Effect.gen(function* () {
      const inbox = yield* createInbox(mailbox);
      const message = yield* outbox.enqueue(inbox.inbox_id, sendRequest(), "deleted");
      yield* outbox.processDue();
      yield* mailbox.deleteMessage(inbox.inbox_id, message.message_id);
      return { inbox: inbox.inbox_id, message };
    }),
  );
  await withServices(home, key, time, provider.send, (outbox, mailbox) =>
    Effect.gen(function* () {
      expect(yield* outbox.enqueue(result.inbox, sendRequest(), "deleted")).toEqual(result.message);
      expect(
        (yield* Effect.flip(outbox.enqueue(result.inbox, sendRequest("Different"), "deleted")))
          .code,
      ).toBe("idempotency_conflict");
      expect(yield* outbox.processDue()).toBe(0);
      expect((yield* mailbox.listMessages(result.inbox)).count).toBe(0);
      expect(provider.calls).toHaveLength(1);
      time.now += 24 * 60 * 60 * 1000;
      expect(
        (yield* outbox.enqueue(result.inbox, sendRequest("New send"), "deleted")).message_id,
      ).not.toBe(result.message.message_id);
      expect(yield* outbox.processDue()).toBe(1);
    }),
  );
});
