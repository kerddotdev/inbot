import { UpdateError } from "./errors.js";
import type { UpdateState } from "./state.js";

export interface PreparedUpdate {
  readonly destination: string;
  activate(): Promise<void>;
  close(): Promise<void>;
}

export function updateScheduler(input: {
  state: UpdateState;
  check(signal: AbortSignal): Promise<{ latest: string; update_available: boolean }>;
  prepare(version: string, signal: AbortSignal): Promise<PreparedUpdate>;
  ready(update: PreparedUpdate): void;
  now?: () => number;
  random?: () => number;
}) {
  const now = input.now ?? Date.now;
  const random = input.random ?? Math.random;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let closed = false;
  let handedOff = false;
  const schedule = (initial: boolean) => {
    if (closed || handedOff) return;
    timer = setTimeout(
      () => {
        pending = check()
          .catch(() => {
            process.stderr.write(
              "Automatic update cleanup failed. Inspect installation permissions and the update lock.\n",
            );
          })
          .finally(() => {
            pending = undefined;
            schedule(false);
          });
      },
      initial ? 30_000 + random() * 30_000 : (3.5 + random() * 0.5) * 60 * 60_000,
    );
    timer.unref();
  };
  const check = async () => {
    let prepared: PreparedUpdate | undefined;
    let checkedAt: string | null = null;
    let latest: string | null = null;
    try {
      const status = await input.state.read();
      if (!status.eligible || !status.enabled || closed) return;
      checkedAt = new Date(now()).toISOString();
      latest = status.latest;
      await input.state.record({
        last_check: checkedAt,
        latest,
        last_result: "checking",
        error: null,
      });
      const result = await input.check(abort.signal);
      latest = result.latest;
      await input.state.record({
        last_check: checkedAt,
        latest,
        last_result: result.update_available ? "available" : "up_to_date",
        error: null,
      });
      if (!result.update_available || closed || !(await input.state.read()).enabled) return;
      prepared = await input.prepare(latest, abort.signal);
      if (closed || !(await input.state.read()).enabled) return;
      await input.state.record({
        last_check: checkedAt,
        latest,
        last_result: "ready",
        error: null,
      });
      input.ready(prepared);
      handedOff = true;
      prepared = undefined;
    } catch (error) {
      const failure =
        error instanceof UpdateError ? error : new UpdateError("Automatic update failed.");
      await input.state
        .record({
          last_check: checkedAt,
          latest,
          last_result: "failed",
          error: { message: failure.message, fix: failure.fix },
        })
        .catch(() => {});
    } finally {
      await prepared?.close();
    }
  };
  return {
    start() {
      if (!timer && !pending && !closed) schedule(true);
    },
    async close() {
      closed = true;
      abort.abort();
      clearTimeout(timer);
      await pending;
    },
  };
}
