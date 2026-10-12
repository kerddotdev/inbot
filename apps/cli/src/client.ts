import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { resolveHome } from "../../server/src/home.js";
import { ErrorResponse } from "../../../packages/contracts/src/errors.js";
import { CliError, errorExitCode, usage } from "./errors.js";
import type { Endpoint } from "./commands.js";

const Connection = Schema.Struct({ url: Schema.String, token: Schema.String });
export type Environment = Readonly<Record<string, string | undefined>>;

export async function connection(
  options: { home?: string; flavor: "development" | "production" },
  env: Environment,
) {
  let result: typeof Connection.Type;
  if (env.INBOT_URL !== undefined || env.INBOT_API_KEY !== undefined) {
    if (!env.INBOT_URL || !env.INBOT_API_KEY) usage("Set both INBOT_URL and INBOT_API_KEY.");
    result = { url: env.INBOT_URL, token: env.INBOT_API_KEY };
  } else {
    try {
      const home = resolveHome({
        flavor: options.flavor,
        ...(options.home === undefined ? {} : { flag: options.home }),
        ...(env.INBOT_HOME === undefined ? {} : { env: env.INBOT_HOME }),
      });
      result = Schema.decodeUnknownSync(Schema.fromJsonString(Connection))(
        await readFile(join(home, "connection.json"), "utf8"),
      );
    } catch {
      throw new CliError(
        {
          code: "service_unavailable",
          message: "Cannot read the owner connection file.",
          fix: "Start inbot serve and use the same --home, INBOT_HOME, and --flavor.",
        },
        10,
      );
    }
  }
  try {
    const url = new URL(result.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !result.token.trim()
    )
      throw new Error();
    return { url: url.origin, token: result.token };
  } catch {
    usage("The connection requires an HTTP(S) origin and a nonempty bearer credential.");
  }
}

export function decodeWire(schema: Schema.Top, value: unknown): unknown {
  return Schema.decodeUnknownSync(Schema.toType(schema), { onExcessProperty: "error" })(value);
}

export async function request(
  connection: { url: string; token: string },
  endpoint: Endpoint,
  path: string,
  body: unknown,
  idempotencyKey?: string,
  responseKind?: "text",
): Promise<unknown> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${connection.url}${path}`, {
      method: endpoint.method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${connection.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    text = await response.text();
  } catch {
    throw new CliError(
      {
        code: "service_unavailable",
        message: "Cannot reach the Inbot service.",
        fix: "Check the connection and server. For sends, retry with the printed idempotency key and identical payload.",
      },
      10,
    );
  }
  let wire: unknown;
  try {
    wire =
      response.ok && responseKind === "text" ? text : text === "" ? undefined : JSON.parse(text);
  } catch {
    throw invalidResponse();
  }
  if (!response.ok) {
    throwResponseError(wire);
  }
  for (const schema of endpoint.success) {
    try {
      decodeWire(schema, wire);
      return wire;
    } catch {
      /* Another success variant may match. */
    }
  }
  throw invalidResponse();
}

export function throwResponseError(wire: unknown): never {
  let error: ErrorResponse;
  try {
    error = Schema.decodeUnknownSync(ErrorResponse)(wire);
  } catch {
    throw invalidResponse();
  }
  throw new CliError(error, errorExitCode(error));
}

export function invalidResponse() {
  return new CliError(
    {
      code: "service_unavailable",
      message: "The server response does not match the shared contract.",
      fix: "Use matching CLI and server versions.",
    },
    10,
  );
}
