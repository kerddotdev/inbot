import {
  checkUseApproval,
  consumeUseApproval,
  credentialUseLock,
  useFingerprint,
} from "./approvals.js";
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
  FillCredentialRequest,
  CaptureCredentialRequest,
  VaultSettings,
  type FillCredentialResponse,
  ResolveCredentialsRequest,
  type Credential,
  type CredentialFieldsResponse,
  type ListCredentialsResponse,
} from "../../../../packages/contracts/src/vault.js";
import type { CredentialEvent } from "../../../../packages/contracts/src/events.js";
import type { Permission } from "../../../../packages/contracts/src/api-keys.js";
import { allowedInboxes, authorize, inScope } from "../agent/authorization.js";
import { appendEvent } from "../events/log.js";
import { encrypt } from "../../../../packages/envelope/src/crypto.js";
import { TunnelTraffic } from "../http/tunnel-policy.js";
import { wireError } from "../http/errors.js";
import { MailboxError, notFound, validate, validationError } from "../mailbox/errors.js";
import { keysetWhere, page, preparePage, Where } from "../mailbox/queries.js";
import { getInbox } from "../mailbox/rows.js";
import { Store, type StoreService } from "../store.js";
import { CdpError, fillField, readField } from "./cdp.js";
import { checkCdpEndpoint } from "./endpoint-policy.js";
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

function settings(db: Database.Database): VaultSettings {
  return (
    Schema.decodeUnknownSync(
      Schema.optional(
        Schema.Struct({
          remote_cdp_hosts: Schema.fromJsonString(VaultSettings.fields.remote_cdp_hosts),
        }),
      ),
    )(db.prepare("SELECT remote_cdp_hosts FROM vault_settings WHERE id = 1").get()) ?? {
      remote_cdp_hosts: [],
    }
  );
}

function cdpFailure(error: unknown) {
  if (Schema.is(ErrorResponse)(error)) return error;
  if (error instanceof CdpError) {
    switch (error.code) {
      case "origin_not_allowed":
        return wireError(
          "missing_permission",
          error.message,
          "Open the credential's site, or add the origin to the credential.",
        );
      case "target_not_found":
        return validationError(
          "The browser page was not found.",
          "Open the page and provide its url or target_id.",
        );
      case "element_not_found":
        return validationError(
          "The browser element was not found.",
          "Wait for the field to appear and use a selector for the main page.",
        );
      case "element_not_editable":
        return validationError(
          "The browser element cannot be edited.",
          "Select an enabled, writable text input, textarea, or contenteditable element.",
        );
      case "cdp_timeout":
      case "cdp_unreachable":
      case "cdp_protocol":
        return wireError(
          "service_unavailable",
          "The browser CDP operation could not complete.",
          "Check the CDP endpoint and browser connection, inspect the page, then retry if needed.",
        );
    }
  }
  return wireError(
    "service_unavailable",
    "The browser operation could not complete.",
    "Check the CDP endpoint and browser connection, then retry if needed.",
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

  function useCredential(
    id: string,
    request: FillCredentialRequest | CaptureCredentialRequest,
    inboxId: string,
    capture: boolean,
    idempotencyKey?: string,
  ) {
    return Effect.gen(function* () {
      const snapshot = yield* run("credential_fill", inboxId, (db, now, principal) => {
        const input = validateInput(
          capture ? CaptureCredentialRequest : FillCredentialRequest,
          request,
        );
        const credential = credentialWire(db, getCredential(db, id, inboxId));
        if (credential.origins.length === 0)
          throw validationError(
            "The credential has no allowed origins.",
            "Set the credential url or origins first.",
          );
        if (
          !capture &&
          !db
            .prepare("SELECT 1 FROM credential_fields WHERE credential_id = ? AND name = ?")
            .get(id, input.field)
        )
          throw notFound();
        const approval = capture
          ? {}
          : checkUseApproval(
              db,
              principal,
              {
                kind: "fill",
                credentials: [{ credential_id: id, inbox_id: inboxId, fields: [input.field] }],
                fingerprint: useFingerprint({ kind: "fill", credential_id: id, ...input }),
                ...(input.url === undefined ? {} : { urlHint: input.url }),
              },
              now,
              idempotencyKey,
            );
        const row =
          capture || approval.error !== undefined
            ? undefined
            : Schema.decodeUnknownSync(Schema.optional(FieldRow))(
                db
                  .prepare(
                    "SELECT name, value FROM credential_fields WHERE credential_id = ? AND name = ?",
                  )
                  .get(id, input.field),
              );
        if (!capture && approval.error === undefined && row === undefined) throw notFound();
        return {
          input,
          approval,
          origins: credential.origins,
          value: row?.value,
          settings: settings(db),
        };
      });
      if (snapshot.approval.error !== undefined) return yield* Effect.fail(snapshot.approval.error);
      const tunnel = yield* TunnelTraffic;
      const checkEndpoint = (endpoint: string) =>
        checkCdpEndpoint(endpoint, tunnel, snapshot.settings);
      const { cdp_endpoint, field, ...target } = snapshot.input;
      const input = {
        ...target,
        endpoint: cdp_endpoint,
        allowedOrigins: snapshot.origins,
        checkEndpoint,
      };
      const now = yield* Clock.currentTimeMillis;
      const result = yield* Effect.tryPromise({
        try: async () => {
          if (capture) {
            const { value, ...page } = await readField(input);
            return { ...page, value: Redacted.make(value) };
          }
          if (snapshot.value === undefined) throw notFound();
          const value =
            field === "totp"
              ? totpCode(Redacted.value(snapshot.value), now).code
              : Redacted.value(snapshot.value);
          return { ...(await fillField({ ...input, value })), value: Redacted.make("") };
        },
        catch: cdpFailure,
      });
      return yield* run("credential_fill", inboxId, (db, completedAt) => {
        const current = credentialWire(db, getCredential(db, id, inboxId));
        if (!current.origins.includes(result.origin))
          throw wireError(
            "missing_permission",
            "The credential's allowed origins changed during the browser operation.",
            "Check the credential origins before retrying.",
          );
        consumeUseApproval(db, snapshot.approval, completedAt);
        const timestamp = new Date(completedAt).toISOString();
        if (capture) {
          changeFields(db, id, { fields: { [field]: Redacted.value(result.value) } }, timestamp);
          db.prepare("UPDATE credentials SET updated_at = ? WHERE credential_id = ?").run(
            timestamp,
            id,
          );
        }
        db.prepare("UPDATE credentials SET last_used_at = ? WHERE credential_id = ?").run(
          timestamp,
          id,
        );
        const credential = { credential_id: id, inbox_id: inboxId, field, origin: result.origin };
        appendEvent(
          db,
          capture
            ? {
                type: "event",
                event_type: "credential.captured",
                event_id: randomUUID(),
                credential,
              }
            : {
                type: "event",
                event_type: "credential.used",
                event_id: randomUUID(),
                credential: { ...credential, via: "fill" },
              },
          completedAt,
        );
        const filled: FillCredentialResponse = {
          credential_id: id,
          field,
          origin: result.origin,
          url: result.url,
        };
        return { filled, credential: credentialWire(db, getCredential(db, id, inboxId)) };
      });
    });
  }

  function ownerSettings(request?: VaultSettings) {
    return Effect.gen(function* () {
      const principal = yield* CurrentPrincipal;
      if (principal.kind !== "owner")
        return yield* Effect.fail(
          wireError(
            "missing_permission",
            "Vault settings require owner authentication.",
            "Sign in as the local owner.",
          ),
        );
      return yield* run("credential_read", undefined, (db) => {
        if (request !== undefined) {
          const input = validateInput(VaultSettings, request);
          db.prepare(`INSERT INTO vault_settings (id, remote_cdp_hosts) VALUES (1, ?)
            ON CONFLICT(id) DO UPDATE SET remote_cdp_hosts = excluded.remote_cdp_hosts`).run(
            JSON.stringify(input.remote_cdp_hosts),
          );
        }
        return settings(db);
      });
    });
  }

  return {
    fill: (id: string, request: FillCredentialRequest, inboxId: string, idempotencyKey?: string) =>
      useCredential(id, request, inboxId, false, idempotencyKey).pipe(
        credentialUseLock(store),
        Effect.map((result) => result.filled),
      ),
    capture: (id: string, request: CaptureCredentialRequest, inboxId: string) =>
      useCredential(id, request, inboxId, true).pipe(Effect.map((result) => result.credential)),
    settings: () => ownerSettings(),
    setSettings: (request: VaultSettings) => ownerSettings(request),
    resolve: (request: ResolveCredentialsRequest, idempotencyKey?: string) =>
      Effect.gen(function* () {
        if (yield* TunnelTraffic)
          return yield* Effect.fail(
            wireError(
              "missing_permission",
              "Credential resolution is local-only.",
              "Run credential resolution on the Inbot host using its loopback URL.",
            ),
          );
        yield* authorize("credential_run");
        const input = yield* Effect.try({
          try: () => validateInput(ResolveCredentialsRequest, request),
          catch: () => validationError("The credential resolution request is invalid."),
        });
        // Validate the recipient before recording use, without holding a database transaction.
        yield* Effect.tryPromise({
          try: () => encrypt(input.public_key, new Uint8Array(0)),
          catch: () => validationError("Invalid age public key.", "Use an X25519 age recipient."),
        });
        const resolved = yield* run("credential_run", undefined, (db, now, principal) => {
          const refs = input.refs.map((ref, index) => {
            const [id = "", field = ""] = ref.slice("inbot://credentials/".length).split("/");
            const credential = Schema.decodeUnknownSync(Schema.optional(CredentialRow))(
              db.prepare("SELECT * FROM credentials WHERE credential_id = ?").get(id),
            );
            const missing = wireError(
              "not_found",
              `Credential reference ${index + 1} was not found.`,
              "Check the reference and ask the owner to verify its inbox scope and field.",
            );
            if (
              credential === undefined ||
              !inScope(principal, credential.inbox_id) ||
              !db
                .prepare("SELECT 1 FROM credential_fields WHERE credential_id = ? AND name = ?")
                .get(id, field)
            )
              throw missing;
            return { ref, id, field, inboxId: credential.inbox_id };
          });
          const ids = [...new Set(refs.map((ref) => ref.id))];
          const approval = checkUseApproval(
            db,
            principal,
            {
              kind: "run",
              credentials: ids.map((id) => ({
                credential_id: id,
                inbox_id: refs.find((ref) => ref.id === id)?.inboxId ?? "",
                fields: refs.filter((ref) => ref.id === id).map((ref) => ref.field),
              })),
              fingerprint: useFingerprint({
                kind: "run",
                refs: input.refs,
              }),
            },
            now,
            idempotencyKey,
          );
          if (approval.error !== undefined) return { approval, values: undefined };
          const values = Object.fromEntries(
            refs.map(({ ref, id, field }) => {
              const row = Schema.decodeUnknownSync(FieldRow)(
                db
                  .prepare(
                    "SELECT name, value FROM credential_fields WHERE credential_id = ? AND name = ?",
                  )
                  .get(id, field),
              );
              const stored = Redacted.value(row.value);
              return [ref, field === "totp" ? totpCode(stored, now).code : stored];
            }),
          );
          for (const id of ids) {
            const ref = refs.find((ref) => ref.id === id);
            if (ref === undefined) throw notFound();
            db.prepare("UPDATE credentials SET last_used_at = ? WHERE credential_id = ?").run(
              new Date(now).toISOString(),
              id,
            );
            appendEvent(
              db,
              {
                type: "event",
                event_type: "credential.used",
                event_id: randomUUID(),
                credential: {
                  credential_id: id,
                  inbox_id: ref.inboxId,
                  field: ref.field,
                  via: "run",
                },
              },
              now,
            );
          }
          consumeUseApproval(db, approval, now);
          return { approval, values };
        });
        if (resolved.approval.error !== undefined)
          return yield* Effect.fail(resolved.approval.error);
        const values = resolved.values;
        const ciphertext = yield* Effect.tryPromise({
          try: () =>
            encrypt(input.public_key, new TextEncoder().encode(JSON.stringify({ values }))),
          catch: () =>
            wireError(
              "service_unavailable",
              "Could not encrypt credential values.",
              "Retry credential resolution on the Inbot host.",
            ),
        });
        return { ciphertext: Buffer.from(ciphertext).toString("base64") };
      }),
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
