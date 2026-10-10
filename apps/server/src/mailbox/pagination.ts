import { createHash } from "node:crypto";
import { Schema } from "effect";
import { staleToken, validationError } from "./errors.js";

const Cursor = Schema.Struct({
  version: Schema.Literal(1),
  fingerprint: Schema.String,
  key: Schema.String,
  id: Schema.String,
});
export type Cursor = typeof Cursor.Type;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return [...new Set(value.map(canonical))].sort();
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, entry]) => key !== "page_token" && key !== "limit" && entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

export function fingerprint(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("base64url");
}

export function pageLimit(limit: number | undefined) {
  const result = limit ?? 20;
  if (!Number.isInteger(result) || result < 1 || result > 100) {
    throw validationError("The page limit must be between 1 and 100.");
  }
  return result;
}

export function readCursor(token: string | undefined, expected: string) {
  if (token === undefined) return undefined;
  try {
    if (token.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(token)) throw staleToken();
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) throw staleToken();
    const cursor = Schema.decodeUnknownSync(Cursor)(JSON.parse(bytes.toString("utf8")));
    if (cursor.fingerprint !== expected) throw staleToken();
    return cursor;
  } catch {
    throw staleToken();
  }
}

export function nextToken(expected: string, key: string, id: string) {
  return Buffer.from(JSON.stringify({ version: 1, fingerprint: expected, key, id })).toString(
    "base64url",
  );
}

export function timestampKey(timestamp: string) {
  const fraction = timestamp.match(/\.(\d+)/)?.[1]?.replace(/0+$/, "") || "0";
  return `${new Date(timestamp).toISOString().slice(0, 19)}.${fraction}`;
}
