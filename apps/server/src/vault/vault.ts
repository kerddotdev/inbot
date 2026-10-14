import { randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { Clock, Context, Effect, Layer, Redacted, Result, Schema } from "effect";
import { ErrorResponse } from "../../../../packages/contracts/src/errors.js";
import { CurrentPrincipal, type Principal } from "../../../../packages/contracts/src/security.js";
import {
  CreateCredentialRequest,
  UpdateCredentialRequest,
  GenerateFieldRequest,
  ListCredentialsQuery,
  CredentialValue,
  type Credential,
  type CredentialFieldsResponse,
  type ListCredentialsResponse,
} from "../../../../packages/contracts/src/vault.js";
import type { CredentialEvent } from "../../../../packages/contracts/src/events.js";
import type { Permission } from "../../../../packages/contracts/src/api-keys.js";
import { allowedInboxes, authorize } from "../agent/authorization.js";
import { appendEvent } from "../events/log.js";
import { wireError } from "../http/errors.js";
import { MailboxError, notFound, validate, validationError } from "../mailbox/errors.js";
import { keysetWhere, page, preparePage, Where } from "../mailbox/queries.js";
import { getInbox } from "../mailbox/rows.js";
import { Store, type StoreService } from "../store.js";
import { generatePassword, PasswordRulesError } from "./generate.js";
import { credentialOrigins } from "./origins.js";
import { CredentialRow, credentialWire, fieldNames, getCredential } from "./rows.js";
import { normalizeTotp, totpCode, TotpError } from "./totp.js";

const FieldRow = Schema.Struct({
  name: Schema.String,
  value: Schema.RedactedFromValue(Schema.String),
});

function validateInput<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: unknown,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    throw validationError("The credential request is invalid.");
  }
}

function changeFields(
  db: Database.Database,
  id: string,
  input: UpdateCredentialRequest,
  timestamp: string,
) {
  const fields = new Map<string, Redacted.Redacted<string>>();
  for (const [name, value] of Object.entries(input.fields ?? {})) {
    fields.set(
      name,
      Redacted.make(validate(CredentialValue, name === "totp" ? normalizeTotp(value) : value)),
    );
  }
  if (input.generate !== undefined) {
    const { field = "password", ...options } = input.generate;
    fields.set(field, Redacted.make(validate(CredentialValue, generatePassword(options))));
  }
  const names = new Set(fieldNames(db, id));
  for (const name of input.remove_fields ?? []) names.delete(name);
  for (const name of fields.keys()) names.add(name);
  if (names.size > 32)
    throw validationError(
      "A credential can have at most 32 fields.",
      "Remove a field before adding another.",
    );
  for (const name of input.remove_fields ?? [])
    db.prepare("DELETE FROM credential_fields WHERE credential_id = ? AND name = ?").run(id, name);
  const set = db.prepare(`INSERT INTO credential_fields (credential_id, name, value, updated_at)
    VALUES (?, ?, ?, ?) ON CONFLICT (credential_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  for (const [name, value] of fields) set.run(id, name, Redacted.value(value), timestamp);
}

function credentialEvent(
  db: Database.Database,
  credential: Credential,
  type: CredentialEvent["event_type"],
  now: number,
) {
  appendEvent(
    db,
    {
      type: "event",
      event_type: type,
      event_id: randomUUID(),
      credential: {
        credential_id: credential.credential_id,
        inbox_id: credential.inbox_id,
        fields: credential.fields,
      },
    },
    now,
  );
}

export function makeVault(store: StoreService) {
  function run<A>(
    permission: Permission,
    inboxId: string | undefined,
    operation: (db: Database.Database, now: number, principal: Principal) => A,
  ) {
    return Effect.gen(function* () {
      yield* authorize(permission, inboxId);
      const principal = yield* CurrentPrincipal;
      const now = yield* Clock.currentTimeMillis;
      const result = yield* store.use((db): Result.Result<A, MailboxError | ErrorResponse> => {
        try {
          return Result.succeed(db.transaction(() => operation(db, now, principal)).immediate());
        } catch (error) {
          if (error instanceof PasswordRulesError || error instanceof TotpError)
            return Result.fail(validationError(error.message));
          if (error instanceof MailboxError || Schema.is(ErrorResponse)(error))
            return Result.fail(error);
          throw error;
        }
      });
      return yield* Effect.fromResult(result);
    });
  }

  function update(
    db: Database.Database,
    id: string,
    request: UpdateCredentialRequest,
    inboxId: string,
    now: number,
  ) {
    const row = getCredential(db, id, inboxId);
    const input = validateInput(UpdateCredentialRequest, request);
    const url = input.url ?? row.url;
    const origins = input.origins ?? row.origins;
    credentialOrigins(url ?? undefined, origins);
    const timestamp = new Date(now).toISOString();
    changeFields(db, id, input, timestamp);
    db.prepare(
      `UPDATE credentials SET name = ?, url = ?, origins = ?, username = ?, updated_at = ? WHERE credential_id = ?`,
    ).run(
      input.name ?? row.name,
      url,
      JSON.stringify(origins),
      input.username ?? row.username,
      timestamp,
      id,
    );
    const credential = credentialWire(db, getCredential(db, id, inboxId));
    credentialEvent(db, credential, "credential.updated", now);
    return credential;
  }

  return {
    list: (request: ListCredentialsQuery = {}, inboxId?: string) =>
      run("credential_read", inboxId, (db, _now, principal): ListCredentialsResponse => {
        const query = validateInput(ListCredentialsQuery, request);
        if (inboxId !== undefined) getInbox(db, inboxId);
        const ids = principal.kind === "owner" ? undefined : allowedInboxes(principal.grant);
        const { limit, expected, cursor } = preparePage(query, {
          resource: "credentials",
          scope: principal.kind === "owner" ? "owner" : principal.api_key_id,
          inboxId,
          q: query.q?.toLowerCase(),
          ascending: query.ascending ?? false,
        });
        const where = new Where();
        if (inboxId !== undefined) where.add("inbox_id = ?", inboxId);
        if (ids !== undefined)
          where.add(`inbox_id IN (${ids.map(() => "?").join(",") || "NULL"})`, ...ids);
        if (query.q !== undefined) {
          db.function("vault_contains", { deterministic: true }, (value: unknown, q: unknown) =>
            Number(
              typeof value === "string" &&
                typeof q === "string" &&
                value.toLowerCase().includes(q.toLowerCase()),
            ),
          );
          where.add(
            "(vault_contains(name, ?) OR vault_contains(url, ?) OR vault_contains(username, ?))",
            query.q,
            query.q,
            query.q,
          );
        }
        keysetWhere(where, cursor, "created_at", "credential_id", query.ascending ?? false);
        const order = query.ascending ? "ASC" : "DESC";
        const rows = db
          .prepare(`SELECT *, created_at AS cursor_key, credential_id AS cursor_id FROM credentials
          WHERE ${where.sql} ORDER BY created_at ${order}, credential_id ${order} LIMIT ?`)
          .all(...where.params, limit + 1);
        const { items, ...fields } = page(rows, limit, expected, (row) =>
          credentialWire(db, Schema.decodeUnknownSync(CredentialRow)(row)),
        );
        return { ...fields, credentials: items };
      }),
    get: (id: string, inboxId: string) =>
      run("credential_read", inboxId, (db) => credentialWire(db, getCredential(db, id, inboxId))),
    create: (request: CreateCredentialRequest, inboxId: string) =>
      run("credential_create", inboxId, (db, now, principal) => {
        getInbox(db, inboxId);
        const input = validateInput(CreateCredentialRequest, request);
        credentialOrigins(input.url, input.origins ?? []);
        const id = randomBytes(16).toString("hex");
        const timestamp = new Date(now).toISOString();
        db.prepare(`INSERT INTO credentials (credential_id, inbox_id, name, url, origins, username, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id,
          inboxId,
          input.name,
          input.url ?? null,
          JSON.stringify(input.origins ?? []),
          input.username ?? null,
          principal.kind === "owner" ? null : principal.api_key_id,
          timestamp,
          timestamp,
        );
        changeFields(db, id, input, timestamp);
        const credential = credentialWire(db, getCredential(db, id, inboxId));
        credentialEvent(db, credential, "credential.created", now);
        return credential;
      }),
    update: (id: string, request: UpdateCredentialRequest, inboxId: string) =>
      run("credential_update", inboxId, (db, now) => update(db, id, request, inboxId, now)),
    delete: (id: string, inboxId: string) =>
      run("credential_delete", inboxId, (db, now) => {
        const credential = credentialWire(db, getCredential(db, id, inboxId));
        db.prepare("DELETE FROM credentials WHERE credential_id = ?").run(id);
        credentialEvent(db, credential, "credential.deleted", now);
      }),
    generate: (id: string, request: GenerateFieldRequest, inboxId: string) =>
      run("credential_update", inboxId, (db, now) =>
        update(db, id, { generate: validateInput(GenerateFieldRequest, request) }, inboxId, now),
      ),
    totp: (id: string, inboxId: string) =>
      run("credential_totp", inboxId, (db, now, principal) => {
        getCredential(db, id, inboxId);
        const row = Schema.decodeUnknownSync(Schema.optional(FieldRow))(
          db
            .prepare(
              "SELECT name, value FROM credential_fields WHERE credential_id = ? AND name = 'totp'",
            )
            .get(id),
        );
        if (row === undefined) throw notFound();
        const code = totpCode(Redacted.value(row.value), now);
        if (principal.kind !== "owner")
          db.prepare("UPDATE credentials SET last_used_at = ? WHERE credential_id = ?").run(
            new Date(now).toISOString(),
            id,
          );
        return code;
      }),
    reveal: (id: string, inboxId: string) =>
      run("credential_read", inboxId, (db, _now, principal): CredentialFieldsResponse => {
        if (principal.kind !== "owner")
          throw wireError(
            "missing_permission",
            "This operation requires owner authentication.",
            "Use the local owner token from connection.json.",
          );
        getCredential(db, id, inboxId);
        const rows = Schema.decodeUnknownSync(Schema.Array(FieldRow))(
          db
            .prepare(
              "SELECT name, value FROM credential_fields WHERE credential_id = ? ORDER BY name",
            )
            .all(id),
        );
        return {
          credential_id: id,
          fields: Object.fromEntries(rows.map((row) => [row.name, Redacted.value(row.value)])),
        };
      }),
  };
}

export class Vault extends Context.Service<Vault, ReturnType<typeof makeVault>>()("inbot/Vault") {
  static readonly Live = Layer.effect(Vault, Effect.map(Store, makeVault));
}
