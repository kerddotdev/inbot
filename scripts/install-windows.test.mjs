import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const windows = process.platform === "win32";
const architecture = windows
  ? (
      await powershell(
        "[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()",
      )
    ).stdout.trim()
  : undefined;
const target = `win32-${architecture}`;

function powershell(command, env = process.env) {
  return exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { env });
}

function install(version, env) {
  return exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(root, "install.ps1"),
      "-Version",
      version,
      "-NoPathUpdate",
    ],
    { env },
  );
}

function runShim(argument, env) {
  assert.ok(["--help", "--version"].includes(argument));
  return powershell(`& $env:INBOT_TEST_SHIM ${argument}; exit $LASTEXITCODE`, env);
}

function installEnv(temporary, release) {
  return {
    ...process.env,
    INBOT_HOME: join(temporary, "home"),
    INBOT_TEST_MEMORY_KEYCHAIN: "1",
    INBOT_INSTALL_ROOT: join(temporary, "installed app"),
    INBOT_BIN_DIR: join(temporary, "command bin"),
    INBOT_RELEASE_BASE_URL: pathToFileURL(release).href,
    INBOT_TEST_SHIM: join(temporary, "command bin/inbot.cmd"),
  };
}

test(
  "PowerShell installer verifies local assets, reinstalls, upgrades and refuses changed checksums",
  { skip: !windows },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "inbot-windows-installer-"));
    try {
      const release = join(temporary, "local release");
      const bundle = join(temporary, "inbot");
      const entry = join(bundle, "application/dist/apps/cli/src/main.js");
      await mkdir(release);
      await mkdir(join(bundle, "runtime"), { recursive: true });
      await mkdir(join(bundle, "application/dist/apps/cli/src"), { recursive: true });
      const sqlite = join(bundle, "application/node_modules/better-sqlite3-multiple-ciphers");
      const keyring = join(bundle, "application/node_modules/@napi-rs/keyring");
      await mkdir(sqlite, { recursive: true });
      await mkdir(keyring, { recursive: true });
      await writeFile(join(keyring, "index.js"), "module.exports = {};\n");
      await cp(process.execPath, join(bundle, "runtime/node.exe"));
      await writeFile(
        join(bundle, "inbot.cmd"),
        '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0application\\dist\\apps\\cli\\src\\main.js" %*\r\nexit /b %errorlevel%\r\n',
      );
      const sums = [];
      for (const version of ["0.1.0", "0.1.1", "0.1.2"]) {
        await writeFile(
          join(sqlite, "index.js"),
          version === "0.1.2"
            ? 'throw new Error("The specified module could not be found: VCRUNTIME140.dll");\n'
            : "module.exports = class { close() {} };\n",
        );
        await writeFile(
          entry,
          `console.log(process.argv[2] === "--version" ? "${version}" : "Usage: inbot fixture");\n`,
        );
        const archive = `inbot-${version}-${target}.zip`;
        await powershell(
          "Compress-Archive -LiteralPath $env:INBOT_TEST_BUNDLE -DestinationPath $env:INBOT_TEST_ARCHIVE",
          {
            ...process.env,
            INBOT_TEST_BUNDLE: bundle,
            INBOT_TEST_ARCHIVE: join(release, archive),
          },
        );
        sums.push(
          `${createHash("sha256")
            .update(await readFile(join(release, archive)))
            .digest("hex")}  ${archive}\n`,
        );
      }
      await writeFile(join(release, "SHA256SUMS"), sums.join(""));
      const env = installEnv(temporary, release);
      const first = await install("0.1.0", env);
      assert.match(first.stdout, /PATH was not changed/);
      assert.equal((await runShim("--version", env)).stdout.trim(), "0.1.0");
      await install("0.1.0", env);
      assert.match((await runShim("--help", env)).stdout, /Usage: inbot fixture/);
      await install("0.1.1", env);
      assert.equal((await runShim("--version", env)).stdout.trim(), "0.1.1");
      assert.deepEqual((await readdir(join(env.INBOT_INSTALL_ROOT, "app"))).sort(), [
        "0.1.0",
        "0.1.1",
      ]);
      const shim = await readFile(env.INBOT_TEST_SHIM);
      await assert.rejects(
        install("0.1.2", env),
        (error) =>
          /Microsoft Visual C\+\+ v14 Redistributable/.test(error.stderr) &&
          error.stderr.includes(`https://aka.ms/vc14/vc_redist.${architecture}.exe`),
      );
      assert.deepEqual(await readFile(env.INBOT_TEST_SHIM), shim);
      assert.deepEqual((await readdir(join(env.INBOT_INSTALL_ROOT, "app"))).sort(), [
        "0.1.0",
        "0.1.1",
      ]);
      await writeFile(
        join(release, "SHA256SUMS"),
        `${"0".repeat(64)}  inbot-0.1.1-${target}.zip\n`,
      );
      await assert.rejects(install("0.1.1", env), (error) => /SHA-256 mismatch/.test(error.stderr));
      assert.deepEqual(await readFile(env.INBOT_TEST_SHIM), shim);
      assert.equal((await runShim("--version", env)).stdout.trim(), "0.1.1");
      await assert.rejects(install("../../escape", env), (error) =>
        /Invalid release version/.test(error.stderr),
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

test(
  "PowerShell installer runs the actual packaged archive from a local release directory",
  {
    skip: !windows || !process.env.INBOT_TEST_RELEASE_DIR,
  },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "inbot-windows-install-archive-"));
    try {
      const release = join(temporary, "local release");
      await mkdir(release);
      const version = JSON.parse(await readFile(join(root, "package.json"))).version;
      const archive = `inbot-${version}-${target}.zip`;
      for (const filename of ["SHA256SUMS", archive])
        await cp(
          join(resolve(process.env.INBOT_TEST_RELEASE_DIR), filename),
          join(release, filename),
        );
      const env = installEnv(temporary, release);
      await install(version, env);
      assert.equal((await runShim("--version", env)).stdout.trim(), version);
      assert.match((await runShim("--help", env)).stdout, /Usage: inbot/);
      const shim = await readFile(env.INBOT_TEST_SHIM);
      await install(version, env);
      assert.deepEqual(await readFile(env.INBOT_TEST_SHIM), shim);
      assert.equal((await runShim("--version", env)).stdout.trim(), version);
      await writeFile(join(release, "SHA256SUMS"), `${"0".repeat(64)}  ${archive}\n`);
      await assert.rejects(install(version, env), (error) => /SHA-256 mismatch/.test(error.stderr));
      assert.deepEqual(await readFile(env.INBOT_TEST_SHIM), shim);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
