import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Clock, Duration, Effect, Exit, Fiber, Queue } from "effect";
import { TestClock } from "effect/testing";
import { expect, test as baseTest } from "vitest";
import { fixture } from "../http/test-fixture.js";
import { startDraftLoop } from "./runtime.js";
import { Drafts } from "./drafts.js";

const inboxId = "agent@example.test";
const test = baseTest.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-draft-runtime-test-"));
    const api = await fixture(home);
    try {
      await use(api);
    } finally {
      await api.close();
      await rm(home, { recursive: true, force: true });
    }
  },
});

test("scheduler waits for due time, recovers a persisted sending draft and stops on scope shutdown", async ({
  api,
}) => {
  await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
  const clock = await api.run(TestClock.make());
  await api.run(clock.setTime(Date.parse("2026-10-10T12:00:00Z")));
  const sleeps = await api.run(Queue.unbounded<number>());
  const observed: Clock.Clock = {
    ...clock,
    sleep: (duration) =>
      Effect.andThen(Queue.offer(sleeps, Duration.toMillis(duration)), clock.sleep(duration)),
  };
  const draft = await api.run(
    api.drafts.create(
      inboxId,
      {
        to: ["alice@example.test"],
        text: "Scheduled loop",
        send_at: "2026-10-10T12:01:00Z",
      },
      "owner",
      false,
    ),
  );
  const runner = await api.run(
    startDraftLoop().pipe(
      Effect.provideService(Drafts, api.drafts),
      Effect.provideService(Clock.Clock, observed),
    ),
  );
  const sleep = () => api.run(Queue.take(sleeps).pipe(Effect.timeout("3 seconds")));
  expect(await sleep()).toBe(30_000);
  expect(api.sent).toHaveLength(0);
  await api.run(clock.adjust("30 seconds"));
  expect(await sleep()).toBe(30_000);
  await api.run(
    api.store.use((db) =>
      db
        .prepare(`UPDATE drafts SET send_status = 'sending',
    data = json_set(data, '$.send_status', 'sending') WHERE draft_id = ?`)
        .run(draft.draft_id),
    ),
  );
  await api.run(clock.adjust("30 seconds"));
  expect(await sleep()).toBe(2000);
  expect(
    (await api.run(api.mailbox.listMessages(inboxId))).messages.filter((message) =>
      message.labels.includes("queued"),
    ),
  ).toHaveLength(1);
  expect(
    await api.run(api.outbox.processDue().pipe(Effect.provideService(Clock.Clock, observed))),
  ).toBe(1);
  expect(api.sent).toHaveLength(1);
  await api.close();
  const exit = await api.run(Fiber.await(runner));
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
});

test("serve starts a scheduler alongside the outbox loop", async ({ api }) => {
  const clock = await api.run(TestClock.make());
  await api.run(clock.setTime(Date.parse("2026-10-10T12:00:00Z")));
  const server = await api.start(api.outbox, clock, true);
  expect(server.scheduler).toBeDefined();
  await server.close();
  if (server.scheduler === undefined) throw new Error("Expected scheduler fiber");
  const exit = await api.run(Fiber.await(server.scheduler));
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
});

test("new and updated schedules wake the scheduler and send at their due time", async ({ api }) => {
  await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
  const clock = await api.run(TestClock.make());
  await api.run(clock.setTime(Date.parse("2026-10-10T12:00:00Z")));
  const sleeps = await api.run(Queue.unbounded<number>());
  const observed: Clock.Clock = {
    ...clock,
    sleep: (duration) =>
      Effect.andThen(Queue.offer(sleeps, Duration.toMillis(duration)), clock.sleep(duration)),
  };
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    api.run(effect.pipe(Effect.provideService(Clock.Clock, observed)));
  const sleep = () => api.run(Queue.take(sleeps).pipe(Effect.timeout("3 seconds")));
  const server = await api.start(api.outbox, observed, true);
  try {
    expect(await sleep()).toBe(30_000);
    expect(await sleep()).toBe(30_000);
    const draft = await run(
      api.drafts.create(
        inboxId,
        { to: ["alice@example.test"], text: "Prompt schedule", send_at: "2026-10-10T12:00:20Z" },
        "synthetic-agent",
        true,
      ),
    );
    expect(await sleep()).toBe(30_000);
    await run(api.drafts.approve(inboxId, draft.draft_id));
    expect(await sleep()).toBe(20_000);
    await run(
      api.drafts.update(inboxId, draft.draft_id, { send_at: "2026-10-10T12:00:07Z" }, false),
    );
    expect(await sleep()).toBe(30_000);
    await run(api.drafts.approve(inboxId, draft.draft_id));
    expect(await sleep()).toBe(7000);
    await run(clock.adjust("6 seconds"));
    expect(api.sent).toHaveLength(0);
    await run(clock.adjust("1 second"));
    expect(await sleep()).toBe(2000);
    expect(await sleep()).toBe(2000);
    expect(api.sent).toHaveLength(1);
    expect((await api.run(api.mailbox.listMessages(inboxId))).messages[0]?.send_status).toBe(
      "sent",
    );
  } finally {
    await server.close();
  }
});
