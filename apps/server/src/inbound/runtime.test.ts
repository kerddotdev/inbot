import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clock, Duration, Effect, Queue } from "effect";
import { TestClock } from "effect/testing";
import { expect, test as baseTest } from "vitest";
import { startEventsLoop, startInboundLoop } from "./runtime.js";
import { config, fixture, key, receivedAt } from "./test-fixture.js";

const test = baseTest.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-buffer-runtime-test-"));
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
  await api.run(clock.setTime(Date.parse(receivedAt)));
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

test("pulls and reconciles at startup, schedules fast work and idle intervals, and reconciles again after fifteen minutes", async ({
  api,
}) => {
  const time = await observedClock(api);
  await api.put(1);
  await api.put(2, { pointer: false, received_at: "2026-10-10T11:30:00.000Z" });
  const runner = await api.process(
    startInboundLoop().pipe(Effect.provideService(Clock.Clock, time.clock)),
  );
  expect(await time.sleep()).toBe(2000);
  expect(api.buffer.objects.size).toBe(0);
  await time.adjust("2 seconds");
  expect(await time.sleep()).toBe(30_000);
  await api.put(3, { pointer: false, received_at: "2026-10-10T11:30:00.000Z" });
  await time.adjust("30 seconds");
  expect(await time.sleep()).toBe(30_000);
  expect(api.buffer.objects.has(key(3))).toBe(true);
  for (let index = 0; index < 30; index++) {
    await time.adjust("30 seconds");
    expect(await time.sleep()).toBe(30_000);
  }
  expect(api.buffer.objects.has(key(3))).toBe(false);
  await api.close();
  expect(runner.pollUnsafe()).toMatchObject({ _tag: "Failure" });
});

test("keeps both consumers idle without buffer or transport configuration and observes changes without restart", async ({
  api,
}) => {
  await api.run(api.inbound.clear());
  await api.run(api.transport.clear());
  const inboundTime = await observedClock(api);
  const eventsTime = await observedClock(api);
  await api.put(1);
  api.buffer.push(config.events_queue_id, "malformed JSON");
  const inbound = await api.process(
    startInboundLoop().pipe(Effect.provideService(Clock.Clock, inboundTime.clock)),
  );
  const events = await api.process(
    startEventsLoop().pipe(Effect.provideService(Clock.Clock, eventsTime.clock)),
  );
  expect(await inboundTime.sleep()).toBe(30_000);
  expect(await eventsTime.sleep()).toBe(30_000);
  expect(api.buffer.acks).toHaveLength(0);
  await api.run(api.inbound.set(config));
  await inboundTime.adjust("30 seconds");
  await eventsTime.adjust("30 seconds");
  expect(await inboundTime.sleep()).toBe(30_000);
  expect(await eventsTime.sleep()).toBe(30_000);
  expect(api.buffer.acks).toHaveLength(0);
  await api.run(api.transport.set({ account_id: config.account_id, api_token: "synthetic-token" }));
  await inboundTime.adjust("30 seconds");
  await eventsTime.adjust("30 seconds");
  expect(await inboundTime.sleep()).toBe(2000);
  expect(await eventsTime.sleep()).toBe(2000);
  expect(api.buffer.objects.size).toBe(0);
  expect(api.buffer.messages.size).toBe(0);
  await api.run(api.transport.clear());
  await api.put(2);
  api.buffer.push(config.events_queue_id, "malformed JSON");
  const acknowledged = api.buffer.acks.length;
  await inboundTime.adjust("2 seconds");
  await eventsTime.adjust("2 seconds");
  expect(await inboundTime.sleep()).toBe(30_000);
  expect(await eventsTime.sleep()).toBe(30_000);
  expect(api.buffer.acks).toHaveLength(acknowledged);
  expect(api.buffer.objects.size).toBe(1);
  await api.close();
  expect(inbound.pollUnsafe()).toMatchObject({ _tag: "Failure" });
  expect(events.pollUnsafe()).toMatchObject({ _tag: "Failure" });
});
