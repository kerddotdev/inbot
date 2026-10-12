import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { verifyReleaseChecksum } from "./release-checksum.mjs";

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

test("release checksum refuses missing, duplicate, malformed and changed assets", () => {
  const line = `${checksum}  ${archive}\n`;
  for (const sums of ["", line + line, `invalid  ${archive}\n`])
    assert.throws(() => verifyReleaseChecksum(bytes, sums, archive), /checksum/);
  assert.throws(
    () => verifyReleaseChecksum(Buffer.from("changed release"), line, archive),
    /SHA-256 mismatch/,
  );
});
