import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function verifyReleaseChecksum(bytes: Uint8Array, sums: string, archive: string) {
  const matches = sums.split(/\r?\n/).filter((line) => line.endsWith(`  ${archive}`));
  assert.equal(matches.length, 1, `Archive checksum missing or duplicated: ${archive}`);
  const line = matches[0];
  assert.ok(line);
  const expected = line.slice(0, -`  ${archive}`.length);
  assert.match(expected, /^[a-fA-F0-9]{64}$/, `Invalid archive checksum: ${archive}`);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    expected.toLowerCase(),
    `SHA-256 mismatch: ${archive}`,
  );
}
