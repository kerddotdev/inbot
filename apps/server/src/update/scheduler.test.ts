import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { UpdateStatus } from "../../../../packages/contracts/src/updates.js";
import { updateState, type UpdateState } from "./state.js";
import { updateScheduler } from "./scheduler.js";

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
  const check = vi.fn(async () => ({ latest: "0.2.0", update_available: true }));
  const prepare = vi.fn(async () => prepared);
  const ready = vi.fn();
  const scheduler = updateScheduler({ state, check, prepare, ready, random: () => 0.5 });
  return {
    state,
    prepared,
    check,
    prepare,
    ready,
    scheduler,
    ineligible: () => {
      status = { ...status, eligible: false };
    },
  };
}

test("scheduler checks shortly after start, hands off verified updates, and never activates before shutdown", async () => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(44_999);
    expect(f.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.ready).toHaveBeenCalledExactlyOnceWith(f.prepared);
    expect(f.prepared.activate).not.toHaveBeenCalled();
    expect(await f.state.read()).toMatchObject({
      latest: "0.2.0",
      last_result: "ready",
      last_check: new Date().toISOString(),
    });
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
    expect(f.check).toHaveBeenCalledTimes(1);
  } finally {
    await f.scheduler.close();
    vi.useRealTimers();
  }
});

test("checks recur within four hours and failures retain their time and recovery information", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.check.mockRejectedValueOnce(new Error("Synthetic offline response"));
  f.check.mockResolvedValue({ latest: "0.1.0", update_available: false });
  try {
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await f.state.read()).toMatchObject({
      last_result: "failed",
      error: { message: "Automatic update failed." },
    });
    await vi.advanceTimersByTimeAsync(3.75 * 60 * 60_000);
    expect(f.check).toHaveBeenCalledTimes(2);
    expect(await f.state.read()).toMatchObject({
      latest: "0.1.0",
      last_result: "up_to_date",
      error: null,
    });
    expect(f.prepare).not.toHaveBeenCalled();
  } finally {
    await f.scheduler.close();
    vi.useRealTimers();
  }
});

test.each(["disabled", "ineligible"])("%s services perform no release requests", async (mode) => {
  vi.useFakeTimers();
  const f = fixture();
  if (mode === "disabled") await f.state.configure({ enabled: false });
  else f.ineligible();
  try {
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(5 * 60 * 60_000);
    expect(f.check).not.toHaveBeenCalled();
  } finally {
    await f.scheduler.close();
    vi.useRealTimers();
  }
});

test("turning updates off during download releases the prepared update without stopping the server", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.prepare.mockImplementation(async () => {
    await f.state.configure({ enabled: false });
    return f.prepared;
  });
  try {
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(f.prepared.close).toHaveBeenCalledOnce();
    expect(f.ready).not.toHaveBeenCalled();
    expect(f.prepared.activate).not.toHaveBeenCalled();
  } finally {
    await f.scheduler.close();
    vi.useRealTimers();
  }
});

test("preferences survive recreation without status writes re-enabling automatic updates", async () => {
  const home = await mkdtemp(join(tmpdir(), "inbot-update-state-"));
  try {
    const state = updateState(home, "0.1.0", true);
    expect(await state.read()).toMatchObject({ enabled: true, last_result: "never_checked" });
    await state.configure({ enabled: false });
    await state.record({
      last_check: "2026-10-14T10:00:00Z",
      latest: "0.2.0",
      last_result: "failed",
      error: { message: "Synthetic failure", fix: "Retry" },
    });
    expect(await updateState(home, "0.2.0", false).read()).toMatchObject({
      enabled: false,
      current: "0.2.0",
      eligible: false,
      last_result: "failed",
    });
    expect(JSON.parse(await readFile(join(home, "updates.json"), "utf8"))).toEqual({
      enabled: false,
    });
    await writeFile(join(home, "updates.json"), "corrupted");
    await expect(state.read()).rejects.toThrow();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("service shutdown cancels an in-flight release request", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const observed = Promise.withResolvers<AbortSignal>();
  const scheduler = updateScheduler({
    state: f.state,
    check: (signal) =>
      new Promise((_, reject) => {
        observed.resolve(signal);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    prepare: f.prepare,
    ready: f.ready,
    random: () => 0,
  });
  try {
    scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    const signal = await observed.promise;
    await scheduler.close();
    expect(signal.aborted).toBe(true);
    expect(f.ready).not.toHaveBeenCalled();
  } finally {
    await scheduler.close();
    vi.useRealTimers();
  }
});
