import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import type { UpdateStatus } from "../../../../packages/contracts/src/updates.js";
import { manageAutomaticUpdates } from "./automatic.js";
import type { UpdateState } from "./state.js";

function fixture() {
  let status: UpdateStatus = {
    current: "0.1.0",
    enabled: true,
    eligible: true,
    last_check: null,
    latest: null,
    last_result: "never_checked",
    error: null,
  };
  const state: UpdateState = {
    read: async () => status,
    configure: async (value) => {
      status = { ...status, ...value };
      return status;
    },
    record: async (value) => {
      status = { ...status, ...value };
    },
  };
  const prepared = {
    destination: "/synthetic/0.2.0",
    activate: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const stopped = Promise.withResolvers<void>();
  const controller = manageAutomaticUpdates(state, stopped.resolve, {
    check: async () => ({ latest: "0.2.0", update_available: true }),
    prepare: async () => prepared,
    random: () => 0,
  });
  return {
    state,
    prepared,
    stopped,
    controller,
    boot: () => {
      status = { ...status, current: "0.2.0" };
    },
  };
}

test("automatic activation follows scoped runner and storage shutdown, and startup observes the new version", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const shutdown: string[] = [];
  try {
    const server = Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            shutdown.push("storage");
          }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            shutdown.push("runners");
          }),
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => f.controller.close()));
        yield* Effect.promise(() => f.controller.start());
        yield* Effect.promise(() => f.stopped.promise);
      }).pipe(Effect.scoped),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await server;
    expect(shutdown).toEqual(["runners", "storage"]);
    expect(f.prepared.activate).not.toHaveBeenCalled();
    f.prepared.activate.mockImplementation(async () => {
      expect(await f.state.read()).toMatchObject({ last_result: "restarting" });
    });
    expect(await f.controller.applyAfterShutdown()).toBe(true);
    expect(f.prepared.activate).toHaveBeenCalledOnce();
    expect(f.prepared.close).toHaveBeenCalledOnce();
    expect(await f.state.read()).toMatchObject({ last_result: "restarting" });
    f.boot();
    const next = manageAutomaticUpdates(f.state, () => {});
    await next.start();
    expect(await f.state.read()).toMatchObject({
      current: "0.2.0",
      last_result: "updated",
      error: null,
    });
    await next.close();
  } finally {
    await f.controller.close();
    vi.useRealTimers();
  }
});

test("failed shutdown never activates and releases the installation lock", async () => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    await f.controller.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await f.controller.abort();
    expect(await f.controller.applyAfterShutdown()).toBe(false);
    expect(f.prepared.activate).not.toHaveBeenCalled();
    expect(f.prepared.close).toHaveBeenCalledOnce();
    expect(await f.state.read()).toMatchObject({
      last_result: "failed",
      error: { message: expect.stringContaining("shut down cleanly") },
    });
  } finally {
    await f.controller.close();
    vi.useRealTimers();
  }
});

test("an activation failure persists a failure and asks the manager to restart the retained version", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.prepared.activate.mockRejectedValue(new Error("Synthetic rename failure"));
  try {
    await f.controller.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await f.controller.close();
    expect(await f.controller.applyAfterShutdown()).toBe(true);
    expect(await f.state.read()).toMatchObject({ last_result: "failed" });
    expect(f.prepared.close).toHaveBeenCalledOnce();
  } finally {
    await f.controller.close();
    vi.useRealTimers();
  }
});

test("unreadable update metadata does not stop mail service startup or trigger an update", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.state.read = async () => {
    throw new Error("Synthetic damaged preference");
  };
  try {
    await expect(f.controller.start()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.prepared.activate).not.toHaveBeenCalled();
  } finally {
    await f.controller.close();
    vi.useRealTimers();
  }
});
