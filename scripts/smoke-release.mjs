import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { verifyReleaseChecksum } from "./release-checksum.mjs";

const exec = promisify(execFile);
const directory = resolve(process.argv[2] ?? "dist-release");
const version = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;
const target = process.env.INBOT_SMOKE_TARGET ?? `${process.platform}-${process.arch}`;
const qemuPrefix = process.env.INBOT_SMOKE_QEMU_PREFIX;
const bundledEnv = {
  ...process.env,
  ...(qemuPrefix ? { QEMU_LD_PREFIX: qemuPrefix, LD_LIBRARY_PATH: join(qemuPrefix, "lib") } : {}),
};
if (
  !["darwin-arm64", "linux-x64", "linux-arm64", "darwin-x64", "win32-x64", "win32-arm64"].includes(
    target,
  )
)
  throw new Error(`Unsupported smoke host: ${target}`);
const windows = target.startsWith("win32-");
if (windows && process.platform !== "win32")
  throw new Error("Windows smoke requires a Windows host.");
const archive = `inbot-${version}-${target}.${windows ? "zip" : "tar.gz"}`;
const sums = await readFile(join(directory, "SHA256SUMS"), "utf8");
verifyReleaseChecksum(await readFile(join(directory, archive)), sums, archive);
const temporary = await mkdtemp(join(tmpdir(), "inbot-smoke-"));
let child;
let exited;
let output = "";
let failure = "";
let ready = false;
try {
  await exec(windows ? "tar.exe" : "tar", [
    windows ? "-xf" : "-xzf",
    join(directory, archive),
    "-C",
    temporary,
  ]);
  const bundle = join(temporary, "inbot");
  const launcher = join(bundle, windows ? "inbot.cmd" : "inbot");
  const home = join(temporary, "home");
  const helpEnv = { ...bundledEnv, INBOT_HOME: home, INBOT_TEST_SHIM: launcher };
  const help = windows
    ? await exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "& $env:INBOT_TEST_SHIM --help; exit $LASTEXITCODE",
        ],
        { env: helpEnv },
      )
    : await exec(launcher, ["--help"], { env: helpEnv });
  assert.match(help.stdout, /Usage: inbot/);
  const node = join(bundle, windows ? "runtime/node.exe" : "runtime/bin/node");
  assert.equal((await exec(node, ["--version"], { env: bundledEnv })).stdout.trim(), "v24.21.0");
  if (windows)
    assert.equal(
      (await exec(node, ["-p", "process.arch"], { env: bundledEnv })).stdout.trim(),
      target.slice("win32-".length),
    );
  await exec(
    node,
    [
      "--input-type=module",
      "-e",
      'import keyring from "@napi-rs/keyring"; if (typeof keyring.Entry !== "function") throw new Error("Missing keyring prebuild");',
    ],
    { cwd: join(bundle, "application"), env: bundledEnv },
  );
  assert.ok((await readFile(join(bundle, "application/dist/worker/inbound.js"))).length > 0);
  child = spawn(
    windows ? node : launcher,
    [
      ...(windows ? [join(bundle, "application/dist/apps/cli/src/main.js")] : []),
      "serve",
      "--init",
      "--home",
      home,
      "--port",
      "0",
      "--flavor",
      "development",
    ],
    {
      env: { ...bundledEnv, INBOT_TEST_MEMORY_KEYCHAIN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  exited = new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => done({ code, signal }));
  });
  child.stdout.on("data", (data) => {
    output += data.toString();
  });
  child.stderr.on("data", (data) => {
    failure += data.toString();
  });
  const url = await new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Startup timed out: ${failure}`)), 30_000);
    const listener = () => {
      for (const line of output.split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event.event === "server.ready") {
            clearTimeout(timeout);
            child.stdout.off("data", listener);
            done(event.url);
          }
        } catch {}
      }
    };
    child.stdout.on("data", listener);
    void exited.then(() => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before readiness: ${failure}`));
    }, reject);
    listener();
  });
  ready = true;
  const get = async (address) => {
    if (!windows)
      return (await exec("curl", ["--fail", "--silent", "--show-error", address])).stdout;
    const response = await fetch(address, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    return response.text();
  };
  const status = JSON.parse(await get(`${url}/v0/owner/status`));
  assert.equal(status.setup_required, true);
  assert.equal(status.locked, false);
  const web = await get(url);
  assert.match(web, /<div id="root">/);
} finally {
  try {
    if (child && exited) {
      child.kill("SIGTERM");
      let timeout;
      const result = await Promise.race([
        exited,
        new Promise((done) => {
          timeout = setTimeout(() => {
            child.kill("SIGKILL");
            done(undefined);
          }, 10_000);
        }),
      ]);
      clearTimeout(timeout);
      await exited;
      assert.ok(result, "Server did not stop before the shutdown timeout.");
      // Windows terminates the captured Node PID without delivering a POSIX shutdown signal.
      if (ready && !windows) assert.equal(result.code, 0, `Unclean server shutdown: ${failure}`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
console.log(
  `Smoke passed: ${archive}, Node, native addon imports, Worker bundle, owner status, bundled web UI and ${windows ? "captured PID termination" : "graceful PID shutdown"}.`,
);
