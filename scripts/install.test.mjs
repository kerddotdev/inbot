import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = `${process.platform}-${process.arch}`;
const supported = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].includes(target);

test(
  "installer verifies HTTP assets, installs through a shim, upgrades and refuses changed checksums",
  { skip: !supported },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "inbot-installer-"));
    const release = join(temporary, "release");
    const installRoot = join(temporary, "installed app");
    const bin = join(temporary, "bin");
    const bundle = join(temporary, "inbot");
    const server = createServer(async (request, response) => {
      try {
        const filename = request.url?.slice(1);
        if (!filename || filename.includes("/")) throw new Error("Unknown asset");
        response.end(await readFile(join(release, filename)));
      } catch {
        response.writeHead(404).end();
      }
    });
    try {
      await mkdir(release);
      await mkdir(join(bundle, "runtime/bin"), { recursive: true });
      await mkdir(join(bundle, "application/dist/apps/cli/src"), { recursive: true });
      await writeFile(join(bundle, "inbot"), '#!/bin/sh\nprintf "fixture launcher: %s\\n" "$*"\n');
      await chmod(join(bundle, "inbot"), 0o755);
      await writeFile(join(bundle, "runtime/bin/node"), "#!/bin/sh\nexit 0\n");
      await chmod(join(bundle, "runtime/bin/node"), 0o755);
      await writeFile(join(bundle, "application/dist/apps/cli/src/main.js"), "");
      const checksums = [];
      for (const version of ["0.1.0", "0.1.1"]) {
        const filename = `inbot-${version}-${target}.tar.gz`;
        await exec("tar", ["-czf", join(release, filename), "-C", temporary, "inbot"]);
        checksums.push(
          `${createHash("sha256")
            .update(await readFile(join(release, filename)))
            .digest("hex")}  ${filename}\n`,
        );
      }
      await writeFile(join(release, "SHA256SUMS"), checksums.join(""));
      await new Promise((done, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", done);
      });
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const env = {
        ...process.env,
        INBOT_INSTALL_ROOT: installRoot,
        INBOT_BIN_DIR: bin,
        INBOT_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
      };
      const install = (version) =>
        exec("sh", [join(root, "install.sh"), "--version", version], { env });
      await install("0.1.0");
      await install("0.1.0");
      assert.match((await exec(join(bin, "inbot"), ["--help"])).stdout, /fixture launcher: --help/);
      await install("0.1.1");
      assert.match(await readFile(join(bin, "inbot"), "utf8"), /app\/0\.1\.1\/inbot/);
      assert.deepEqual((await readdir(join(installRoot, "app"))).sort(), ["0.1.0", "0.1.1"]);
      const originalShim = await readFile(join(bin, "inbot"));
      await writeFile(
        join(release, "SHA256SUMS"),
        `${"0".repeat(64)}  inbot-0.1.1-${target}.tar.gz\n`,
      );
      await assert.rejects(install("0.1.1"), (error) => /SHA-256 mismatch/.test(error.stderr));
      assert.deepEqual(await readFile(join(bin, "inbot")), originalShim);
      await assert.rejects(install("../../escape"), (error) =>
        /Invalid release version/.test(error.stderr),
      );
    } finally {
      await new Promise((done) => server.close(done));
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

test(
  "installer uses the actual packaged archive from a local release directory",
  { skip: !process.env.INBOT_TEST_RELEASE_DIR || !supported },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "inbot-install-archive-"));
    try {
      const release = join(temporary, "release");
      await mkdir(release);
      const version = JSON.parse(await readFile(join(root, "package.json"))).version;
      for (const filename of ["SHA256SUMS", `inbot-${version}-${target}.tar.gz`])
        await cp(join(process.env.INBOT_TEST_RELEASE_DIR, filename), join(release, filename));
      const env = {
        ...process.env,
        INBOT_INSTALL_ROOT: join(temporary, "app"),
        INBOT_BIN_DIR: join(temporary, "bin"),
        INBOT_RELEASE_BASE_URL: pathToFileURL(release).href,
      };
      await exec("sh", [join(root, "install.sh"), "--version", version], { env });
      const help = await exec(join(temporary, "bin/inbot"), ["--help"], {
        env: { ...process.env, INBOT_HOME: join(temporary, "home") },
      });
      assert.match(help.stdout, /Usage: inbot/);
      const shim = await readFile(join(temporary, "bin/inbot"));
      await writeFile(
        join(release, "SHA256SUMS"),
        `${"0".repeat(64)}  inbot-${version}-${target}.tar.gz\n`,
      );
      await assert.rejects(
        exec("sh", [join(root, "install.sh"), "--version", version], { env }),
        (error) => /SHA-256 mismatch/.test(error.stderr),
      );
      assert.deepEqual(await readFile(join(temporary, "bin/inbot")), shim);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
