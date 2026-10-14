import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { Clock, Effect, Redacted, Result, Schema } from "effect";
import {
  BITWARDEN_MAX_BYTES,
  BitwardenExport,
  BitwardenImport,
  BitwardenLoginItem,
  ImportCredentialsQuery,
  type ImportCredentialsResponse,
} from "../../../../packages/contracts/src/bitwarden.js";
import { CurrentPrincipal } from "../../../../packages/contracts/src/security.js";
import { CreateCredentialRequest } from "../../../../packages/contracts/src/vault.js";
import { appendEvent } from "../events/log.js";
import { wireError } from "../http/errors.js";
import { TunnelTraffic } from "../http/tunnel-policy.js";
import { MailboxError, validate, validationError } from "../mailbox/errors.js";
import { getInbox } from "../mailbox/rows.js";
import type { StoreService } from "../store.js";
import { credentialOrigins } from "./origins.js";
import { CredentialRow, credentialWire, getCredential } from "./rows.js";
import { normalizeTotp } from "./totp.js";

function folderId(inboxId: string) {
  const hash = createHash("sha256").update(inboxId).digest("hex").slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
}

function customName(input: string, used: Set<string>) {
  let base = input.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!/^[a-z]/.test(base)) base = `f_${base}`;
  base = base.slice(0, 64);
  let name = base;
  for (let suffix = 2; used.has(name); suffix++) {
    const tail = `_${suffix}`;
    name = `${base.slice(0, 64 - tail.length)}${tail}`;
  }
  used.add(name);
  return name;
}

function mapItem(item: BitwardenLoginItem, count: (reason: string) => void) {
  if (item.name.length === 0) return { reason: "invalid_name" };
  if (item.name.length > 200) return { reason: "name_too_long" };
  if ((item.login?.username?.length ?? 0) > 320) return { reason: "username_too_long" };
  const fields = new Map<string, string>();
  for (const [name, value] of Object.entries({
    password: item.login?.password,
    totp: item.login?.totp,
    notes: item.notes,
  })) {
    if (value) fields.set(name, value);
  }
  const used = new Set(["password", "totp", "notes"]);
  for (const field of item.fields ?? []) {
    if (!field.value) continue;
    if (field.type !== 0 && field.type !== 1) {
      count("unsupported_field");
      continue;
    }
    fields.set(customName(field.name ?? "", used), field.value);
    if (fields.size > 32) return { reason: "too_many_fields" };
  }
  if ([...fields.values()].some((value) => value.length > 16384))
    return { reason: "value_too_long" };
  const totp = fields.get("totp");
  if (totp !== undefined) {
    try {
      const normalized = normalizeTotp(totp);
      if (normalized.length > 16384) return { reason: "value_too_long" };
      fields.set("totp", normalized);
    } catch {
      return { reason: "invalid_totp" };
    }
  }
  let url: string | undefined;
  const origins = new Set<string>();
  for (const entry of item.login?.uris ?? []) {
    try {
      const uri = entry.uri ?? "";
      const [origin] = credentialOrigins(uri, []);
      if (origin === undefined) throw new Error();
      url ??= uri;
      origins.add(origin);
    } catch {
      count("invalid_uri");
    }
  }
  if (origins.size > 16) return { reason: "too_many_origins" };
  const firstOrigin = url === undefined ? undefined : new URL(url).origin;
  return {
    input: validate(CreateCredentialRequest, {
      name: item.name,
      ...(url === undefined ? {} : { url }),
      origins: [...origins].filter((origin) => origin !== firstOrigin),
      ...(item.login?.username == null ? {} : { username: item.login.username }),
      fields: Object.fromEntries(fields),
    }),
  };
}

function importItems(
  db: Database.Database,
  body: unknown,
  query: ImportCredentialsQuery,
  now: number,
) {
  const input = validate(BitwardenImport, body);
  if (input.encrypted === true)
    throw validationError(
      "Encrypted Bitwarden exports cannot be imported.",
      "Export unencrypted JSON from Bitwarden and import that file locally.",
    );
  if (input.items === undefined)
    throw validationError("The Bitwarden export must contain an items array.");
  getInbox(db, query.inbox_id);
  const reasons = new Map<string, number>();
  const count = (reason: string) => reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  const credentials: ImportCredentialsResponse["credentials"][number][] = [];
  let skipped = 0;
  const timestamp = new Date(now).toISOString();
  for (const value of input.items) {
    let item: BitwardenLoginItem;
    try {
      const { type } = Schema.decodeUnknownSync(Schema.Struct({ type: Schema.Int }))(value);
      if (type !== 1) {
        skipped++;
        count("unsupported_type");
        continue;
      }
      item = Schema.decodeUnknownSync(BitwardenLoginItem)(value);
    } catch {
      skipped++;
      count("invalid_item");
      continue;
    }
    const mapped = mapItem(item, count);
    if (mapped.input === undefined) {
      skipped++;
      count(mapped.reason);
      continue;
    }
    const request = mapped.input;
    if (
      query.on_duplicate !== "create" &&
      db
        .prepare(
          "SELECT 1 FROM credentials WHERE inbox_id = ? AND name = ? AND username IS ? LIMIT 1",
        )
        .get(query.inbox_id, request.name, request.username ?? null) !== undefined
    ) {
      skipped++;
      count("duplicate");
      continue;
    }
    const id = randomBytes(16).toString("hex");
    db.prepare(`INSERT INTO credentials (credential_id, inbox_id, name, url, origins, username, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`).run(
      id,
      query.inbox_id,
      request.name,
      request.url ?? null,
      JSON.stringify(request.origins ?? []),
      request.username ?? null,
      timestamp,
      timestamp,
    );
    const insert = db.prepare(
      "INSERT INTO credential_fields (credential_id, name, value, updated_at) VALUES (?, ?, ?, ?)",
    );
    for (const [name, value] of Object.entries(request.fields ?? {}))
      insert.run(id, name, value, timestamp);
    const credential = credentialWire(db, getCredential(db, id, query.inbox_id));
    appendEvent(
      db,
      {
        type: "event",
        event_type: "credential.created",
        event_id: randomUUID(),
        credential: { credential_id: id, inbox_id: query.inbox_id, fields: credential.fields },
      },
      now,
    );
    credentials.push(credential);
  }
  return {
    imported: credentials.length,
    skipped,
    reasons: Object.fromEntries(reasons),
    credentials,
  };
}

export function makeBitwarden(store: StoreService) {
  function run<A>(operation: (db: Database.Database, now: number) => A) {
    return Effect.gen(function* () {
      if ((yield* CurrentPrincipal).kind !== "owner" || (yield* TunnelTraffic))
        return yield* Effect.fail(
          wireError(
            "missing_permission",
            "Credential import and export require the local owner.",
            "Sign in as owner using the Inbot host's loopback URL.",
          ),
        );
      const now = yield* Clock.currentTimeMillis;
      const result = yield* store.use((db): Result.Result<A, MailboxError> => {
        try {
          return Result.succeed(db.transaction(() => operation(db, now)).immediate());
        } catch (error) {
          if (error instanceof MailboxError) return Result.fail(error);
          throw error;
        }
      });
      return yield* Effect.fromResult(result);
    });
  }
  return {
    exportBitwarden: (inboxId?: string) =>
      run((db): BitwardenExport => {
        if (inboxId !== undefined) getInbox(db, inboxId);
        const inboxes = Schema.decodeUnknownSync(
          Schema.Array(Schema.Struct({ inbox_id: Schema.String })),
        )(
          db
            .prepare(
              `SELECT inbox_id FROM inboxes ${inboxId === undefined ? "" : "WHERE inbox_id = ?"} ORDER BY inbox_id`,
            )
            .all(...(inboxId === undefined ? [] : [inboxId])),
        );
        const rows = Schema.decodeUnknownSync(Schema.Array(CredentialRow))(
          db
            .prepare(
              `SELECT * FROM credentials ${inboxId === undefined ? "" : "WHERE inbox_id = ?"} ORDER BY credential_id`,
            )
            .all(...(inboxId === undefined ? [] : [inboxId])),
        );
        return {
          encrypted: false,
          folders: inboxes.map(({ inbox_id }) => ({ id: folderId(inbox_id), name: inbox_id })),
          items: rows.map((row) => {
            const fields = Schema.decodeUnknownSync(
              Schema.Array(
                Schema.Struct({
                  name: Schema.String,
                  value: Schema.RedactedFromValue(Schema.String),
                }),
              ),
            )(
              db
                .prepare(
                  "SELECT name, value FROM credential_fields WHERE credential_id = ? ORDER BY name",
                )
                .all(row.credential_id),
            );
            const values = new Map(
              fields.map((field) => [field.name, Redacted.value(field.value)]),
            );
            const origins = credentialOrigins(row.url ?? undefined, row.origins);
            const firstOrigin = row.url === null ? undefined : new URL(row.url).origin;
            return {
              id: row.credential_id,
              folderId: folderId(row.inbox_id),
              type: 1,
              name: row.name,
              notes: values.get("notes") ?? null,
              login: {
                username: row.username,
                password: values.get("password") ?? null,
                totp: values.get("totp") ?? null,
                uris: [
                  ...(row.url === null ? [] : [row.url]),
                  ...origins.filter((origin) => origin !== firstOrigin),
                ].map((uri) => ({ uri, match: null })),
              },
              fields: fields
                .filter((field) => !["password", "totp", "notes"].includes(field.name))
                .map((field) => ({
                  name: field.name,
                  value: Redacted.value(field.value),
                  type: 1,
                })),
            };
          }),
        };
      }),
    importBitwarden: (body: unknown, query: ImportCredentialsQuery) =>
      run((db, now) => {
        if (Buffer.byteLength(JSON.stringify(body) ?? "", "utf8") > BITWARDEN_MAX_BYTES)
          throw validationError(
            "The Bitwarden export exceeds 5 MB.",
            "Split the export into files of at most 5 MB.",
          );
        return importItems(db, body, validate(ImportCredentialsQuery, query), now);
      }),
  };
}
