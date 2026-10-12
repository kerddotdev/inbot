import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { Clock, Context, Effect, Layer, Result, Schema } from "effect";
import { ErrorResponse } from "../../../../packages/contracts/src/errors.js";
import { PaginationQuery } from "../../../../packages/contracts/src/common.js";
import {
  CreateWebhookRequest,
  UpdateWebhookRequest,
  UpdateWebhookHeadersRequest,
  Webhook,
  type ListWebhooksResponse,
} from "../../../../packages/contracts/src/webhooks.js";
import { CurrentPrincipal, type Principal } from "../../../../packages/contracts/src/security.js";
import { Store, type StoreService } from "../store.js";
import { allowedInboxes, authorize, inScope } from "../agent/authorization.js";
import { MailboxError, notFound, validate, validationError } from "../mailbox/errors.js";
import { getInbox } from "../mailbox/rows.js";
import { Where, preparePage, keysetWhere, page } from "../mailbox/queries.js";
import { latestSequence } from "./log.js";
import { webhookUrl } from "./target.js";

export const WebhookRow = Schema.Struct({
  webhook_id: Schema.String,
  api_key_id: Schema.NullOr(Schema.String),
  inbox_id: Schema.NullOr(Schema.String),
  inbox_ids: Schema.NullOr(Schema.fromJsonString(Schema.Array(Schema.String))),
  url: Schema.String,
  secret: Schema.String,
  event_types: Schema.fromJsonString(CreateWebhookRequest.fields.event_types),
  headers: Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
  client_id: Schema.NullOr(Schema.String),
  enabled: Schema.Int,
  failure_count: Schema.Int,
  disabled_reason: Schema.NullOr(Schema.String),
  last_error_code: Schema.NullOr(Schema.String),
  last_success_at: Schema.NullOr(Schema.String),
  cursor: Schema.Int,
  created_at: Schema.String,
  updated_at: Schema.String,
});
export type WebhookRow = typeof WebhookRow.Type;

export function webhookWire(row: WebhookRow): Webhook {
  return {
    webhook_id: row.webhook_id,
    url: row.url,
    event_types: row.event_types,
    enabled: row.enabled === 1,
    failure_count: row.failure_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.inbox_id === null ? {} : { inbox_id: row.inbox_id }),
    ...(row.inbox_ids === null ? {} : { inbox_ids: row.inbox_ids }),
    ...(row.client_id === null ? {} : { client_id: row.client_id }),
    ...(row.disabled_reason === null ? {} : { disabled_reason: row.disabled_reason }),
    ...(row.last_error_code === null
      ? {}
      : { last_error_code: row.api_key_id === null ? row.last_error_code : "delivery_failed" }),
    ...(row.last_success_at === null ? {} : { last_success_at: row.last_success_at }),
  };
}

export function getWebhook(db: Database.Database, id: string) {
  const value = db.prepare("SELECT * FROM webhooks WHERE webhook_id = ?").get(id);
  if (value === undefined) throw notFound();
  return Schema.decodeUnknownSync(WebhookRow)(value);
}

function accessible(row: WebhookRow, principal: Principal, inboxId?: string) {
  if (inboxId !== undefined && row.inbox_id !== inboxId) return false;
  if (principal.kind === "owner") return true;
  if (row.api_key_id !== principal.api_key_id) return false;
  if (row.inbox_id !== null) return inScope(principal, row.inbox_id);
  return row.inbox_ids === null
    ? allowedInboxes(principal.grant) === undefined
    : row.inbox_ids.every((id) => inScope(principal, id));
}

function scopedIds(
  db: Database.Database,
  principal: Principal,
  ids: readonly string[] | undefined,
) {
  const result = ids ?? (principal.kind === "owner" ? undefined : allowedInboxes(principal.grant));
  for (const id of result ?? []) {
    if (!inScope(principal, id)) throw notFound();
    getInbox(db, id);
  }
  return result === undefined ? null : [...new Set(result)];
}

const reservedHeaders = new Set([
  "host",
  "connection",
  "upgrade",
  "transfer-encoding",
  "content-length",
  "content-type",
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
  "expect",
  "trailer",
  "te",
]);
export function checkedHeaders(input: Readonly<Record<string, string>>) {
  if (Object.keys(input).length > 32) throw validationError("Use at most 32 webhook headers.");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    const normalized = name.toLowerCase();
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(normalized) ||
      name.length > 128 ||
      reservedHeaders.has(normalized) ||
      normalized.startsWith("proxy-") ||
      /(?:^|-)(?:authorization|cookie2?|api-key|token|secret)(?:-|$)/.test(normalized) ||
      /[^\t\x20-\x7e]/.test(value) ||
      value.length > 4096
    )
      throw validationError("A webhook header is invalid or reserved.");
    headers[normalized] = value;
  }
  return headers;
}

export function makeWebhooks(store: StoreService) {
  function run<A>(
    permission: "webhook_read" | "webhook_create" | "webhook_update" | "webhook_delete",
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
          if (error instanceof MailboxError || Schema.is(ErrorResponse)(error))
            return Result.fail(error);
          throw error;
        }
      });
      return yield* Effect.fromResult(result);
    });
  }
  function get(db: Database.Database, id: string, principal: Principal, inboxId?: string) {
    const row = getWebhook(db, id);
    if (!accessible(row, principal, inboxId)) throw notFound();
    return row;
  }
  return {
    create: (request: CreateWebhookRequest, inboxId?: string) =>
      run("webhook_create", inboxId, (db, now, principal) => {
        const input = validate(CreateWebhookRequest, request);
        const { url } = webhookUrl(input.url, principal);
        const ids = scopedIds(db, principal, inboxId === undefined ? input.inbox_ids : [inboxId]);
        const headers = checkedHeaders(input.headers ?? {});
        const id = randomBytes(16).toString("hex");
        const secret = `whsec_${randomBytes(32).toString("base64")}`;
        const timestamp = new Date(now).toISOString();
        db.prepare(`INSERT INTO webhooks (webhook_id, api_key_id, inbox_id, inbox_ids, url, secret,
        event_types, headers, client_id, cursor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id,
          principal.kind === "owner" ? null : principal.api_key_id,
          inboxId ?? null,
          ids === null ? null : JSON.stringify(ids),
          url.href,
          secret,
          JSON.stringify(input.event_types),
          JSON.stringify(headers),
          input.client_id ?? null,
          latestSequence(db),
          timestamp,
          timestamp,
        );
        return { ...webhookWire(getWebhook(db, id)), secret };
      }),
    list: (request: typeof PaginationQuery.Type = {}, inboxId?: string) =>
      run("webhook_read", inboxId, (db, _now, principal): ListWebhooksResponse => {
        const query = validate(PaginationQuery, request);
        if (inboxId !== undefined) getInbox(db, inboxId);
        const scope = principal.kind === "owner" ? "owner" : principal.api_key_id;
        const { limit, expected, cursor } = preparePage(query, {
          resource: "webhooks",
          scope,
          inboxId,
          ascending: query.ascending ?? false,
        });
        const where = new Where();
        if (inboxId !== undefined) where.add("inbox_id = ?", inboxId);
        if (principal.kind === "agent") {
          where.add("api_key_id = ?", principal.api_key_id);
          const ids = allowedInboxes(principal.grant);
          if (ids !== undefined) {
            const placeholders = ids.map(() => "?").join(",") || "NULL";
            where.add(
              `inbox_ids IS NOT NULL AND NOT EXISTS (SELECT 1 FROM json_each(inbox_ids) WHERE value NOT IN (${placeholders}))`,
              ...ids,
            );
            where.add(`(inbox_id IS NULL OR inbox_id IN (${placeholders}))`, ...ids);
          }
        }
        keysetWhere(where, cursor, "created_at", "webhook_id", query.ascending ?? false);
        const order = query.ascending ? "ASC" : "DESC";
        const rows = db
          .prepare(`SELECT *, created_at AS cursor_key, webhook_id AS cursor_id FROM webhooks
        WHERE ${where.sql} ORDER BY created_at ${order}, webhook_id ${order} LIMIT ?`)
          .all(...where.params, limit + 1);
        const { items, ...fields } = page(rows, limit, expected, (row) =>
          webhookWire(Schema.decodeUnknownSync(WebhookRow)(row)),
        );
        return { ...fields, webhooks: items };
      }),
    get: (id: string, inboxId?: string) =>
      run("webhook_read", inboxId, (db, _now, principal) =>
        webhookWire(get(db, id, principal, inboxId)),
      ),
    update: (id: string, request: UpdateWebhookRequest, inboxId?: string) =>
      run("webhook_update", inboxId, (db, now, principal) => {
        const input = validate(UpdateWebhookRequest, request);
        const row = get(db, id, principal, inboxId);
        if (
          row.inbox_id !== null &&
          (input.add_inbox_ids !== undefined || input.remove_inbox_ids !== undefined)
        )
          throw validationError("An inbox webhook cannot change its inbox scope.");
        let ids = row.inbox_ids;
        if (input.add_inbox_ids !== undefined || input.remove_inbox_ids !== undefined) {
          if (ids === null)
            throw validationError(
              "Create an explicitly scoped webhook before changing inbox filters.",
            );
          ids = scopedIds(
            db,
            principal,
            [...new Set([...ids, ...(input.add_inbox_ids ?? [])])].filter(
              (id) => !input.remove_inbox_ids?.includes(id),
            ),
          );
        }
        const reset = input.enabled === true;
        db.prepare(`UPDATE webhooks SET event_types = ?, inbox_ids = ?, enabled = ?, updated_at = ?,
        failure_count = CASE WHEN ? THEN 0 ELSE failure_count END,
        disabled_reason = CASE WHEN ? THEN NULL ELSE disabled_reason END,
        last_error_code = CASE WHEN ? THEN NULL ELSE last_error_code END WHERE webhook_id = ?`).run(
          JSON.stringify(input.event_types ?? row.event_types),
          ids === null ? null : JSON.stringify(ids),
          Number(input.enabled ?? row.enabled === 1),
          new Date(now).toISOString(),
          Number(reset),
          Number(reset),
          Number(reset),
          id,
        );
        if (reset)
          db.prepare(
            "UPDATE webhook_deliveries SET state = 'pending', attempts = 0, next_attempt_at = ?, lease_until = NULL, claim_id = NULL WHERE webhook_id = ? AND state IN ('pending', 'sending')",
          ).run(now, id);
        return webhookWire(getWebhook(db, id));
      }),
    delete: (id: string, inboxId?: string) =>
      run("webhook_delete", inboxId, (db, _now, principal) => {
        get(db, id, principal, inboxId);
        db.prepare("DELETE FROM webhooks WHERE webhook_id = ?").run(id);
      }),
    headers: (id: string, inboxId?: string) =>
      run("webhook_read", inboxId, (db, _now, principal) => ({
        header_names: Object.keys(get(db, id, principal, inboxId).headers).sort(),
      })),
    updateHeaders: (id: string, request: UpdateWebhookHeadersRequest, inboxId?: string) =>
      run("webhook_update", inboxId, (db, now, principal) => {
        const input = validate(UpdateWebhookHeadersRequest, request);
        const row = get(db, id, principal, inboxId);
        const headers = { ...row.headers, ...checkedHeaders(input.headers ?? {}) };
        for (const name of input.remove_headers ?? []) delete headers[name.toLowerCase()];
        db.prepare("UPDATE webhooks SET headers = ?, updated_at = ? WHERE webhook_id = ?").run(
          JSON.stringify(checkedHeaders(headers)),
          new Date(now).toISOString(),
          id,
        );
      }),
  };
}

export class Webhooks extends Context.Service<Webhooks, ReturnType<typeof makeWebhooks>>()(
  "inbot/Webhooks",
) {
  static readonly Live = Layer.effect(Webhooks, Effect.map(Store, makeWebhooks));
}
