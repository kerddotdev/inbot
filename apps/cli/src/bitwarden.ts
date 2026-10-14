import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { BITWARDEN_MAX_BYTES } from "../../../packages/contracts/src/bitwarden.js";
import type { CliIO } from "./cli.js";
import { CliError, usage } from "./errors.js";

export async function readBitwarden(file: unknown): Promise<unknown> {
  if (typeof file !== "string" || file.length === 0)
    usage("Use --file <path> to import Bitwarden JSON.");
  try {
    const json = await readFile(file, "utf8");
    if (Buffer.byteLength(json, "utf8") > BITWARDEN_MAX_BYTES)
      usage("Split the export into files of at most 5 MB.");
    return JSON.parse(json);
  } catch (error) {
    if (error instanceof CliError) throw error;
    usage("Cannot read Bitwarden JSON. Use --file with a readable unencrypted JSON export.");
  }
}

export function validateBitwardenOutput(output: unknown, json: unknown) {
  if (json) usage("Use -o <file> or explicit -o - for credential exports; --json is unavailable.");
  if (typeof output !== "string" || output.length === 0)
    usage("Credential exports require -o <file>. Use -o - explicitly to print secrets to stdout.");
}

export function requireLocalVault(url: string) {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname))
    usage("Credential import and export require the Inbot host's loopback URL.");
}

export async function writeBitwarden(value: unknown, output: string, force: boolean, io: CliIO) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (output === "-") {
    io.stdout(json);
    return;
  }
  try {
    const file = await open(
      output,
      constants.O_WRONLY |
        constants.O_CREAT |
        (constants.O_NOFOLLOW ?? 0) |
        (force ? constants.O_TRUNC : constants.O_EXCL),
      0o600,
    );
    try {
      if (process.platform !== "win32") await file.chmod(0o600);
      await file.writeFile(json, "utf8");
    } finally {
      await file.close();
    }
  } catch {
    throw new CliError(
      {
        code: "service_unavailable",
        message: "Cannot create the credential export file.",
        fix: "Choose a writable new path, or use --force to replace an existing regular file.",
      },
      1,
    );
  }
}
