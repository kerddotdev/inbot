import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { localServiceRuntime, makeService, runCommand } from "../../../cli/src/service.js";
import { packageVersion } from "../../../cli/src/version.js";
import { detectLayout } from "./layout.js";
import { checkRelease } from "./release.js";
import { prepareUpdate } from "./install.js";
import { updateScheduler, type PreparedUpdate } from "./scheduler.js";
import { updateState, type UpdateState } from "./state.js";
import { UpdateError } from "./errors.js";

export async function automaticUpdates(home: string, stop: () => void) {
  const current = await packageVersion();
  const managed = process.env.INBOT_SERVICE_HOME === home && process.send !== undefined;
  const layout = managed
    ? await detectLayout({
        executable: process.execPath,
        cli: fileURLToPath(new URL("../../../cli/src/main.js", import.meta.url)),
        platform: process.platform,
        arch: process.arch,
        userHome: homedir(),
        ...(process.env.PATH === undefined ? {} : { path: process.env.PATH }),
      }).catch(() => undefined)
    : undefined;
  const service =
    managed && layout ? await makeService(await localServiceRuntime(), home).status() : undefined;
  const eligible =
    layout !== undefined && service?.installed === true && service.registered === true;
  const state = updateState(home, current, eligible);
  return manageAutomaticUpdates(
    state,
    stop,
    eligible && layout
      ? {
          check: (signal) => checkRelease(current, undefined, fetch, signal),
          prepare: (version, signal) => prepareUpdate(layout, version, runCommand, fetch, signal),
        }
      : undefined,
  );
}

export function manageAutomaticUpdates(
  state: UpdateState,
  stop: () => void,
  operations?: Pick<Parameters<typeof updateScheduler>[0], "check" | "prepare" | "random">,
) {
  let prepared: PreparedUpdate | undefined;
  const scheduler = operations
    ? updateScheduler({
        ...operations,
        state,
        ready: (update) => {
          prepared = update;
          stop();
        },
      })
    : undefined;
  return {
    state,
    async start() {
      try {
        const previous = await state.read();
        if (previous.eligible && previous.last_result === "restarting") {
          await state.record({
            ...previous,
            last_result: previous.latest === previous.current ? "updated" : "failed",
            error:
              previous.latest === previous.current
                ? null
                : {
                    message: "The service did not start the selected update.",
                    fix: "Inspect the service logs and run inbot service install with the same --home.",
                  },
          });
        }
        if (
          previous.eligible &&
          ["checking", "available", "ready"].includes(previous.last_result)
        ) {
          await state.record({
            ...previous,
            last_result: "failed",
            error: {
              message: "The previous update was interrupted before activation.",
              fix: "Inspect service logs and any install-root update lock before retrying.",
            },
          });
        }
      } catch {
        await state
          .record({
            last_check: null,
            latest: null,
            last_result: "failed",
            error: {
              message: "Saved update state could not be read.",
              fix: "Check home permissions and use inbot update --auto off to repair the preference before re-enabling updates.",
            },
          })
          .catch(() => {
            process.stderr.write(
              "Update state is unavailable. Check the home permissions; mail service startup will continue.\n",
            );
          });
      }
      scheduler?.start();
    },
    async close() {
      await scheduler?.close();
    },
    async abort() {
      await scheduler?.close();
      if (prepared) {
        try {
          const status = await state.read();
          await state.record({
            ...status,
            last_result: "failed",
            error: {
              message: "The server did not shut down cleanly. The update was not activated.",
              fix: "Inspect the service logs before retrying the update.",
            },
          });
        } finally {
          await prepared.close();
          prepared = undefined;
        }
      }
    },
    async applyAfterShutdown() {
      if (!prepared) return false;
      try {
        const status = await state.read();
        if (!status.enabled) return true;
        await state.record({ ...status, last_result: "restarting", error: null });
        await prepared.activate();
        return true;
      } catch (error) {
        const failure =
          error instanceof UpdateError
            ? error
            : new UpdateError("Cannot activate the automatic update.");
        const status = await state.read();
        await state.record({
          ...status,
          last_result: "failed",
          error: { message: failure.message, fix: failure.fix },
        });
        return true;
      } finally {
        await prepared.close();
      }
    },
  };
}
