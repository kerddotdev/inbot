import { followEvents } from "./events.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { Schema } from "effect";
import { IdempotencyKey } from "../../../packages/contracts/src/common.js";
import { connection, decodeWire, request, type Environment } from "./client.js";
import { commands, flagName, type Command, type FieldKind } from "./commands.js";
import { CliError, usage } from "./errors.js";
import { humanOutput, record } from "./output.js";
import { packageVersion } from "./version.js";
import { runServiceCommand, serviceHelp } from "./service-command.js";
import type { ServiceRuntime } from "./service.js";
import { download, validateOutput } from "./downloads.js";

export interface CliIO {
  readonly env: Environment;
  readonly signal?: AbortSignal;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly openBrowser?: (url: string) => Promise<void>;
  readonly serviceRuntime?: ServiceRuntime;
  readonly readStdin?: () => Promise<string>;
  readonly stdoutIsTTY?: boolean;
  readonly stdoutBinary?: (bytes: Uint8Array) => Promise<void>;
}
const globals: ParseArgsOptionsConfig = {
  home: { type: "string" },
  flavor: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};
const option = (kind: FieldKind) =>
  kind === "boolean"
    ? ({ type: "boolean" } as const)
    : kind === "array"
      ? ({ type: "string", multiple: true } as const)
      : ({ type: "string" } as const);

function commandOptions(command: Command): ParseArgsOptionsConfig {
  return {
    ...globals,
    ...Object.fromEntries(
      Object.entries({ ...command.body, ...command.query }).map(([key, kind]) => [
        flagName(key),
        option(kind),
      ]),
    ),
    ...(command.body === undefined || command.tokenInput
      ? {}
      : { data: { type: "string" }, "data-file": { type: "string" } }),
    ...(command.scopedEndpoint === undefined ? {} : { inbox: { type: "string" } }),
    ...(command.idempotent ? { "idempotency-key": { type: "string" } } : {}),
    ...(command.secret ? { "show-secret": { type: "boolean" } } : {}),
    ...(command.browser ? { browser: { type: "boolean" } } : {}),
    ...(command.download ? { output: { type: "string", short: "o" } } : {}),
    ...(command.tokenInput ? { "token-stdin": { type: "boolean" } } : {}),
  };
}

function help(command?: Command, group?: string): string {
  if (command === undefined) {
    const available =
      group === undefined
        ? commands
        : commands.filter((entry) => entry.name.startsWith(`${group} `));
    return `Usage: inbot <command> [options] | inbot --version\n\n${group === undefined ? "  serve                Run the existing server (inbot serve --help).\n" : ""}${available.map((entry) => `  ${entry.name.padEnd(20)} ${entry.description}`).join("\n")}${group === undefined ? `\n${serviceHelp}  events --follow      Stream accessible events (--json, --last-event-id).` : ""}\n\nGlobal options: --home <directory>, --flavor development|production, --json, --help\nOwner: read connection.json from the server home. Agent: set INBOT_URL and INBOT_API_KEY.\n`;
  }
  const flags = commandOptions(command);
  return `Usage: inbot ${command.name}${(command.params ?? []).map((param) => ` <${param}>`).join("")} [options]\n\n${command.description}\n\n${Object.entries(
    flags,
  )
    .map(
      ([key, spec]) =>
        `  --${key}${spec.type === "string" ? " <value>" : ""}${spec.multiple ? " (repeatable)" : ""}`,
    )
    .join(
      "\n",
    )}\n${command.body === undefined || command.tokenInput ? "" : "\n--data accepts the REST JSON payload; --data-file reads it from a file or '-' for stdin. Do not combine payload JSON with body flags.\n"}${command.idempotent ? "\nThe Idempotency-Key is printed to stderr before sending. Reuse it with the same payload after an uncertain result.\n" : ""}${command.download ? "\n-o, --output <path> creates a private file and refuses to overwrite it. Omit it or use '-' for redirected binary stdout. --json returns download metadata only and cannot be combined with --output.\n" : ""}${command.tokenInput ? "\nProvide the token through INBOT_CLOUDFLARE_API_TOKEN or --token-stdin (raw token, trailing newline allowed). Never put it in command arguments. --account-id is optional when exactly one account is accessible. Configure verifies before saving; there is no separate verify route.\n" : ""}`;
}

function fields(
  definition: Readonly<Record<string, FieldKind>> | undefined,
  values: Record<string, string | boolean | (string | boolean)[] | undefined>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(definition ?? {})) {
    const value = values[flagName(key)];
    if (value === undefined) continue;
    if (kind === "number") {
      if (typeof value !== "string" || !/^\d+$/.test(value))
        usage(`--${flagName(key)} requires a positive integer.`);
      result[key] = Number(value);
    } else if (kind === "object") {
      if (typeof value !== "string") usage(`--${flagName(key)} requires a JSON object.`);
      try {
        const parsed: unknown = JSON.parse(value);
        if (!record(parsed)) usage(`--${flagName(key)} requires a JSON object.`);
        result[key] = parsed;
      } catch {
        usage(`--${flagName(key)} requires a JSON object.`);
      }
    } else result[key] = value;
  }
  return result;
}

export async function runCli(args: readonly string[], io: CliIO): Promise<number> {
  try {
    if (args[0] === "--version" || args[0] === "version") {
      const { positionals } = parseArgs({
        args: args.slice(1),
        options: globals,
        allowPositionals: true,
      });
      if (positionals.length > 0) usage("Version does not accept positional arguments.");
      io.stdout(`${await packageVersion()}\n`);
      return 0;
    }
    const scan = parseArgs({
      args: [...args],
      options: globals,
      allowPositionals: true,
      strict: false,
      tokens: true,
    });
    const positional = scan.tokens.filter((token) => token.kind === "positional");
    const first = positional[0];
    const second = positional[1];
    const group = first?.value;
    if (group === "service") {
      await runServiceCommand(
        args.filter((_, index) => index !== first?.index),
        io,
      );
      return 0;
    }
    if (group === "events") {
      await followEvents(
        args.filter((_, index) => index !== first?.index),
        io,
      );
      return 0;
    }
    const name = group === "open" ? "open" : `${group ?? ""} ${second?.value ?? ""}`;
    const command = commands.find((entry) => entry.name === name);
    if (command === undefined) {
      if (
        (args.length === 0 || scan.values.help) &&
        (group === undefined || commands.some((entry) => entry.name.startsWith(`${group} `)))
      ) {
        io.stdout(help(undefined, group));
        return 0;
      }
      usage("Unknown command. Run inbot --help.");
    }
    const indexes = new Set([first?.index, ...(group === "open" ? [] : [second?.index])]);
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({
        args: args.filter((_, index) => !indexes.has(index)),
        options: commandOptions(command),
        allowPositionals: true,
        allowNegative: true,
      });
    } catch {
      usage("Invalid command options.");
    }
    const { values, positionals } = parsed;
    if (values.help) {
      io.stdout(help(command));
      return 0;
    }
    if (command.download) validateOutput(values.output, values.json, io);
    if (positionals.length !== (command.params?.length ?? 0))
      usage(
        `Expected ${(command.params ?? []).map((param) => `<${param}>`).join(" ") || "no positional arguments"}.`,
      );
    const flavor = values.flavor ?? "development";
    if (flavor !== "development" && flavor !== "production")
      usage("--flavor must be development or production.");
    const params: Record<string, string> = {};
    (command.params ?? []).forEach((key, index) => {
      const value = positionals[index];
      if (!value) usage(`Missing ${key}.`);
      params[key] = value;
    });
    if (typeof values.inbox === "string") params.inbox_id = values.inbox;
    const endpoint =
      typeof values.inbox === "string" && command.scopedEndpoint !== undefined
        ? command.scopedEndpoint
        : command.endpoint;
    let path = endpoint.path.replace(/:([a-z_]+)/g, (_, key: string) => {
      const value = params[key];
      if (value === undefined) usage(`Missing ${key}.`);
      return encodeURIComponent(value);
    });
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(fields(command.query, values))) {
      for (const entry of Array.isArray(value) ? value : [value]) query.append(key, String(entry));
    }
    if (query.size > 0) path += `?${query}`;
    let body: unknown;
    if (command.body !== undefined) {
      const bodyFlags = fields(command.body, values);
      if (values.data !== undefined && values["data-file"] !== undefined)
        usage("Choose --data or --data-file.");
      if (
        (values.data !== undefined || values["data-file"] !== undefined) &&
        Object.keys(bodyFlags).length > 0
      )
        usage("Do not combine payload JSON with body flags.");
      if (typeof values.data === "string" || typeof values["data-file"] === "string") {
        try {
          const file = values["data-file"];
          const json =
            typeof values.data === "string"
              ? values.data
              : file === "-"
                ? await (io.readStdin ?? readStdin)()
                : await readFile(String(file), "utf8");
          body = JSON.parse(json);
        } catch {
          usage("Cannot read the JSON payload. Use --data or a readable --data-file.");
        }
      } else body = bodyFlags;
      if (command.tokenInput) {
        if (values["token-stdin"] && io.env.INBOT_CLOUDFLARE_API_TOKEN !== undefined)
          usage("Choose INBOT_CLOUDFLARE_API_TOKEN or --token-stdin.");
        const token = values["token-stdin"]
          ? (await (io.readStdin ?? readStdin)()).replace(/[\r\n]+$/, "")
          : io.env.INBOT_CLOUDFLARE_API_TOKEN;
        if (token === undefined) usage("Set INBOT_CLOUDFLARE_API_TOKEN or use --token-stdin.");
        body = { ...bodyFlags, api_token: token };
      }
      const payload = endpoint.payload.get("application/json");
      if (payload === undefined) throw new Error("Missing payload schema");
      try {
        decodeWire(Schema.Union(payload.schemas), body);
      } catch {
        usage("The payload does not match the shared REST schema.");
      }
    }
    const auth = await connection(
      { flavor, ...(typeof values.home === "string" ? { home: values.home } : {}) },
      io.env,
    );
    let idempotencyKey: string | undefined;
    if (command.idempotent) {
      try {
        idempotencyKey = Schema.decodeUnknownSync(IdempotencyKey)(
          values["idempotency-key"] ?? randomUUID(),
        );
      } catch {
        usage("Invalid --idempotency-key. Use 1-256 letters, digits, or . _ ~ -.");
      }
      io.stderr(`Idempotency-Key: ${idempotencyKey}\n`);
    }
    let result = await request(auth, endpoint, path, body, idempotencyKey, command.response);
    if (command.download && !values.json) {
      await download(
        auth.url,
        result,
        typeof values.output === "string" ? values.output : undefined,
        io,
      );
      return 0;
    }
    if (command.secret && !values["show-secret"] && record(result)) {
      const { api_key: _secret, secret: _webhookSecret, ...metadata } = result;
      result = metadata;
      io.stderr("Secret omitted. Use --show-secret at creation to print the one-time secret.\n");
    }
    io.stdout(
      values.json
        ? `${JSON.stringify(result ?? null)}\n`
        : command.response === "text" && typeof result === "string"
          ? result
          : humanOutput(result),
    );
    if (values.browser && record(result) && typeof result.url === "string") {
      const url = new URL(result.url);
      if (url.origin !== auth.url || url.pathname !== "/login")
        throw new Error("Invalid login URL");
      await (io.openBrowser ?? openBrowser)(url.href);
    }
    return 0;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code.startsWith("ERR_PARSE_ARGS_")
    ) {
      io.stderr(
        `${JSON.stringify({ code: "validation_error", message: "Invalid command options.", fix: "Run the command with --help." })}\n`,
      );
      return 2;
    }
    const failure =
      error instanceof CliError
        ? error
        : new CliError(
            {
              code: "service_unavailable",
              message: "The CLI could not complete the command.",
              fix: "Check the command, connection, and local file permissions.",
            },
            1,
          );
    io.stderr(`${JSON.stringify(failure.detail)}\n`);
    return failure.exitCode;
  }
}

async function openBrowser(url: string): Promise<void> {
  const program =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Browser launch failed")),
    );
  });
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) {
    const value: unknown = chunk;
    if (typeof value !== "string") throw new Error("Invalid stdin encoding");
    text += value;
  }
  return text;
}
