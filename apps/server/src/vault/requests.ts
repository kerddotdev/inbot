import { randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { Clock, Context, Effect, Layer, Result, Schema } from "effect";
import {
  CredentialRequest,
  CredentialRequestState,
  CreateCredentialRequestRequest,
  FulfillCredentialRequestRequest,
  ListCredentialRequestsQuery,
  type ListCredentialRequestsResponse,
} from "../../../../packages/contracts/src/credential-requests.js";
import { CredentialValue } from "../../../../packages/contracts/src/vault.js";
import type { CredentialRequestEvent } from "../../../../packages/contracts/src/events.js";
import { ErrorResponse } from "../../../../packages/contracts/src/errors.js";
import { CurrentPrincipal, type Principal } from "../../../../packages/contracts/src/security.js";
import { allowedInboxes, authorize, inScope } from "../agent/authorization.js";
import { appendEvent } from "../events/log.js";
import { wireError } from "../http/errors.js";
import { TunnelTraffic } from "../http/tunnel-policy.js";
import { MailboxError, notFound, validationError } from "../mailbox/errors.js";
import { keysetWhere, page, preparePage, Where } from "../mailbox/queries.js";
import { getInbox } from "../mailbox/rows.js";
import { Store, type StoreService } from "../store.js";
import { credentialOrigins } from "./origins.js";
import { credentialWire, getCredential } from "./rows.js";
import { normalizeTotp, TotpError } from "./totp.js";

const lifetime = 7 * 24 * 60 * 60_000;
const RequestRow = Schema.Struct({
  request_id: Schema.String,
  inbox_id: Schema.String,
  api_key_id: Schema.NullOr(Schema.String),
  name: Schema.String,
  url: Schema.NullOr(Schema.String),
  username: Schema.NullOr(Schema.String),
  fields: Schema.fromJsonString(CreateCredentialRequestRequest.fields.fields),
  reason: Schema.String,
  state: CredentialRequestState,
  credential_id: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  decided_at: Schema.NullOr(Schema.String),
  expires_at: Schema.String,
});
type RequestRow = typeof RequestRow.Type;

function input<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: unknown,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    throw validationError("The credential request is invalid.");
  }
}

function getRequest(db: Database.Database, id: string, principal: Principal, inboxId?: string) {
  const row = Schema.decodeUnknownSync(Schema.optional(RequestRow))(
    db.prepare("SELECT * FROM credential_requests WHERE request_id = ?").get(id),
  );
  if (
    row === undefined ||
    (inboxId !== undefined && row.inbox_id !== inboxId) ||
    !inScope(principal, row.inbox_id) ||
    (principal.kind === "agent" && row.api_key_id !== principal.api_key_id)
  )
    throw notFound();
  return row;
}

function wire(db: Database.Database, row: RequestRow, principal: Principal): CredentialRequest {
  return {
    request_id: row.request_id,
    inbox_id: row.inbox_id,
    name: row.name,
    fields: row.fields,
    reason: row.reason,
    state: row.state,
    created_at: row.created_at,
    expires_at: row.expires_at,
    ...(row.url === null ? {} : { url: row.url }),
    ...(row.username === null ? {} : { username: row.username }),
    ...(row.decided_at === null ? {} : { decided_at: row.decided_at }),
    ...(principal.kind === "owner" && row.api_key_id !== null
      ? { requested_by: row.api_key_id }
      : {}),
    ...(row.state === "fulfilled" && row.credential_id !== null
      ? { credential: credentialWire(db, getCredential(db, row.credential_id, row.inbox_id)) }
      : {}),
  };
}

function event(
  db: Database.Database,
  row: RequestRow,
  eventType: CredentialRequestEvent["event_type"],
  now: number,
) {
  appendEvent(
    db,
    {
      type: "event",
      event_type: eventType,
      event_id: randomUUID(),
      credential_request: {
        request_id: row.request_id,
        inbox_id: row.inbox_id,
        fields: row.fields,
        ...(row.credential_id === null ? {} : { credential_id: row.credential_id }),
      },
    },
    now,
  );
}

function requirePending(row: RequestRow) {
  if (row.state !== "pending")
    throw validationError(
      "The credential request is no longer pending.",
      "Read the current request state. Create a new request if credentials are still needed.",
    );
}

export function makeCredentialRequests(store: StoreService) {
  function run<A>(
    inboxId: string | undefined,
    operation: (db: Database.Database, now: number, principal: Principal) => A,
    ownerOnly = false,
  ) {
    return Effect.gen(function* () {
      const principal = yield* CurrentPrincipal;
      if (ownerOnly && principal.kind !== "owner")
        return yield* Effect.fail(
          wireError(
            "missing_permission",
            "Credential request decisions require owner authentication.",
            "Ask the owner to fulfill or decline the request in Inbot.",
          ),
        );
      yield* authorize("credential_request", inboxId);
      const now = yield* Clock.currentTimeMillis;
      const result = yield* store.use((db): Result.Result<A, MailboxError | ErrorResponse> => {
        // Expiry must persist even when a subsequent decision is rejected.
        db.prepare(
          "UPDATE credential_requests SET state = 'expired' WHERE state = 'pending' AND expires_at <= ?",
        ).run(new Date(now).toISOString());
        try {
          return Result.succeed(db.transaction(() => operation(db, now, principal)).immediate());
        } catch (error) {
          if (error instanceof TotpError) return Result.fail(validationError(error.message));
          if (error instanceof MailboxError || Schema.is(ErrorResponse)(error))
            return Result.fail(error);
          throw error;
        }
      });
      return yield* Effect.fromResult(result);
    });
  }

  return {
    create: (request: CreateCredentialRequestRequest, inboxId: string) =>
      run(inboxId, (db, now, principal) => {
        if (principal.kind === "owner")
          throw validationError(
            "Only agents can request credentials.",
            "Use an agent API key, or create a credential directly as owner.",
          );
        getInbox(db, inboxId);
        const value = input(CreateCredentialRequestRequest, request);
        credentialOrigins(value.url, []);
        const id = randomBytes(16).toString("hex");
        db.prepare(`INSERT INTO credential_requests
        (request_id, inbox_id, api_key_id, name, url, username, fields, reason, state, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(
          id,
          inboxId,
          principal.api_key_id,
          value.name,
          value.url ?? null,
          value.username ?? null,
          JSON.stringify(value.fields),
          value.reason,
          new Date(now).toISOString(),
          new Date(now + lifetime).toISOString(),
        );
        const row = getRequest(db, id, principal, inboxId);
        event(db, row, "credential.requested", now);
        return wire(db, row, principal);
      }),
    get: (id: string, inboxId: string) =>
      run(inboxId, (db, _now, principal) =>
        wire(db, getRequest(db, id, principal, inboxId), principal),
      ),
    list: (request: ListCredentialRequestsQuery = {}) =>
      run(undefined, (db, _now, principal): ListCredentialRequestsResponse => {
        const query = input(ListCredentialRequestsQuery, request);
        const ids = principal.kind === "owner" ? undefined : allowedInboxes(principal.grant);
        const { limit, expected, cursor } = preparePage(query, {
          resource: "credential_requests",
          scope: principal.kind === "owner" ? "owner" : principal.api_key_id,
          inboxIds: ids,
          state: query.state,
          ascending: query.ascending ?? false,
        });
        const where = new Where();
        if (principal.kind === "agent") where.add("api_key_id = ?", principal.api_key_id);
        if (ids !== undefined)
          where.add(`inbox_id IN (${ids.map(() => "?").join(",") || "NULL"})`, ...ids);
        if (query.state !== undefined) where.add("state = ?", query.state);
        keysetWhere(where, cursor, "created_at", "request_id", query.ascending ?? false);
        const order = query.ascending ? "ASC" : "DESC";
        const rows = db
          .prepare(`SELECT *, created_at AS cursor_key, request_id AS cursor_id FROM credential_requests
        WHERE ${where.sql} ORDER BY created_at ${order}, request_id ${order} LIMIT ?`)
          .all(...where.params, limit + 1);
        const { items, ...fields } = page(rows, limit, expected, (row) =>
          wire(db, Schema.decodeUnknownSync(RequestRow)(row), principal),
        );
        return { ...fields, credential_requests: items };
      }),
    fulfill: (id: string, request: FulfillCredentialRequestRequest) =>
      Effect.gen(function* () {
        if (yield* TunnelTraffic)
          return yield* Effect.fail(
            wireError(
              "missing_permission",
              "Credential request fulfillment is local-only.",
              "Fulfill from the local web UI or CLI on the Inbot host.",
            ),
          );
        return yield* run(
          undefined,
          (db, now, principal) => {
            const row = getRequest(db, id, principal);
            requirePending(row);
            const value = input(FulfillCredentialRequestRequest, request);
            const names = Object.keys(value.fields);
            if (
              names.length !== row.fields.length ||
              names.some((name) => !row.fields.includes(name))
            )
              throw validationError(
                "Fulfillment must provide exactly the requested field names.",
                "Read the request and supply every requested field without extra fields.",
              );
            const fields = Object.entries(value.fields).map(([name, secret]) => [
              name,
              input(CredentialValue, name === "totp" ? normalizeTotp(secret) : secret),
            ]);
            const credentialId = randomBytes(16).toString("hex");
            const timestamp = new Date(now).toISOString();
            db.prepare(`INSERT INTO credentials (credential_id, inbox_id, name, url, origins, username, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`).run(
              credentialId,
              row.inbox_id,
              row.name,
              row.url,
              JSON.stringify(credentialOrigins(row.url ?? undefined, [])),
              value.username ?? row.username,
              timestamp,
              timestamp,
            );
            const insert = db.prepare(
              "INSERT INTO credential_fields (credential_id, name, value, updated_at) VALUES (?, ?, ?, ?)",
            );
            for (const [name, secret] of fields) insert.run(credentialId, name, secret, timestamp);
            db.prepare(
              "UPDATE credential_requests SET state = 'fulfilled', credential_id = ?, decided_at = ? WHERE request_id = ?",
            ).run(credentialId, timestamp, id);
            appendEvent(
              db,
              {
                type: "event",
                event_type: "credential.created",
                event_id: randomUUID(),
                credential: {
                  credential_id: credentialId,
                  inbox_id: row.inbox_id,
                  fields: row.fields,
                },
              },
              now,
            );
            const decided = getRequest(db, id, principal);
            event(db, decided, "credential.request_fulfilled", now);
            return wire(db, decided, principal);
          },
          true,
        );
      }),
    decline: (id: string) =>
      run(
        undefined,
        (db, now, principal) => {
          const row = getRequest(db, id, principal);
          if (row.state === "declined") return wire(db, row, principal);
          requirePending(row);
          db.prepare(
            "UPDATE credential_requests SET state = 'declined', decided_at = ? WHERE request_id = ?",
          ).run(new Date(now).toISOString(), id);
          const decided = getRequest(db, id, principal);
          event(db, decided, "credential.request_declined", now);
          return wire(db, decided, principal);
        },
        true,
      ),
  };
}

export class CredentialRequests extends Context.Service<
  CredentialRequests,
  ReturnType<typeof makeCredentialRequests>
>()("inbot/CredentialRequests") {
  static readonly Live = Layer.effect(
    CredentialRequests,
    Effect.map(Store, makeCredentialRequests),
  );
}
