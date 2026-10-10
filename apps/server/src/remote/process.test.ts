import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, test as base, vi } from "vitest";
import { spawnConnector } from "./process.js";

const state = vi.hoisted(() => ({
  args: [] as string[],
  options: {} as { shell?: boolean; stdio?: string[]; env?: Record<string, string | undefined> },
  killed: [] as string[],
  exitOn: "SIGTERM",
  emit: (_event: string) => {},
  log: (_chunk: string) => {},
  spawnError: false,
  spawnThrows: false,
}));
vi.mock("node:child_process", () => ({
  spawn: (_binary: string, args: string[], options: typeof state.options) => {
    state.args = args;
    state.options = options;
    if (state.spawnThrows) throw new Error("Synthetic synchronous spawn failure");
    const child = new EventEmitter();
    const stderr = new PassThrough();
    state.log = (chunk) => {
      stderr.write(chunk);
    };
    state.emit = (event) => {
      child.emit(event);
    };
    queueMicrotask(() =>
      state.spawnError
        ? child.emit("error", new Error("Synthetic spawn failure"))
        : child.emit("spawn"),
    );
    return Object.assign(child, {
      pid: 1234,
      stderr,
      kill: (signal: string) => {
        state.killed.push(signal);
        if (signal === state.exitOn) {
          child.emit("exit");
          child.emit("close");
        }
        return true;
      },
    });
  },
}));

const test = base.extend<{ binary: string }>({
  binary: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-connector-process-"));
    state.killed = [];
    state.exitOn = "SIGTERM";
    state.spawnError = false;
    state.spawnThrows = false;
    try {
      await use(join(home, "cloudflared"));
    } finally {
      state.emit("close");
      vi.unstubAllGlobals();
      vi.useRealTimers();
      await rm(home, { recursive: true, force: true });
    }
  },
});
const announceMetrics = (address = "127.0.0.1:3456") => {
  state.log(
    `${JSON.stringify({ level: "info", message: `Starting metrics server on ${address}/metrics` })}\n`,
  );
};

test("process adapter uses a private token file and terminates only its own child", async ({
  binary,
}) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  try {
    const process = await spawnConnector(binary, "synthetic-secret");
    expect(process.pid).toBe(1234);
    const tokenFile = state.args.at(-1);
    if (tokenFile === undefined) throw new Error("Expected a token file");
    expect(state.args).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--output",
      "json",
      "--metrics",
      "127.0.0.1:0",
      "run",
      "--token-file",
      tokenFile,
    ]);
    expect(dirname(dirname(tokenFile))).toBe(dirname(binary));
    expect(await readFile(tokenFile, "utf8")).toBe("synthetic-secret");
    if (globalThis.process.platform !== "win32") {
      expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(tokenFile))).mode & 0o777).toBe(0o700);
    }
    expect(state.args.join(" ")).not.toContain("synthetic-secret");
    expect(state.options).toMatchObject({
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    expect(
      Object.keys(state.options.env ?? {}).every((key) => ["PATH", "SystemRoot"].includes(key)),
    ).toBe(true);
    expect(await process.ready()).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    announceMetrics();
    expect(await process.ready()).toBe(true);
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3456/ready");
    await process.stop();
    expect(await readdir(dirname(binary))).toEqual([]);
    expect(state.killed).toEqual(["SIGTERM"]);
    expect(process.exited()).toBe(true);
    expect(await process.ready()).toBe(false);
    await process.stop();
    expect(state.killed).toEqual(["SIGTERM"]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("readiness trusts only a complete loopback port announcement from the child", async ({
  binary,
}) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetcher);
  const child = await spawnConnector(binary, "synthetic-secret");
  for (const address of ["127.0.0.1:0", "127.0.0.1:65536", "0.0.0.0:3456", "evil.test:3456"])
    announceMetrics(address);
  state.log("not JSON\n");
  state.log("x".repeat(9000));
  state.log("\n");
  expect(await child.ready()).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
  const line = JSON.stringify({ message: "Starting metrics server on 127.0.0.1:4567/metrics" });
  state.log(line.slice(0, 20));
  state.log(line.slice(20));
  expect(await child.ready()).toBe(false);
  state.log("\n");
  expect(await child.ready()).toBe(false);
  expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4567/ready");
  fetcher.mockImplementation(async () => {
    state.emit("exit");
    state.emit("close");
    return new Response(null);
  });
  expect(await child.ready()).toBe(false);
  await child.stop();
  expect(await readdir(dirname(binary))).toEqual([]);
});

test("spawn failures remove credentials before propagating the error", async ({ binary }) => {
  for (const synchronous of [false, true]) {
    state.spawnError = !synchronous;
    state.spawnThrows = synchronous;
    await expect(spawnConnector(binary, "synthetic-secret")).rejects.toThrow(/spawn failure/);
    expect(await readdir(dirname(binary))).toEqual([]);
  }
});

test("stubborn child is force-stopped after the bounded grace period", async ({ binary }) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  state.killed = [];
  state.exitOn = "SIGKILL";
  try {
    const child = await spawnConnector(binary, "synthetic-secret");
    const stopped = child.stop();
    await vi.advanceTimersByTimeAsync(4999);
    expect(state.killed).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    expect(state.killed).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.exited()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    state.exitOn = "SIGTERM";
    vi.useRealTimers();
  }
});

test("unconfirmed process stop fails instead of hanging shutdown indefinitely", async ({
  binary,
}) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  state.killed = [];
  state.exitOn = "never";
  try {
    const child = await spawnConnector(binary, "synthetic-secret");
    const stopped = expect(child.stop()).rejects.toThrow("Connector stop was not confirmed");
    await vi.advanceTimersByTimeAsync(10_000);
    await stopped;
    expect(state.killed).toEqual(["SIGTERM", "SIGKILL"]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    state.emit("close");
    state.exitOn = "SIGTERM";
    vi.useRealTimers();
  }
});
