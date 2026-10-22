import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, isAbsolute } from "node:path";
import { Schema } from "effect";
import type { CommandRunner } from "../../../cli/src/service.js";
import { verifyReleaseChecksum } from "./checksum.js";
import { UpdateError } from "./errors.js";
import { atomicWrite } from "./files.js";
import { activeBundle, Build, bundlePaths, renderShim, type InstalledLayout } from "./layout.js";
import { assetUrl } from "./release.js";
import { compareVersions, parseVersion } from "./version.js";

// Windows archives are zip files that only the bundled bsdtar reads, and a PATH lookup can pick another tar.
export const tarProgram =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

async function download(url: string, limit: number, fetcher: typeof fetch, signal?: AbortSignal) {
  const response = await fetcher(url, {
    signal: AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok || !response.body || (response.url && !response.url.startsWith("https://")))
    throw new UpdateError("Release download failed.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > limit) throw new UpdateError("Release asset exceeds the download limit.");
      chunks.push(result.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}

async function validateLinks(root: string, directory = root): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = relative(root, await realpath(file));
      if (target.startsWith("..") || isAbsolute(target))
        throw new UpdateError("Archive links escape the release directory.");
    } else if (entry.isDirectory()) await validateLinks(root, file);
  }
}

export async function verifyBundle(
  bundle: string,
  layout: InstalledLayout,
  version: string,
  run: CommandRunner,
) {
  const build = Schema.decodeUnknownSync(Build)(
    JSON.parse(await readFile(join(bundle, "BUILD.json"), "utf8")),
  );
  if (build.version !== version || build.target !== layout.target)
    throw new UpdateError("Release metadata does not match the requested version and platform.");
  const paths = bundlePaths(bundle, layout.windows);
  for (const file of [
    paths.executable,
    paths.cli,
    join(bundle, layout.windows ? "inbot.cmd" : "inbot"),
  ]) {
    if (!(await lstat(file)).isFile()) throw new UpdateError("Incomplete release archive.");
  }
  await validateLinks(bundle);
  if (layout.target.startsWith("darwin-")) {
    const verified = await run("/usr/bin/codesign", ["--verify", "--strict", paths.executable]);
    const identity = await run("/usr/bin/codesign", ["--display", "--verbose=4", paths.executable]);
    if (
      verified.code !== 0 ||
      identity.code !== 0 ||
      !/^TeamIdentifier=7LA5DMHTL9$/m.test(identity.stderr)
    )
      throw new UpdateError(
        "The bundled Node signature is invalid or has an unexpected Team ID.",
        "Do not run this release. Retry from the official GitHub release or report the verification failure.",
      );
  }
}

export async function prepareUpdate(
  layout: InstalledLayout,
  version: string,
  run: CommandRunner,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  parseVersion(version);
  const lock = join(layout.root, ".update-lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new UpdateError(
      "Another update is in progress, or an interrupted update left a lock.",
      `Wait for the updater. If none is running, remove ${lock} and retry.`,
    );
  }
  let work: string | undefined;
  const close = async () => {
    if (work) await rm(work, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  };
  try {
    const active = basename(await activeBundle(layout));
    if (compareVersions(version, layout.current) <= 0 || compareVersions(version, active) < 0)
      throw new UpdateError("Updates never downgrade or reinstall the running version.");
    work = await mkdtemp(join(layout.root, "app", ".update-"));
    const archive = `inbot-${version}-${layout.target}.${layout.windows ? "zip" : "tar.gz"}`;
    const sums = (
      await download(assetUrl(version, "SHA256SUMS"), 1024 * 1024, fetcher, signal)
    ).toString("utf8");
    const bytes = await download(assetUrl(version, archive), 1024 * 1024 * 1024, fetcher, signal);
    try {
      verifyReleaseChecksum(bytes, sums, archive);
    } catch {
      throw new UpdateError(
        "Release SHA-256 verification failed. Nothing was switched.",
        "Retry from the official release; report a persistent checksum mismatch.",
      );
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    const destination = join(layout.root, "app", version);
    let existing = false;
    try {
      await lstat(destination);
      existing = true;
      if ((await readFile(join(destination, ".archive-sha256"), "utf8")).trim() !== hash)
        throw new UpdateError(
          "The existing version contains a different archive.",
          "Keep the existing version intact. Choose another install root or explicitly remove the conflicting version after checking it.",
        );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT" && !existing))
        throw error;
    }
    if (!existing) {
      const file = join(work, archive);
      await writeFile(file, bytes, { mode: 0o600 });
      const listing = await run(tarProgram, ["-tf", file]);
      if (
        listing.code !== 0 ||
        !listing.stdout.trim() ||
        listing.stdout
          .trimEnd()
          .split(/\r?\n/)
          .some(
            (entry) =>
              !entry.startsWith("inbot/") ||
              /(^|\/)\.\.($|\/)|[\\:]/.test(entry) ||
              Array.from(entry).some((char) => char.charCodeAt(0) < 32),
          )
      )
        throw new UpdateError("Archive contains an unsafe path or cannot be read.");
      if ((await run(tarProgram, ["-xf", file, "-C", work])).code !== 0)
        throw new UpdateError("Release extraction failed.");
      await verifyBundle(join(work, "inbot"), layout, version, run);
      await writeFile(join(work, "inbot", ".archive-sha256"), `${hash}\n`, { mode: 0o600 });
      await rename(join(work, "inbot"), destination);
    } else await verifyBundle(destination, layout, version, run);
    return {
      destination,
      close,
      async activate() {
        const latestActive = basename(await activeBundle(layout));
        if (compareVersions(version, latestActive) < 0)
          throw new UpdateError("A newer version is already active.");
        await atomicWrite(
          join(layout.root, "installation.json"),
          `${JSON.stringify({ shim: layout.shim })}\n`,
        );
        await atomicWrite(layout.shim, renderShim(destination, layout.windows), 0o755);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
