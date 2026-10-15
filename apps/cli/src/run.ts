import { spawn } from "node:child_process";
import { constants } from "node:os";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { parseArgs } from "node:util";
import { Schema } from "effect";
import { CredentialsApi } from "../../../packages/contracts/src/api/vault.js";
import {
  CredentialRef,
  ResolveCredentialsRequest,
  ResolveCredentialsResponse,
} from "../../../packages/contracts/src/vault.js";
import { decrypt, generateIdentity } from "../../../packages/envelope/src/crypto.js";
import type { CliIO } from "./cli.js";
import { connection, invalidResponse, request, type Environment } from "./client.js";
import { CliError, usage } from "./errors.js";

export const runHelp = `Usage: inbot run [--env NAME=REF]... [--no-mask] [--home DIR] -- <command> [args...]

Run a local command with credential references resolved into its environment.
  --env <NAME=REF>  Set a credential reference (repeatable; overrides ambient env).
  --no-mask        Inherit stdio for TTYs and byte-exact protocols such as MCP.
  --home <DIR>     Read the owner's connection.json from this home.
  --flavor <value> development or production (default: development).
  --help           Show this help.

Ambient environment values matching inbot://credentials/<credential_id>/<field>
are resolved too. At least one reference is required (at most 32 unique refs).
Requires credential_run and matching inbox scope; the URL must be loopback.
The child runs without a shell. SIGINT/SIGTERM are forwarded; its exit code is
returned, or 128 + signal number when terminated by a signal.
Masking stdout/stderr is best effort and only covers exact values of length >= 4.
This keeps values out of model context and logs by default, but is not a security
boundary: a process the agent controls can print or transform the values.
Process resolution therefore has its own permission separate from browser fill.
`;

export function collectRunEnvironment(env: Environment, assignments: readonly string[]) {
  const result = new Map(Object.entries(env));
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    if (separator < 1) usage("--env requires NAME=REF.");
    const name = assignment.slice(0, separator);
    const ref = assignment.slice(separator + 1);
    validateTarget(name);
    if (!Schema.is(CredentialRef)(ref)) usage("--env requires a valid credential reference.");
    result.set(name, ref);
  }
  const targets = [...result].flatMap(([name, value]) => {
    if (value === undefined || !Schema.is(CredentialRef)(value)) return [];
    validateTarget(name);
    return [{ name, ref: value }];
  });
  const refs = [...new Set(targets.map(({ ref }) => ref))];
  if (refs.length === 0) usage("No credential references found");
  if (refs.length > 32) usage("Use at most 32 unique credential references.");
  return { env: Object.fromEntries(result), targets, refs };
}

function validateTarget(name: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) usage("Invalid environment variable name.");
  if (
    ["LD_PRELOAD", "LD_LIBRARY_PATH", "NODE_OPTIONS", "BASH_ENV", "ENV", "PATH"].includes(name) ||
    name.startsWith("DYLD_")
  )
    usage(`Credential references cannot target ${name}.`);
}

export function credentialMask(values: readonly string[]) {
  const secrets = [...new Set(values.filter((value) => value.length >= 4))]
    .map((value) => Buffer.from(value))
    .sort((a, b) => b.length - a.length);
  const tailLength = Math.max(0, ...secrets.map((value) => value.length - 1));
  const replacement = Buffer.from("<concealed by inbot>");
  let pending = Buffer.alloc(0);
  function emit(stream: Transform, final: boolean) {
    const limit = final ? pending.length : Math.max(0, pending.length - tailLength);
    let cursor = 0;
    while (cursor < limit) {
      let start = limit;
      let match: Buffer | undefined;
      for (const secret of secrets) {
        const found = pending.indexOf(secret, cursor);
        if (found >= 0 && found < start) {
          start = found;
          match = secret;
        }
      }
      if (start > cursor) stream.push(pending.subarray(cursor, start));
      if (match === undefined) {
        cursor = limit;
      } else {
        stream.push(replacement);
        cursor = start + match.length;
      }
    }
    pending = pending.subarray(cursor);
  }
  return new Transform({
    transform(chunk: unknown, _encoding, callback) {
      if (!Buffer.isBuffer(chunk)) return callback(new Error("Expected output bytes"));
      pending = Buffer.concat([pending, chunk]);
      emit(this, false);
      callback();
    },
    flush(callback) {
      emit(this, true);
      callback();
    },
  });
}

function outputSink(text: (text: string) => void, binary?: CliIO["stdoutBinary"]) {
  const decoder = new StringDecoder("utf8");
  return new Writable({
    write(chunk: unknown, _encoding, callback) {
      if (!Buffer.isBuffer(chunk)) return callback(new Error("Expected output bytes"));
      if (binary !== undefined) {
        binary(chunk).then(
          () => callback(),
          () => callback(new Error("Output write failed")),
        );
      } else {
        text(decoder.write(chunk));
        callback();
      }
    },
    final(callback) {
      if (binary === undefined) text(decoder.end());
      callback();
    },
  });
}

export async function runCommand(args: readonly string[], io: CliIO): Promise<number> {
  const separator = args.indexOf("--");
  const { values, positionals } = parseArgs({
    args: separator < 0 ? [...args] : args.slice(0, separator),
    options: {
      env: { type: "string", multiple: true },
      "no-mask": { type: "boolean" },
      home: { type: "string" },
      flavor: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    io.stdout(runHelp);
    return 0;
  }
  const command = args[separator + 1];
  if (separator < 0 || !command || positionals.length > 0)
    usage("Use inbot run [options] -- <command> [args...].");
  const flavor = values.flavor ?? "development";
  if (flavor !== "development" && flavor !== "production")
    usage("--flavor must be development or production.");
  const collected = collectRunEnvironment(io.env, values.env ?? []);
  const auth = await connection(
    { flavor, ...(values.home === undefined ? {} : { home: values.home }) },
    io.env,
  );
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(auth.url).hostname))
    throw new CliError(
      {
        code: "missing_permission",
        message: "Credential resolution is local-only.",
        fix: "Run inbot run on the Inbot host using localhost, 127.0.0.1, or ::1.",
      },
      4,
    );
  const identity = await generateIdentity();
  const body = Schema.decodeUnknownSync(ResolveCredentialsRequest)({
    refs: collected.refs,
    public_key: identity.recipient,
  });
  const endpoint = CredentialsApi.endpoints.credentials_resolve;
  const response = Schema.decodeUnknownSync(ResolveCredentialsResponse)(
    await request(auth, endpoint, endpoint.path, body),
  );
  let resolved: Readonly<Record<string, string>>;
  try {
    const plaintext = await decrypt(identity.identity, Buffer.from(response.ciphertext, "base64"));
    resolved = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ values: Schema.Record(CredentialRef, Schema.String) })),
      { onExcessProperty: "error" },
    )(new TextDecoder().decode(plaintext)).values;
    if (Object.keys(resolved).length !== collected.refs.length) throw invalidResponse();
    for (const { name, ref } of collected.targets) {
      const value = resolved[ref];
      if (value === undefined || value.includes("\0")) throw invalidResponse();
      collected.env[name] = value;
    }
  } catch {
    throw invalidResponse();
  }
  const child = spawn(command, args.slice(separator + 2), {
    env: collected.env,
    stdio: values["no-mask"] ? "inherit" : ["inherit", "pipe", "pipe"],
  });
  const forwardInterrupt = () => child.kill("SIGINT");
  const forwardTerminate = () => child.kill("SIGTERM");
  process.on("SIGINT", forwardInterrupt);
  process.on("SIGTERM", forwardTerminate);
  io.signal?.addEventListener("abort", forwardTerminate, { once: true });
  try {
    const exited = new Promise<number>((resolve, reject) => {
      child.once("error", () =>
        reject(
          new CliError(
            {
              code: "service_unavailable",
              message: "Could not start the child command.",
              fix: "Check that the command exists and is executable on the Inbot host.",
            },
            1,
          ),
        ),
      );
      child.once("close", (code, signal) =>
        resolve(code ?? (signal === null ? 1 : 128 + constants.signals[signal])),
      );
    });
    const output: Promise<void>[] = [];
    if (child.stdout !== null && child.stderr !== null) {
      const secrets = Object.values(resolved);
      output.push(
        pipeline(child.stdout, credentialMask(secrets), outputSink(io.stdout, io.stdoutBinary)),
        pipeline(child.stderr, credentialMask(secrets), outputSink(io.stderr, io.stderrBinary)),
      );
    }
    if (io.signal?.aborted) forwardTerminate();
    const [code] = await Promise.all([exited, ...output]);
    return code;
  } finally {
    process.off("SIGINT", forwardInterrupt);
    process.off("SIGTERM", forwardTerminate);
    io.signal?.removeEventListener("abort", forwardTerminate);
  }
}
