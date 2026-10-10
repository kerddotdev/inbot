import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ConnectorProcess {
  readonly pid: number;
  readonly exited: () => boolean;
  readonly ready: () => Promise<boolean>;
  readonly stop: () => Promise<void>;
}
export type ProcessSpawner = (binary: string, token: string) => Promise<ConnectorProcess>;

export const spawnConnector: ProcessSpawner = async (binary, token) => {
  const credentials = await mkdtemp(join(dirname(binary), "connector-"));
  const tokenFile = join(credentials, "token");
  try {
    await writeFile(tokenFile, token, { mode: 0o600, flag: "wx" });
  } catch (error) {
    await rm(credentials, { recursive: true, force: true });
    throw error;
  }
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      binary,
      [
        "tunnel",
        "--no-autoupdate",
        "--output",
        "json",
        "--metrics",
        "127.0.0.1:0",
        "run",
        "--token-file",
        tokenFile,
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
          ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
        },
      },
    );
  } catch (error) {
    await rm(credentials, { recursive: true, force: true });
    throw error;
  }
  let metrics: string | undefined;
  let pending = "";
  let oversized = false;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const part of chunk.split(/(?<=\n)/)) {
      if (!oversized) {
        pending += part;
        if (pending.length > 8192) {
          pending = "";
          oversized = true;
        }
      }
      if (!part.endsWith("\n")) continue;
      if (!oversized && metrics === undefined) {
        try {
          const log: unknown = JSON.parse(pending);
          if (
            typeof log === "object" &&
            log !== null &&
            "message" in log &&
            typeof log.message === "string"
          ) {
            const match = log.message.match(
              /^Starting metrics server on (127\.0\.0\.1:([0-9]+))\/metrics$/,
            );
            const port = Number(match?.[2]);
            if (match !== null && port > 0 && port <= 65535) metrics = match[1];
          }
        } catch {
          /* Discard all other connector output. */
        }
      }
      pending = "";
      oversized = false;
    }
  });
  let exited = false;
  const closed = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
    });
    child.once("close", () => {
      exited = true;
      resolve();
    });
    child.once("error", () => {
      exited = true;
      resolve();
    });
  }).then(() => rm(credentials, { recursive: true, force: true }));
  void closed.catch(() => {});
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (error) {
    await closed;
    throw error;
  }
  if (child.pid === undefined) throw new Error("No connector PID");
  return {
    pid: child.pid,
    exited: () => exited,
    ready: async () => {
      if (exited || metrics === undefined) return false;
      try {
        return (
          (
            await fetch(`http://${metrics}/ready`, {
              signal: AbortSignal.timeout(2000),
              redirect: "error",
            })
          ).ok && !exited
        );
      } catch {
        return false;
      }
    },
    stop: async () => {
      if (!exited) child.kill("SIGTERM");
      let forced: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        forced = setTimeout(() => {
          if (!exited) child.kill("SIGKILL");
        }, 5000);
        deadline = setTimeout(() => reject(new Error("Connector stop was not confirmed")), 10_000);
      });
      try {
        await Promise.race([closed, timeout]);
      } finally {
        clearTimeout(forced);
        clearTimeout(deadline);
      }
    },
  };
};
