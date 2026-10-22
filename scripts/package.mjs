import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { releaseTargets as targets, writeReleaseChecksums } from "./release-checksum.mjs";
import { stagePackageNotices } from "./package-notices.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeVersion = "24.22.1";
const nodeChecksums = {
  "node-v24.22.1-darwin-arm64.tar.gz":
    "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7",
  "node-v24.22.1-darwin-x64.tar.gz":
    "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035",
  "node-v24.22.1-linux-x64.tar.gz":
    "eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c",
  "node-v24.22.1-linux-arm64.tar.gz":
    "33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3",
  "node-v24.22.1-win-x64.zip": "d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5",
  "node-v24.22.1-win-arm64.zip": "a0c807319fede24c4a0d8f84564c82a619bd313b16b10c007c383c2609e99171",
};
const { values } = parseArgs({
  options: {
    target: { type: "string", multiple: true },
    output: { type: "string", default: "dist-release" },
    "skip-build": { type: "boolean", default: false },
  },
});
const selected = values.target ?? targets;
if (selected.length === 0 || selected.some((target) => !targets.includes(target)))
  throw new Error(`Supported targets: ${targets.join(", ")}`);
if (process.versions.node !== nodeVersion)
  throw new Error(`Packaging requires Node ${nodeVersion}.`);
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = manifest.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
  throw new Error("package.json must contain a release version.");
if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== `v${version}`)
  throw new Error(`Release tag must be v${version}.`);
if (process.platform === "win32")
  throw new Error("Package on macOS or Linux with tar, zip and unzip.");
const lock = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
const output = resolve(root, values.output);
const cache = join(output, ".cache");
await mkdir(cache, { recursive: true });

async function run(command, args, cwd = root) {
  await new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? done() : reject(new Error(`${command} failed (${signal ?? code}).`)),
    );
  });
}
const hash = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);
async function download(url, filename, integrity) {
  const destination = join(cache, filename);
  let bytes = await readFile(destination).catch(() => undefined);
  if (bytes === undefined) {
    console.log(`Downloading ${filename}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`Download failed: ${url} (${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (integrity !== undefined) {
    const [algorithm, expected] = integrity.split("-");
    if (hash(bytes, algorithm, "base64") !== expected) {
      await rm(destination, { force: true });
      throw new Error(`Integrity mismatch: ${filename}`);
    }
  }
  await writeFile(destination, bytes);
  return destination;
}
function npmIntegrity(name, version) {
  const key = `${name}@${version}`;
  const header = `  ${name.startsWith("@") ? `'${key}'` : key}:\n`;
  const start = lock.indexOf(header);
  const integrity = lock
    .slice(start + header.length)
    .split("\n")[0]
    ?.match(/integrity: (sha512-[A-Za-z0-9+/=]+)/)?.[1];
  if (start < 0 || integrity === undefined) throw new Error(`Missing lockfile integrity: ${key}`);
  return integrity;
}
async function npmArchive(name, version) {
  const basename = name.split("/").at(-1);
  return download(
    `https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz`,
    `${name.replaceAll("/", "-")}-${version}.tgz`,
    npmIntegrity(name, version),
  );
}
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected package symlink: ${path}`);
    if (entry.name === ".git" || entry.name.startsWith(".env"))
      throw new Error(`Private content in package: ${path}`);
    if (entry.isDirectory()) await inspect(path);
  }
}
if (!values["skip-build"]) {
  await run("pnpm", ["build"]);
  await run("pnpm", ["web:build"]);
}
const temporary = await mkdtemp(join(tmpdir(), "inbot-package-"));
try {
  const production = join(temporary, "production");
  await mkdir(production);
  await writeFile(join(production, "package.json"), JSON.stringify(manifest));
  // Hoisted installs otherwise include every workspace importer's production dependencies.
  const productionLock = lock.replace(
    /(\nimporters:\n\n  \.:[\s\S]*?)\n  (?!\.:)[^\s][\s\S]*?(?=\npackages:\n)/,
    "$1\n",
  );
  await writeFile(join(production, "pnpm-lock.yaml"), productionLock);
  await run(
    "pnpm",
    [
      "install",
      "--prod",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--config.node-linker=hoisted",
      `--store-dir=${join(cache, "pnpm-store")}`,
      "--registry=https://registry.npmjs.org",
    ],
    production,
  );
  const modules = join(production, "node_modules");
  await rm(join(modules, ".bin"), { recursive: true, force: true });
  for (const name of await readdir(join(modules, "@napi-rs")))
    if (name.startsWith("keyring-")) await rm(join(modules, "@napi-rs", name), { recursive: true });
  for (const name of [".modules.yaml", ".pnpm", ".pnpm-workspace-state-v1.json"])
    await rm(join(modules, name), { recursive: true, force: true });

  const sumsResponse = await fetch(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!sumsResponse.ok) throw new Error("Cannot fetch official Node checksums.");
  const sums = await sumsResponse.text();
  for (const [filename, checksum] of Object.entries(nodeChecksums)) {
    const published = sums.split(/\r?\n/).filter((line) => line.endsWith(`  ${filename}`));
    if (published.length !== 1 || published[0].split(/\s+/)[0] !== checksum)
      throw new Error(`Official Node checksum disagrees with pin: ${filename}`);
  }
  const sqliteVersion = manifest.dependencies["better-sqlite3-multiple-ciphers"];
  const sqliteArchive = await npmArchive("better-sqlite3-multiple-ciphers", sqliteVersion);
  const keyringVersion = manifest.dependencies["@napi-rs/keyring"];
  for (const target of new Set(selected)) {
    const windows = target.startsWith("win32-");
    const runtimeName = `node-v${nodeVersion}-${target.replace("win32-", "win-")}`;
    const runtimeFile = `${runtimeName}.${windows ? "zip" : "tar.gz"}`;
    const checksum = nodeChecksums[runtimeFile];
    if (!checksum || !/^[a-f0-9]{64}$/.test(checksum))
      throw new Error(`No pinned Node checksum: ${runtimeFile}`);
    const runtimeArchive = await download(
      `https://nodejs.org/dist/v${nodeVersion}/${runtimeFile}`,
      runtimeFile,
      `sha256-${Buffer.from(checksum, "hex").toString("base64")}`,
    );
    const stage = join(temporary, target);
    const bundle = join(stage, "inbot");
    const application = join(bundle, "application");
    const runtime = join(bundle, "runtime");
    await mkdir(runtime, { recursive: true });
    await mkdir(application);
    for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
      await copyFile(join(root, file), join(bundle, file));
    await cp(join(root, "dist"), join(application, "dist"), { recursive: true });
    await cp(join(root, "apps/web/dist"), join(application, "web"), { recursive: true });
    await cp(modules, join(application, "node_modules"), { recursive: true });
    await writeFile(
      join(application, "package.json"),
      JSON.stringify(
        {
          name: "inbot",
          version,
          private: true,
          license: "MIT",
          type: "module",
          dependencies: manifest.dependencies,
        },
        null,
        2,
      ) + "\n",
    );
    const sqlite = join(application, "node_modules/better-sqlite3-multiple-ciphers");
    await rm(sqlite, { recursive: true });
    await mkdir(sqlite);
    await run("tar", [
      "-xzf",
      sqliteArchive,
      "-C",
      sqlite,
      "--strip-components=1",
      "package/package.json",
      "package/LICENSE",
      "package/lib",
      `package/prebuilds/${target}.node`,
    ]);
    const keyringTarget = `${target}${target.startsWith("linux-") ? "-gnu" : windows ? "-msvc" : ""}`;
    const keyring = `@napi-rs/keyring-${keyringTarget}`;
    const keyringArchive = await npmArchive(keyring, keyringVersion);
    const keyringDirectory = join(application, "node_modules", keyring);
    await mkdir(keyringDirectory);
    await run("tar", ["-xzf", keyringArchive, "-C", keyringDirectory, "--strip-components=1"]);
    await stagePackageNotices(
      [
        { directory: application },
        { directory: join(root, "apps/web") },
        { directory: join(root, "apps/web/node_modules/tailwindcss"), include: true },
      ],
      join(bundle, "licenses"),
    );
    if (windows) {
      await run("unzip", [
        "-q",
        runtimeArchive,
        `${runtimeName}/node.exe`,
        `${runtimeName}/LICENSE`,
        "-d",
        stage,
      ]);
      for (const file of ["node.exe", "LICENSE"])
        await copyFile(join(stage, runtimeName, file), join(runtime, file));
      await writeFile(
        join(bundle, "inbot.cmd"),
        '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0application\\dist\\apps\\cli\\src\\main.js" %*\r\nexit /b %errorlevel%\r\n',
      );
    } else {
      await run("tar", [
        "-xzf",
        runtimeArchive,
        "-C",
        runtime,
        "--strip-components=1",
        `${runtimeName}/bin/node`,
        `${runtimeName}/LICENSE`,
      ]);
      await chmod(join(runtime, "bin/node"), 0o755);
      await writeFile(
        join(bundle, "inbot"),
        '#!/bin/sh\nset -eu\nINBOT_PACKAGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\nexec "$INBOT_PACKAGE_ROOT/runtime/bin/node" "$INBOT_PACKAGE_ROOT/application/dist/apps/cli/src/main.js" "$@"\n',
        { mode: 0o755 },
      );
    }
    await writeFile(
      join(bundle, "BUILD.json"),
      JSON.stringify(
        {
          version,
          target,
          node: nodeVersion,
          node_sha256: checksum,
          sqlite_integrity: npmIntegrity("better-sqlite3-multiple-ciphers", sqliteVersion),
          keyring_integrity: npmIntegrity(keyring, keyringVersion),
        },
        null,
        2,
      ) + "\n",
    );
    await inspect(bundle);
    const archive = join(output, `inbot-${version}-${target}.${windows ? "zip" : "tar.gz"}`);
    const pending = join(stage, windows ? "release.zip" : "release.tar.gz");
    if (windows) await run("zip", ["-qr", pending, "inbot"], stage);
    else await run("tar", ["-czf", pending, "-C", stage, "inbot"]);
    await copyFile(pending, `${archive}.tmp`);
    await rename(`${archive}.tmp`, archive);
    console.log(`Packaged ${archive}`);
  }
  await writeReleaseChecksums(output, version);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
