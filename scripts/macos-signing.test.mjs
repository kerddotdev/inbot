import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { verifyReleaseChecksum } from "./release-checksum.mjs";

const run = promisify(execFile);
const release = process.env.INBOT_TEST_SIGNED_RELEASE_DIR;

test(
  "signed macOS archives verify with hardened Node, validated addons and updated checksums",
  {
    skip: process.platform !== "darwin" || !release,
  },
  async () => {
    const directory = resolve(release);
    const sums = await readFile(join(directory, "SHA256SUMS"), "utf8");
    const archives = (await readdir(directory)).filter((name) =>
      /-darwin-(arm64|x64)\.tar\.gz$/.test(name),
    );
    assert.ok(archives.length > 0);
    for (const archive of archives) {
      verifyReleaseChecksum(await readFile(join(directory, archive)), sums, archive);
      const temporary = await mkdtemp(join(tmpdir(), "inbot-signed-test-"));
      try {
        await run("tar", ["-xzf", join(directory, archive), "-C", temporary]);
        const entries = (await run("tar", ["-tzf", join(directory, archive)])).stdout.split("\n");
        const binaries = entries.filter(
          (entry) => entry.endsWith(".node") || entry === "inbot/runtime/bin/node",
        );
        assert.ok(binaries.length >= 3);
        for (const entry of binaries) {
          const path = join(temporary, entry);
          await run("codesign", ["--verify", "--strict", "--deep", path]);
          const details = (await run("codesign", ["--display", "--verbose=4", path])).stderr;
          assert.match(details, /Authority=Developer ID Application:/);
          assert.match(details, /flags=.*runtime/);
          assert.match(details, /Timestamp=/);
          const { stdout } = await run("codesign", ["--display", "--entitlements", ":-", path]);
          if (entry === "inbot/runtime/bin/node") {
            assert.match(stdout, /com\.apple\.security\.cs\.allow-jit/);
            assert.match(stdout, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
          }
          assert.doesNotMatch(
            stdout,
            /disable-library-validation|get-task-allow|disable-executable-page-protection/,
          );
        }
        const addon = binaries.find((entry) => entry.endsWith(".node"));
        await appendFile(join(temporary, addon), "tampered");
        await assert.rejects(
          run("codesign", ["--verify", "--strict", "--deep", join(temporary, addon)]),
        );
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  },
);
