import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { Clock, Effect, Result, Schema, Semaphore } from "effect";
import {
  CredentialUseKind,
  CredentialUseState,
  ListCredentialUseRequestsQuery,
  CredentialUseRequest,
  type ListCredentialUseRequestsResponse,
} from "../../../../packages/contracts/src/credential-use.js";
import { IdempotencyKey } from "../../../../packages/contracts/src/common.js";
import { ErrorResponse } from "../../../../packages/contracts/src/errors.js";
import { CredentialUseApprovalEvent } from "../../../../packages/contracts/src/events.js";
import { CurrentPrincipal, type Principal } from "../../../../packages/contracts/src/security.js";
import { CredentialFieldName } from "../../../../packages/contracts/src/vault.js";
import { appendEvent } from "../events/log.js";
import { wireError } from "../http/errors.js";
import { MailboxError, notFound, validate, validationError } from "../mailbox/errors.js";
import { keysetWhere, page, preparePage, Where } from "../mailbox/queries.js";
import type { StoreService } from "../store.js";

const pendingWindow = 24 * 60 * 60_000;
const approvedWindow = 15 * 60_000;
const Row = Schema.Struct({
  request_id: Schema.String,
  api_key_id: Schema.String,
  inbox_id: Schema.String,
  kind: CredentialUseKind,
  credential_ids: Schema.fromJsonString(Schema.Array(Schema.String)),
  fields: Schema.fromJsonString(Schema.Record(Schema.String, Schema.Array(CredentialFieldName))),
  origin: Schema.NullOr(Schema.String),
  browser: Schema.NullOr(Schema.fromJsonString(CredentialUseRequest.fields.browser)),
  fingerprint: Schema.String,
  state: CredentialUseState,
  created_at: Schema.String,
  decided_at: Schema.NullOr(Schema.String),
  expires_at: Schema.String,
});
type Row = typeof Row.Type;
export interface UseCredential {
  readonly credential_id: string;
  readonly inbox_id: string;
  readonly fields: readonly string[];
}
export interface UseIntent {
  readonly kind: typeof CredentialUseKind.Type;
  readonly credentials: readonly UseCredential[];
  readonly fingerprint: string;
  readonly urlHint?: string;
  readonly browser?: CredentialUseRequest["browser"];
}
export interface UseApproval {
  readonly requestId?: string;
  readonly error?: ErrorResponse;
}

const locks = new WeakMap<StoreService, Semaphore.Semaphore>();
export function credentialUseLock(store: StoreService) {
  let lock = locks.get(store);
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    locks.set(store, lock);
  }
  return lock.withPermits(1);
}

export function useFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function expired(row: Row, now: number) {
  return (
    (row.state === "pending" || row.state === "approved") &&
    now >=
      (row.decided_at === null
        ? Date.parse(row.created_at) + pendingWindow
        : Date.parse(row.decided_at) + approvedWindow)
  );
}

function required(row: Row, newKey = false) {
  return wireError(
    "approval_required",
    `Credential use request ${row.request_id} ${newKey ? "cannot be reused" : "requires owner approval"}.`,
    newKey
      ? `Start a new credential use request with a new idempotency key. Request ${row.request_id} is consumed or expired.`
      : `Ask the owner to approve request ${row.request_id}, then retry with the same idempotency key.`,
  );
}

function requestEvent(
  db: Database.Database,
  row: Row,
  type: CredentialUseApprovalEvent["event_type"],
  now: number,
) {
  if (type !== "credential.use_requested") {
    // Pending requests expire before event retention; preserve the original inbox scopes after deletion.
    const events = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          payload: Schema.fromJsonString(CredentialUseApprovalEvent),
        }),
      ),
    )(
      db
        .prepare(
          "SELECT payload FROM event_log WHERE event_type = 'credential.use_requested' AND json_extract(payload, '$.credential_use.request_id') = ?",
        )
        .all(row.request_id),
    );
    for (const { payload } of events)
      appendEvent(db, { ...payload, event_type: type, event_id: randomUUID() }, now);
    return;
  }
  const metadata = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        credential_id: Schema.String,
        inbox_id: Schema.String,
      }),
    ),
  )(
    db
      .prepare(
        "SELECT credential_id, inbox_id FROM credentials WHERE credential_id IN (SELECT value FROM json_each(?))",
      )
      .all(JSON.stringify(row.credential_ids)),
  );
  const inboxes = new Set(metadata.map((credential) => credential.inbox_id));
  inboxes.add(row.inbox_id);
  for (const inboxId of inboxes) {
    const ids = row.credential_ids.filter(
      (id) => metadata.find((credential) => credential.credential_id === id)?.inbox_id === inboxId,
    );
    appendEvent(
      db,
      {
        type: "event",
        event_type: type,
        event_id: randomUUID(),
        credential_use: {
          request_id: row.request_id,
          inbox_id: inboxId,
          kind: row.kind,
          credential_ids: ids,
          fields: [...new Set(ids.flatMap((id) => row.fields[id] ?? []))],
        },
      },
      now,
    );
  }
}

// Return the denial so creating the request and its event commits before failing the call.
export function checkUseApproval(
  db: Database.Database,
  principal: Principal,
  intent: UseIntent,
  now: number,
  key?: string,
): UseApproval {
  if (principal.kind === "owner" || principal.grant.use_policy === "direct") return {};
  if (key === undefined || !Schema.is(IdempotencyKey)(key))
    throw validationError(
      "Credential use requires an idempotency key.",
      "Supply Idempotency-Key in REST, idempotencyKey in MCP, or --idempotency-key in the CLI, and retry with the same key after owner approval.",
    );
  let row = Schema.decodeUnknownSync(Schema.optional(Row))(
    db
      .prepare("SELECT * FROM credential_use_requests WHERE api_key_id = ? AND idempotency_key = ?")
      .get(principal.api_key_id, key),
  );
  if (row === undefined) {
    const inboxId = intent.credentials[0]?.inbox_id;
    if (inboxId === undefined) throw validationError("No credentials were requested.");
    const id = randomBytes(16).toString("hex");
    db.prepare(`INSERT INTO credential_use_requests
      (request_id, api_key_id, inbox_id, kind, credential_ids, fields, origin, browser,
       idempotency_key, fingerprint, state, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(
      id,
      principal.api_key_id,
      inboxId,
      intent.kind,
      JSON.stringify(intent.credentials.map((credential) => credential.credential_id)),
      JSON.stringify(
        Object.fromEntries(
          intent.credentials.map((credential) => [credential.credential_id, credential.fields]),
        ),
      ),
      intent.urlHint ?? null,
      intent.browser === undefined ? null : JSON.stringify(intent.browser),
      key,
      intent.fingerprint,
      new Date(now).toISOString(),
      new Date(now + pendingWindow).toISOString(),
    );
    row = getRequest(db, id);
    requestEvent(db, row, "credential.use_requested", now);
  }
  if (row.fingerprint !== intent.fingerprint)
    throw wireError(
      "idempotency_conflict",
      "This idempotency key belongs to a different credential use request.",
      "Retry the original operation unchanged or use a new idempotency key.",
    );
  if (row.state === "rejected")
    return {
      error: wireError(
        "missing_permission",
        "The owner rejected this credential use.",
        "Ask the owner before starting a new request with a new idempotency key.",
      ),
    };
  if (row.state === "consumed" || expired(row, now)) return { error: required(row, true) };
  if (row.state === "pending") return { error: required(row) };
  return { requestId: row.request_id };
}

export function consumeUseApproval(db: Database.Database, approval: UseApproval, now: number) {
  if (approval.requestId === undefined) return;
  const result = db
    .prepare(
      "UPDATE credential_use_requests SET state = 'consumed', consumed_at = ? WHERE request_id = ? AND state = 'approved'",
    )
    .run(new Date(now).toISOString(), approval.requestId);
  if (result.changes !== 1) throw required(getRequest(db, approval.requestId), true);
}

function getRequest(db: Database.Database, id: string) {
  const row = Schema.decodeUnknownSync(Schema.optional(Row))(
    db.prepare("SELECT * FROM credential_use_requests WHERE request_id = ?").get(id),
  );
  if (row === undefined) throw notFound();
  return row;
}

function wire(db: Database.Database, row: Row): CredentialUseRequest {
  const key = Schema.decodeUnknownSync(Schema.optional(Schema.Struct({ name: Schema.String })))(
    db.prepare("SELECT name FROM api_keys WHERE api_key_id = ?").get(row.api_key_id),
  );
  return {
    request_id: row.request_id,
    api_key_id: row.api_key_id,
    ...(key === undefined ? {} : { api_key_name: key.name }),
    inbox_id: row.inbox_id,
    kind: row.kind,
    credentials: row.credential_ids.map((id) => {
      const credential = Schema.decodeUnknownSync(
        Schema.optional(Schema.Struct({ name: Schema.String })),
      )(db.prepare("SELECT name FROM credentials WHERE credential_id = ?").get(id));
      return { credential_id: id, name: credential?.name ?? id, fields: row.fields[id] ?? [] };
    }),
    ...(row.origin === null ? {} : { url_hint: row.origin }),
    ...(row.browser === null ? {} : { browser: row.browser }),
    state: row.state,
    created_at: row.created_at,
    ...(row.decided_at === null ? {} : { decided_at: row.decided_at }),
    expires_at: row.expires_at,
  };
}

export function makeCredentialUseApprovals(store: StoreService) {
  function run<A>(operation: (db: Database.Database, now: number) => A) {
    return Effect.gen(function* () {
      if ((yield* CurrentPrincipal).kind !== "owner")
        return yield* Effect.fail(
          wireError(
            "missing_permission",
            "Credential use requests require owner authentication.",
            "Sign in as the owner to list or decide credential use requests.",
          ),
        );
      const now = yield* Clock.currentTimeMillis;
      const result = yield* store.use((db): Result.Result<A, MailboxError | ErrorResponse> => {
        try {
          return Result.succeed(db.transaction(() => operation(db, now)).immediate());
        } catch (error) {
          if (error instanceof MailboxError || Schema.is(ErrorResponse)(error))
            return Result.fail(error);
          throw error;
        }
      });
      return yield* Effect.fromResult(result);
    });
  }
  function decide(id: string, decision: "approved" | "rejected") {
    return run((db, now) => {
      const row = getRequest(db, id);
      if (
        row.state === "consumed" ||
        expired(row, now) ||
        (row.state !== "pending" && row.state !== decision)
      )
        throw validationError(
          "This credential use request cannot be decided.",
          "Only pending, unexpired requests can be approved or rejected. Ask the agent to start a new request with a new idempotency key.",
        );
      if (row.state === decision) return wire(db, row);
      db.prepare(
        "UPDATE credential_use_requests SET state = ?, decided_at = ?, expires_at = ? WHERE request_id = ?",
      ).run(
        decision,
        new Date(now).toISOString(),
        new Date(now + approvedWindow).toISOString(),
        id,
      );
      const updated = getRequest(db, id);
      requestEvent(
        db,
        updated,
        decision === "approved" ? "credential.use_approved" : "credential.use_rejected",
        now,
      );
      return wire(db, updated);
    });
  }
  return {
    list: (request: ListCredentialUseRequestsQuery = {}) =>
      run((db): ListCredentialUseRequestsResponse => {
        const query = validate(ListCredentialUseRequestsQuery, request);
        const { limit, expected, cursor } = preparePage(query, {
          resource: "credential-use-requests",
          state: query.state,
          ascending: query.ascending ?? false,
        });
        const where = new Where();
        if (query.state !== undefined) where.add("state = ?", query.state);
        keysetWhere(where, cursor, "created_at", "request_id", query.ascending ?? false);
        const order = query.ascending ? "ASC" : "DESC";
        const rows = db
          .prepare(
            `SELECT *, created_at AS cursor_key, request_id AS cursor_id FROM credential_use_requests WHERE ${where.sql} ORDER BY created_at ${order}, request_id ${order} LIMIT ?`,
          )
          .all(...where.params, limit + 1);
        const { items, ...fields } = page(rows, limit, expected, (row) =>
          wire(db, Schema.decodeUnknownSync(Row)(row)),
        );
        return { ...fields, requests: items };
      }),
    approve: (id: string) => decide(id, "approved"),
    reject: (id: string) => decide(id, "rejected"),
  };
}
