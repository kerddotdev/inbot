import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

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
if (!["darwin-arm64", "linux-x64", "linux-arm64", "darwin-x64"].includes(target))
  throw new Error(`Unsupported smoke host: ${target}`);
const archive = `inbot-${version}-${target}.tar.gz`;
const sums = await readFile(join(directory, "SHA256SUMS"), "utf8");
const expected = sums
  .split("\n")
  .find((line) => line.endsWith(`  ${archive}`))
  ?.split(" ")[0];
assert.equal(
  createHash("sha256")
    .update(await readFile(join(directory, archive)))
    .digest("hex"),
  expected,
);
const temporary = await mkdtemp(join(tmpdir(), "inbot-smoke-"));
let child;
let exited;
let output = "";
let failure = "";
let ready = false;
try {
  await exec("tar", ["-xzf", join(directory, archive), "-C", temporary]);
  const bundle = join(temporary, "inbot");
  const launcher = join(bundle, "inbot");
  const home = join(temporary, "home");
  const help = await exec(launcher, ["--help"], { env: { ...bundledEnv, INBOT_HOME: home } });
  assert.match(help.stdout, /Usage: inbot/);
  const node = join(bundle, "runtime/bin/node");
  assert.equal((await exec(node, ["--version"], { env: bundledEnv })).stdout.trim(), "v24.21.0");
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
    launcher,
    ["serve", "--init", "--home", home, "--port", "0", "--flavor", "development"],
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
  const status = JSON.parse(
    (await exec("curl", ["--fail", "--silent", "--show-error", `${url}/v0/owner/status`])).stdout,
  );
  assert.equal(status.setup_required, true);
  assert.equal(status.locked, false);
  const web = (await exec("curl", ["--fail", "--silent", "--show-error", url])).stdout;
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
      assert.ok(result, "Server did not stop gracefully.");
      if (ready) assert.equal(result.code, 0, `Unclean server shutdown: ${failure}`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
console.log(
  `Smoke passed: ${archive}, Node, native addon imports, Worker bundle, owner status, bundled web UI and graceful PID shutdown.`,
);
