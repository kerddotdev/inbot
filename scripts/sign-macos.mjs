import { execFile } from "node:child_process";
import { mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { writeReleaseChecksums } from "./release-checksum.mjs";
import { notarizeArchive } from "./macos-notarization.mjs";

const run = promisify(execFile);
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    identity: { type: "string" },
    keychain: { type: "string" },
    notarize: { type: "boolean", default: false },
  },
});
if (process.platform !== "darwin") throw new Error("Signing requires macOS with Xcode tools.");
if (positionals.length !== 1 || !values.identity?.startsWith("Developer ID Application:"))
  throw new Error(
    'Usage: node scripts/sign-macos.mjs DIR --identity "Developer ID Application: ..." [--keychain PATH] [--notarize]',
  );
const directory = resolve(positionals[0]);
const entitlements = fileURLToPath(new URL("macos-node-entitlements.plist", import.meta.url));
const authentication = values.notarize
  ? [
      "--key",
      process.env.APPLE_API_KEY,
      "--key-id",
      process.env.APPLE_API_KEY_ID,
      "--issuer",
      process.env.APPLE_API_ISSUER,
    ]
  : [];
if (values.notarize && authentication.some((value) => !value))
  throw new Error(
    "Notarization requires APPLE_API_KEY (p8 path), APPLE_API_KEY_ID and APPLE_API_ISSUER.",
  );
const archives = (await readdir(directory))
  .filter((name) =>
    /^inbot-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-darwin-(arm64|x64)\.tar\.gz$/.test(name),
  )
  .sort();
if (archives.length === 0) throw new Error("No macOS release archives found.");
const versions = new Set(
  archives.map((name) => name.replace(/^inbot-/, "").replace(/-darwin-(arm64|x64)\.tar\.gz$/, "")),
);
if (versions.size !== 1) throw new Error("Sign one release version at a time.");

async function machOFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected package symlink: ${path}`);
    if (entry.isDirectory()) files.push(...(await machOFiles(path)));
    else if (entry.isFile()) {
      const handle = await open(path, "r");
      const magic = Buffer.alloc(4);
      try {
        await handle.read(magic, 0, 4, 0);
      } finally {
        await handle.close();
      }
      if (
        [
          "feedface",
          "feedfacf",
          "cefaedfe",
          "cffaedfe",
          "cafebabe",
          "bebafeca",
          "cafebabf",
          "bfbafeca",
        ].includes(magic.toString("hex"))
      )
        files.push(path);
      else if (entry.name.endsWith(".node")) throw new Error(`Native addon is not Mach-O: ${path}`);
    }
  }
  return files.sort();
}

for (const archive of archives) {
  const temporary = await mkdtemp(join(tmpdir(), "inbot-sign-"));
  try {
    const path = join(directory, archive);
    await run("/usr/bin/tar", ["-xzf", path, "-C", temporary]);
    const bundle = join(temporary, "inbot");
    const node = join(bundle, "runtime/bin/node");
    const files = await machOFiles(bundle);
    if (!files.includes(node) || files.filter((file) => file.endsWith(".node")).length < 2)
      throw new Error(`Incomplete macOS payload: ${archive}`);
    for (const file of files) {
      const args = ["--force", "--sign", values.identity, "--options", "runtime", "--timestamp"];
      if (values.keychain) args.push("--keychain", resolve(values.keychain));
      if (file === node) args.push("--entitlements", entitlements);
      await run("/usr/bin/codesign", [...args, file]);
      await run("/usr/bin/codesign", ["--verify", "--strict", "--deep", file]);
    }
    if (values.notarize) {
      const zip = join(temporary, "payload.zip");
      await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle, zip]);
      const log = join(temporary, "notary-log.json");
      const id = await notarizeArchive(zip, authentication, log);
      console.log(`Notarized ${archive}: ${id}`);
    }
    for (const file of files)
      await run("/usr/bin/codesign", ["--verify", "--strict", "--deep", file]);
    await run("/usr/bin/tar", ["-czf", `${path}.tmp`, "-C", temporary, "inbot"]);
    await rename(`${path}.tmp`, path);
    console.log(`Signed ${archive}: ${files.length} Mach-O files`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
await writeReleaseChecksums(directory, [...versions][0]);
