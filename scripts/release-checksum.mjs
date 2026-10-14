import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const releaseTargets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-arm64",
];

export async function writeReleaseChecksums(directory, version, requireAll = false) {
  const expected = releaseTargets.map(
    (target) => `inbot-${version}-${target}.${target.startsWith("win32-") ? "zip" : "tar.gz"}`,
  );
  const entries = await readdir(directory);
  const archives = expected.filter((name) => entries.includes(name)).sort();
  assert.ok(archives.length > 0, "No release archives found.");
  if (requireAll) assert.equal(archives.length, expected.length, "Incomplete release assets.");
  const sums = await Promise.all(
    archives.map(
      async (name) =>
        `${createHash("sha256")
          .update(await readFile(join(directory, name)))
          .digest("hex")}  ${name}\n`,
    ),
  );
  await writeFile(join(directory, "SHA256SUMS.tmp"), sums.join(""));
  await rename(join(directory, "SHA256SUMS.tmp"), join(directory, "SHA256SUMS"));
}

export { verifyReleaseChecksum } from "../apps/server/src/update/checksum.ts";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, version, ...extra] = process.argv.slice(2);
  assert.ok(
    directory && version && extra.length === 0,
    "Usage: node scripts/release-checksum.mjs DIR VERSION",
  );
  await writeReleaseChecksums(resolve(directory), version, true);
}
