import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Clock, Duration, Effect, Exit, Fiber, Queue, Result } from "effect";
import { TestClock } from "effect/testing";
import { expect, test as baseTest } from "vitest";
import { DatabaseError } from "../store.js";
import { fixture } from "../http/test-fixture.js";

const inboxId = "agent@example.test";
const send = {
  kind: "send",
  request: { to: "alice@example.test", text: "Synthetic runtime mail" },
} as const;
const test = baseTest.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-runtime-test-"));
    const api = await fixture(home);
    try {
      await use(api);
    } finally {
      await api.close();
      await rm(home, { recursive: true, force: true });
    }
  },
});

async function observedClock(api: Awaited<ReturnType<typeof fixture>>) {
  const clock = await api.run(TestClock.make());
  await api.run(clock.setTime(Date.parse("2026-10-10T12:00:00Z")));
  const sleeps = await api.run(Queue.unbounded<number>());
  const observed: Clock.Clock = {
    ...clock,
    sleep: (duration) =>
      Effect.andThen(Queue.offer(sleeps, Duration.toMillis(duration)), clock.sleep(duration)),
  };
  return {
    clock: observed,
    adjust: (duration: Duration.Input) => api.run(clock.adjust(duration)),
    sleep: () => api.run(Queue.take(sleeps).pipe(Effect.timeout("3 seconds"))),
  };
}

test("starts with the HTTP server, backs off while idle and is interrupted before the server closes", async ({
  api,
}) => {
  const time = await observedClock(api);
  await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
  const first = await api.run(api.outbox.enqueue(inboxId, send));
  let cycles = 0;
  const outbox = {
    ...api.outbox,
    processDue: () =>
      api.outbox.processDue().pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            cycles++;
          }),
        ),
      ),
  };
  const server = await api.start(outbox, time.clock);
  try {
    expect(await time.sleep()).toBe(2000);
    expect((await api.run(api.outbox.get(inboxId, first.message_id))).state).toBe("sent");
    expect(api.sent).toHaveLength(1);
    await time.adjust("2 seconds");
    expect(await time.sleep()).toBe(30_000);
    expect(cycles).toBe(2);
    await time.adjust("5 seconds");
    expect(cycles).toBe(2);
    const next = await api.run(api.outbox.enqueue(inboxId, send));
    await time.adjust("25 seconds");
    expect(await time.sleep()).toBe(2000);
    expect((await api.run(api.outbox.get(inboxId, next.message_id))).state).toBe("sent");
    expect(api.sent).toHaveLength(2);
    await api.run(api.transport.clear());
    await time.adjust("2 seconds");
    expect(await time.sleep()).toBe(30_000);
    expect(cycles).toBe(3);
  } finally {
    await server.close();
  }
  if (server.runner === undefined) throw new Error("Expected an outbox runner");
  const exit = await api.run(Fiber.await(server.runner));
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
  const after = await api.run(api.outbox.enqueue(inboxId, send));
  await time.adjust("30 seconds");
  expect(cycles).toBe(3);
  expect(api.sent).toHaveLength(2);
  expect((await api.run(api.outbox.get(inboxId, after.message_id))).state).toBe("queued");
  await expect(fetch(server.url)).rejects.toThrow();
});

test("never processes queued mail without configuration and notices later transport configuration", async ({
  api,
}) => {
  const time = await observedClock(api);
  const queued = await api.run(api.outbox.enqueue(inboxId, send));
  let cycles = 0;
  const outbox = {
    ...api.outbox,
    processDue: () =>
      api.outbox.processDue().pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            cycles++;
          }),
        ),
      ),
  };
  const server = await api.start(outbox, time.clock);
  try {
    expect(await time.sleep()).toBe(30_000);
    expect(cycles).toBe(0);
    expect(api.sent).toHaveLength(0);
    await time.adjust("30 seconds");
    expect(await time.sleep()).toBe(30_000);
    expect(cycles).toBe(0);
    expect(
      (
        await api.request("/v0/owner/transport", {
          method: "PUT",
          body: { account_id: "a".repeat(32), api_token: "synthetic-token" },
        })
      ).status,
    ).toBe(200);
    await time.adjust("30 seconds");
    expect(await time.sleep()).toBe(2000);
    expect((await api.run(api.outbox.get(inboxId, queued.message_id))).state).toBe("sent");
    expect(api.sent).toHaveLength(1);
    expect((await api.request("/v0/owner/transport", { method: "DELETE" })).status).toBe(200);
    const later = await api.run(api.outbox.enqueue(inboxId, send));
    await time.adjust("2 seconds");
    expect(await time.sleep()).toBe(30_000);
    expect((await api.run(api.outbox.get(inboxId, later.message_id))).state).toBe("queued");
    expect(api.sent).toHaveLength(1);
  } finally {
    await server.close();
  }
});

test("exposes a runner storage failure so serve can stop instead of leaving a broken background fiber", async ({
  api,
}) => {
  const time = await observedClock(api);
  await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
  const server = await api.start(
    { ...api.outbox, processDue: () => Effect.fail(new DatabaseError({ operation: "query" })) },
    time.clock,
  );
  try {
    if (server.runner === undefined) throw new Error("Expected an outbox runner");
    const result = await api.run(Effect.result(Fiber.join(server.runner)));
    expect(Result.isFailure(result) && result.failure instanceof DatabaseError).toBe(true);
    expect(api.sent).toHaveLength(0);
  } finally {
    await server.close();
  }
});
