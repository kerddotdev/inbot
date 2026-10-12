import { writeFile } from "node:fs/promises";
import { invalidResponse, throwResponseError } from "./client.js";
import { CliError, usage } from "./errors.js";
import { record } from "./output.js";
import type { CliIO } from "./cli.js";

export function validateOutput(output: unknown, json: unknown, io: CliIO): void {
  if (json) {
    if (output !== undefined) usage("Choose --json download metadata or --output bytes.");
    return;
  }
  if (output !== undefined && (typeof output !== "string" || output.length === 0))
    usage("--output requires a file path or '-'.");
  if (output === undefined || output === "-") {
    if (io.stdoutIsTTY ?? process.stdout.isTTY)
      usage("Refusing binary output to a terminal. Use -o <path> or redirect stdout.");
    if (io.stdoutBinary === undefined) usage("Binary stdout is unavailable. Use -o <path>.");
  }
}

export async function download(
  origin: string,
  metadata: unknown,
  output: string | undefined,
  io: CliIO,
): Promise<void> {
  if (!record(metadata) || typeof metadata.download_url !== "string") throw invalidResponse();
  let url: URL;
  try {
    url = new URL(metadata.download_url);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/v0\/downloads\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(url.pathname)
    )
      throw new Error("Invalid download URL");
  } catch {
    throw invalidResponse();
  }
  let response: Response;
  let bytes: Uint8Array;
  try {
    response = await fetch(url, {
      redirect: "error",
      signal:
        io.signal === undefined
          ? AbortSignal.timeout(30_000)
          : AbortSignal.any([io.signal, AbortSignal.timeout(30_000)]),
    });
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new CliError(
      {
        code: "service_unavailable",
        message: "Cannot download the requested content.",
        fix: "Check the connection and request a fresh download with the same command.",
      },
      10,
    );
  }
  if (!response.ok) {
    let wire: unknown;
    try {
      wire = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      throw invalidResponse();
    }
    throwResponseError(wire);
  }
  if (bytes.length !== metadata.size) throw invalidResponse();
  if (output === undefined || output === "-") {
    if (io.stdoutBinary === undefined) usage("Binary stdout is unavailable. Use -o <path>.");
    await io.stdoutBinary(bytes);
  } else {
    try {
      await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
    } catch {
      throw new CliError(
        {
          code: "service_unavailable",
          message: "Cannot create the output file.",
          fix: "Choose a writable path that does not already exist. Existing files are never overwritten.",
        },
        1,
      );
    }
  }
}
