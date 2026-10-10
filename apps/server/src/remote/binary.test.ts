import { gzipSync } from "node:zlib";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { cloudflaredVersion, extractBinary, makeBinary, sha256 } from "./binary.js";

function archive(name: string, type = 48, bytes = Buffer.from("synthetic executable")) {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(bytes.byteLength.toString(8).padStart(11, "0"), 124);
  header[156] = type;
  return gzipSync(
    Buffer.concat([header, bytes, Buffer.alloc(512 - bytes.byteLength), Buffer.alloc(512)]),
  );
}

test("macOS extraction accepts a regular binary and refuses links or arbitrary paths", () => {
  const artifact = { file: "cloudflared-darwin-arm64.tgz", sha256: "synthetic" };
  expect(Buffer.from(extractBinary(archive("cloudflared"), artifact)).toString()).toBe(
    "synthetic executable",
  );
  expect(() => extractBinary(archive("cloudflared", 50), artifact)).toThrow("Invalid binary entry");
  expect(() => extractBinary(archive("../cloudflared"), artifact)).toThrow("Missing binary");
});

test("verification tightens an existing bin directory before using the cache", async () => {
  const home = await mkdtemp(join(tmpdir(), "inbot-binary-mode-"));
  const directory = join(home, "bin");
  const bytes = Buffer.from("synthetic executable");
  const artifact = { file: "cloudflared-test", sha256: sha256(bytes) };
  try {
    await mkdir(directory);
    await chmod(directory, 0o755);
    await writeFile(join(directory, `${cloudflaredVersion}-${artifact.file}`), bytes);
    const path = await Effect.runPromise(
      makeBinary(home, { platform: "linux-x64", artifact }).ensure(false),
    );
    expect(await readFile(path)).toEqual(bytes);
    if (process.platform !== "win32") expect((await stat(directory)).mode & 0o777).toBe(0o700);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("verification rejects a symlinked bin directory without changing its target", async () => {
  const home = await mkdtemp(join(tmpdir(), "inbot-binary-link-"));
  const target = join(home, "target");
  try {
    await mkdir(target);
    await chmod(target, 0o755);
    await symlink(target, join(home, "bin"), "dir");
    await expect(Effect.runPromise(makeBinary(home).ensure(false))).rejects.toMatchObject({
      code: "action_required",
    });
    if (process.platform !== "win32") expect((await stat(target)).mode & 0o777).toBe(0o755);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("archives must match both the archive digest and the extracted binary digest", async () => {
  const home = await mkdtemp(join(tmpdir(), "inbot-binary-archive-"));
  const bytes = archive("cloudflared");
  const binary = Buffer.from("synthetic executable");
  const install = (binarySha256: string) => {
    const artifact = { file: "cloudflared-darwin-arm64.tgz", sha256: sha256(bytes), binarySha256 };
    return makeBinary(home, {
      platform: "darwin-arm64",
      artifact,
      downloader: async () => bytes,
    }).ensure(true);
  };
  try {
    await expect(Effect.runPromise(install(sha256(Buffer.from("other"))))).rejects.toThrow(
      "checksum mismatch",
    );
    expect(await readFile(await Effect.runPromise(install(sha256(binary))))).toEqual(binary);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
