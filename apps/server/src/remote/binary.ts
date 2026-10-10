import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Effect } from "effect";
import { actionRequired, ProvisionError } from "../provision/errors.js";

export const cloudflaredVersion = "2026.9.1";
export const artifacts = {
  "darwin-arm64": {
    file: "cloudflared-darwin-arm64.tgz",
    sha256: "9a0b19f67dc7a3011bc6b972c7ce06a5fcea8784ac6bd599ffa382ea4aeb5a6e",
  },
  "darwin-x64": {
    file: "cloudflared-darwin-amd64.tgz",
    sha256: "1ea07ae775b03236bd6be18ca1848d6bdc4af2f4f3bce398823b5a36e5761b75",
  },
  "linux-arm64": {
    file: "cloudflared-linux-arm64",
    sha256: "3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3",
  },
  "linux-x64": {
    file: "cloudflared-linux-amd64",
    sha256: "03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc",
  },
  "win32-x64": {
    file: "cloudflared-windows-amd64.exe",
    sha256: "2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712",
  },
} as const;
export interface Artifact {
  readonly file: string;
  readonly sha256: string;
}
export type Downloader = (url: string, signal: AbortSignal) => Promise<Uint8Array>;
export const download: Downloader = async (url, signal) => {
  const response = await fetch(url, { signal });
  if (!response.ok || response.body === null) throw new Error("Download unavailable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 150 * 1024 * 1024) throw new Error("Download too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function extractBinary(bytes: Uint8Array, artifact: Artifact): Uint8Array {
  if (!artifact.file.endsWith(".tgz")) return bytes;
  const tar = gunzipSync(bytes, { maxOutputLength: 150 * 1024 * 1024 });
  let binary: Uint8Array | undefined;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error("Invalid archive size");
    const size = parseInt(sizeText, 8);
    if (offset + 512 + size > tar.length) throw new Error("Truncated archive");
    if (name === "cloudflared" || name === "./cloudflared") {
      if (binary !== undefined || ![0, 48].includes(header[156] ?? -1))
        throw new Error("Invalid binary entry");
      binary = tar.subarray(offset + 512, offset + 512 + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (binary === undefined || binary.byteLength === 0) throw new Error("Missing binary");
  return binary;
}

export function makeBinary(
  home: string,
  options: {
    readonly platform?: string;
    readonly artifact?: Artifact;
    readonly downloader?: Downloader;
  } = {},
) {
  const platform = options.platform ?? `${process.platform}-${process.arch}`;
  const artifact =
    options.artifact ?? Object.entries(artifacts).find(([key]) => key === platform)?.[1];
  const directory = join(home, "bin");
  const failure = () =>
    actionRequired(
      "The pinned cloudflared binary is missing or could not be verified.",
      "Enable remote access locally to download a verified connector for this platform.",
    );
  return {
    ensure: (allowDownload: boolean) =>
      Effect.tryPromise({
        try: async (signal) => {
          if (artifact === undefined)
            throw actionRequired(
              "This platform has no pinned cloudflared artifact.",
              "Use macOS or Linux arm64/x64, or Windows x64.",
            );
          await mkdir(directory, { recursive: true, mode: 0o700 });
          if ((await lstat(directory)).isSymbolicLink()) throw failure();
          await chmod(directory, 0o700);
          const archive = join(directory, `${cloudflaredVersion}-${artifact.file}`);
          let bytes: Uint8Array | undefined;
          try {
            if (!(await lstat(archive)).isFile()) throw failure();
            bytes = await readFile(archive);
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
              throw error;
          }
          if (bytes === undefined) {
            if (!allowDownload) throw failure();
            bytes = await (options.downloader ?? download)(
              `https://github.com/cloudflare/cloudflared/releases/download/${cloudflaredVersion}/${artifact.file}`,
              signal,
            );
          }
          if (sha256(bytes) !== artifact.sha256)
            throw actionRequired(
              "cloudflared checksum mismatch. Execution was refused.",
              "Remove the invalid cached artifact and enable again. Never run an unverified binary.",
            );
          const binary = extractBinary(bytes, artifact);
          const executable = join(
            directory,
            `cloudflared-${cloudflaredVersion}${platform.startsWith("win32-") ? ".exe" : ""}`,
          );
          const atomicWrite = async (path: string, content: Uint8Array, mode: number) => {
            const temporary = `${path}.${randomUUID()}.tmp`;
            try {
              await writeFile(temporary, content, { mode, flag: "wx" });
              await rename(temporary, path);
            } finally {
              await rm(temporary, { force: true });
            }
          };
          await atomicWrite(archive, bytes, 0o600);
          await atomicWrite(executable, binary, 0o700);
          await chmod(executable, 0o700);
          if (sha256(await readFile(executable)) !== sha256(binary)) throw failure();
          return executable;
        },
        catch: (error) => (error instanceof ProvisionError ? error : failure()),
      }).pipe(
        Effect.timeoutOrElse({ duration: "2 minutes", orElse: () => Effect.fail(failure()) }),
      ),
  };
}
