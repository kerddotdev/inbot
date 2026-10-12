import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  releaseTargets,
  verifyReleaseChecksum,
  writeReleaseChecksums,
} from "./release-checksum.mjs";

const bytes = Buffer.from("release fixture");
const checksum = createHash("sha256").update(bytes).digest("hex");
const archive = "inbot-0.1.0-win32-arm64.zip";

test("release checksum accepts Windows line endings and selects the exact archive", () => {
  verifyReleaseChecksum(
    bytes,
    `${"0".repeat(64)}  other.zip\r\n${checksum.toUpperCase()}  ${archive}\r\n`,
    archive,
  );
});

test("final checksums replace unsigned digests and require all six publication assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inbot-checksums-"));
  try {
    await writeFile(join(directory, archive), bytes);
    await writeReleaseChecksums(directory, "0.1.0");
    verifyReleaseChecksum(bytes, await readFile(join(directory, "SHA256SUMS"), "utf8"), archive);
    await assert.rejects(writeReleaseChecksums(directory, "0.1.0", true), /Incomplete/);
    for (const target of releaseTargets) {
      const name = `inbot-0.1.0-${target}.${target.startsWith("win32-") ? "zip" : "tar.gz"}`;
      await writeFile(join(directory, name), `signed ${target}`);
    }
    await writeFile(join(directory, "inbot-0.0.9-darwin-arm64.tar.gz"), "old release");
    await writeReleaseChecksums(directory, "0.1.0", true);
    const sums = await readFile(join(directory, "SHA256SUMS"), "utf8");
    assert.equal(sums.trim().split("\n").length, 6);
    assert.doesNotMatch(sums, /0\.0\.9/);
    for (const target of releaseTargets) {
      const name = `inbot-0.1.0-${target}.${target.startsWith("win32-") ? "zip" : "tar.gz"}`;
      verifyReleaseChecksum(await readFile(join(directory, name)), sums, name);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release checksum refuses missing, duplicate, malformed and changed assets", () => {
  const line = `${checksum}  ${archive}\n`;
  for (const sums of ["", line + line, `invalid  ${archive}\n`])
    assert.throws(() => verifyReleaseChecksum(bytes, sums, archive), /checksum/);
  assert.throws(
    () => verifyReleaseChecksum(Buffer.from("changed release"), line, archive),
    /SHA-256 mismatch/,
  );
});
