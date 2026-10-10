import { draftEvent } from "../events/log.js";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { Clock, Context, Effect, Layer, Result, Schema } from "effect";
import {
  ListDraftsQuery,
  DraftItem,
  type SendDraftRequest,
  type CreateDraftRequest,
  type UpdateDraftRequest,
} from "../../../../packages/contracts/src/drafts.js";
import type { OutboundRequest } from "../../../../packages/contracts/src/outbound.js";
import { Store, type StoreService } from "../store.js";
import { MailboxError, notFound, validate } from "../mailbox/errors.js";
import { Where, keysetWhere, page, preparePage } from "../mailbox/queries.js";
import { OutboundError } from "../outbound/errors.js";
import { canonical, Outbox, type OutboxService } from "../outbound/outbox.js";
import { TransportConfig } from "../outbound/transport-config.js";
import * as Rows from "./rows.js";
import { assertOutbound } from "../lists/policy.js";
import { compose } from "../outbound/compose.js";
import { prepare } from "../outbound/prepare.js";

function addresses(value: string | readonly string[] | undefined) {
  return typeof value === "string" ? [value] : value;
}

function approvalReplay(
  db: Database.Database,
  inboxId: string,
  key: string | undefined,
  fingerprint: string,
) {
  if (key === undefined) return undefined;
  const value = db
    .prepare("SELECT * FROM approval_requests WHERE inbox_id = ? AND idempotency_key = ?")
    .get(inboxId, key);
  if (value === undefined) return undefined;
  const replay = Schema.decodeUnknownSync(
    Schema.Struct({ fingerprint: Schema.String, draft_id: Schema.String }),
  )(value);
  if (replay.fingerprint !== fingerprint)
    throw new OutboundError({
      code: "idempotency_conflict",
      message: "This idempotency key belongs to another approval request.",
      fix: "Use the original request or a new idempotency key.",
      retryable: false,
    });
  return replay.draft_id;
}

function recordApproval(
  db: Database.Database,
  inboxId: string,
  key: string | undefined,
  fingerprint: string,
  draftId: string,
) {
  if (key !== undefined)
    db.prepare(`INSERT INTO approval_requests
    (inbox_id, idempotency_key, fingerprint, draft_id) VALUES (?, ?, ?, ?)`).run(
      inboxId,
      key,
      fingerprint,
      draftId,
    );
}

function makeDrafts(
  store: StoreService,
  outbox: OutboxService,
  config: TransportConfig["Service"],
) {
  function run<A>(operation: (db: Database.Database, now: number) => A, write = true) {
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* store.use((db): Result.Result<A, MailboxError | OutboundError> => {
        try {
          const transaction = db.transaction(() => operation(db, now));
          return Result.succeed(write ? transaction.immediate() : transaction.deferred());
        } catch (error) {
          if (error instanceof MailboxError || error instanceof OutboundError)
            return Result.fail(error);
          throw error;
        }
      });
      return yield* Effect.fromResult(result);
    });
  }
  const configured = Effect.gen(function* () {
    if ((yield* config.get()) === undefined)
      return yield* new OutboundError({
        code: "service_unavailable",
        message: "The mail transport is not configured.",
        fix: "Configure the Cloudflare mail transport",
        retryable: true,
      });
  });
  const processDue = () =>
    Effect.gen(function* () {
      const due = yield* run(
        (db, now) =>
          db
            .prepare(`SELECT data FROM drafts WHERE
      approval_state = 'approved' AND send_status IN ('scheduled', 'sending') AND send_at <= ?
      ORDER BY send_at, draft_id LIMIT 100`)
            .all(now)
            .map(Rows.readDraft),
        false,
      );
      let processed = 0;
      for (const draft of due) {
        const claimed = yield* run((db, now) => {
          const value = db
            .prepare("SELECT data FROM drafts WHERE draft_id = ?")
            .get(draft.draft_id);
          if (value === undefined) return false;
          const current = Rows.readDraft(value);
          if (
            current.updated_at !== draft.updated_at ||
            current.approval_state !== "approved" ||
            !["scheduled", "sending"].includes(current.send_status ?? "") ||
            current.send_at === undefined ||
            Date.parse(current.send_at) > now
          )
            return false;
          Rows.saveDraft(db, { ...current, send_status: "sending" });
          return true;
        });
        if (!claimed) continue;
        const result = yield* Effect.result(
          Effect.andThen(
            configured,
            outbox.sendDraft(draft.inbox_id, draft.draft_id, {}, draft.send_idempotency_key),
          ),
        );
        if (Result.isFailure(result)) {
          if (!(result.failure instanceof OutboundError || result.failure instanceof MailboxError))
            return yield* Effect.fail(result.failure);
          yield* run((db, now) => {
            const value = db
              .prepare("SELECT data FROM drafts WHERE draft_id = ?")
              .get(draft.draft_id);
            if (value !== undefined)
              Rows.saveDraft(db, {
                ...Rows.readDraft(value),
                send_status: "failed",
                updated_at: new Date(now).toISOString(),
              });
          });
        }
        processed++;
      }
      return processed;
    });
  return {
    create: (inboxId: string, input: CreateDraftRequest, creator: string, approval: boolean) =>
      run((db, now) =>
        Rows.createDraft(db, inboxId, input, new Date(now).toISOString(), creator, approval),
      ),
    get: (inboxId: string | undefined, draftId: string, inboxIds?: readonly string[]) =>
      run((db) => Rows.publicDraft(Rows.getDraft(db, inboxId, draftId, inboxIds)), false),
    list: (
      inboxId: string | undefined,
      request: typeof ListDraftsQuery.Type,
      inboxIds?: readonly string[],
      excludedLabels: readonly string[] = [],
    ) =>
      run((db) => {
        const query = validate(ListDraftsQuery, request);
        const { limit, expected, cursor } = preparePage(query, {
          resource: "drafts",
          inboxId,
          inboxIds,
          excludedLabels,
          ascending: query.ascending ?? false,
          before: query.before,
          after: query.after,
          labels: query.labels ?? [],
        });
        const where = new Where();
        if (inboxId !== undefined) where.add("inbox_id = ?", inboxId);
        if (inboxIds !== undefined)
          where.add(`inbox_id IN (${inboxIds.map(() => "?").join(",") || "NULL"})`, ...inboxIds);
        for (const label of query.labels ?? [])
          where.add("EXISTS (SELECT 1 FROM json_each(data, '$.labels') WHERE value = ?)", label);
        for (const label of excludedLabels)
          where.add(
            "NOT EXISTS (SELECT 1 FROM json_each(data, '$.labels') WHERE value = ?)",
            label,
          );
        if (query.before !== undefined)
          where.add("updated_at < ?", new Date(query.before).toISOString());
        if (query.after !== undefined)
          where.add("updated_at > ?", new Date(query.after).toISOString());
        keysetWhere(where, cursor, "updated_at", "draft_id", query.ascending ?? false);
        const order = query.ascending ? "ASC" : "DESC";
        const rows = db
          .prepare(`SELECT data, updated_at AS cursor_key, draft_id AS cursor_id FROM drafts
        WHERE ${where.sql} ORDER BY updated_at ${order}, draft_id ${order} LIMIT ?`)
          .all(...where.params, limit + 1);
        const { items, ...fields } = page(rows, limit, expected, (row) =>
          Schema.decodeUnknownSync(DraftItem)(Rows.publicDraft(Rows.readDraft(row))),
        );
        return { ...fields, drafts: items };
      }, false),
    update: (inboxId: string, draftId: string, input: UpdateDraftRequest, approval: boolean) =>
      run((db, now) => {
        const before = Rows.getDraft(db, inboxId, draftId);
        const draft = Rows.updateDraft(
          db,
          inboxId,
          draftId,
          input,
          new Date(now).toISOString(),
          approval,
        );
        if (before.approval_state !== "pending" && draft.approval_state === "pending")
          draftEvent(db, draft, "draft.approval_required", now);
        return draft;
      }),
    delete: (inboxId: string, draftId: string) =>
      run((db) => {
        const draft = Rows.getDraft(db, inboxId, draftId);
        Rows.ensureMutable(draft);
        db.prepare("DELETE FROM drafts WHERE inbox_id = ? AND draft_id = ?").run(inboxId, draftId);
      }),
    attachment: (inboxId: string, draftId: string, attachmentId: string) =>
      run((db) => {
        const draft = Rows.getDraft(db, inboxId, draftId);
        const attachment = draft.attachments?.find((value) => value.attachment_id === attachmentId);
        const content = draft.send_attachments.find(
          (value) => value.attachment_id === attachmentId,
        )?.content;
        if (attachment === undefined || content === undefined) throw notFound();
        return { attachment, content: Buffer.from(content, "base64") };
      }, false),
    requestApproval: (
      inboxId: string,
      draftId: string,
      input: SendDraftRequest,
      idempotencyKey?: string,
      excludedLabels: readonly string[] = [],
    ) =>
      run((db, now) => {
        const fingerprint = createHash("sha256")
          .update(canonical({ draft_id: draftId, request: input }))
          .digest("hex");
        const replay = approvalReplay(db, inboxId, idempotencyKey, fingerprint);
        if (replay !== undefined) return replay;
        const draft = Rows.getDraft(db, inboxId, draftId);
        if (draft.labels.some((label) => excludedLabels.includes(label))) throw notFound();
        Rows.ensureMutable(draft);
        if (draft.approval_state === "rejected")
          throw new OutboundError({
            code: "message_rejected",
            message: "The owner rejected this draft.",
            fix: "Create a new draft for review.",
            retryable: false,
          });
        const composed = compose(inboxId, Rows.draftRequest(draft), { draft: true });
        assertOutbound(
          db,
          inboxId,
          [...composed.to, ...composed.cc, ...composed.bcc],
          draft.in_reply_to !== undefined,
        );
        Rows.saveDraft(db, {
          ...draft,
          labels: Rows.sendLabels(draft.labels, input),
          requires_approval: true,
          pending_approval: true,
          approval_state: "pending",
          updated_at: new Date(now).toISOString(),
        });
        if (draft.approval_state !== "pending")
          draftEvent(db, draft, "draft.approval_required", now);
        recordApproval(db, inboxId, idempotencyKey, fingerprint, draftId);
        return draftId;
      }),
    propose: (inboxId: string, input: OutboundRequest, creator: string, idempotencyKey?: string) =>
      run((db, now) => {
        const fingerprint = createHash("sha256").update(canonical(input)).digest("hex");
        const replay = approvalReplay(db, inboxId, idempotencyKey, fingerprint);
        if (replay !== undefined) return replay;
        const composed = prepare(db, inboxId, input);
        assertOutbound(
          db,
          inboxId,
          [...composed.to, ...composed.cc, ...composed.bcc],
          input.kind === "reply" || input.kind === "reply-all",
        );
        const request = input.request;
        const to = addresses("to" in request ? request.to : undefined);
        const cc = addresses("cc" in request ? request.cc : undefined);
        const bcc = addresses("bcc" in request ? request.bcc : undefined);
        const replyTo = addresses(request.reply_to);

        const draft = Rows.createDraft(
          db,
          inboxId,
          {
            labels: request.labels ?? [],
            ...(request.text === undefined ? {} : { text: request.text }),
            ...(request.html === undefined ? {} : { html: request.html }),
            ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
            ...("subject" in request && request.subject !== undefined
              ? { subject: request.subject }
              : {}),
            ...(to === undefined ? {} : { to }),
            ...(cc === undefined ? {} : { cc }),
            ...(bcc === undefined ? {} : { bcc }),
            ...(replyTo === undefined ? {} : { reply_to: replyTo }),
            ...(input.kind === "send"
              ? {}
              : input.kind === "forward"
                ? { forward_of: input.message_id }
                : {
                    in_reply_to: input.message_id,
                    reply_all:
                      input.kind === "reply-all" ||
                      ("reply_all" in request && request.reply_all === true),
                  }),
          },
          new Date(now).toISOString(),
          creator,
          true,
          request.headers,
        );
        recordApproval(db, inboxId, idempotencyKey, fingerprint, draft.draft_id);
        return draft.draft_id;
      }),
    send: (
      inboxId: string,
      draftId: string,
      input: SendDraftRequest,
      idempotencyKey?: string,
      excludedLabels: readonly string[] = [],
    ) =>
      Effect.andThen(
        configured,
        outbox.sendDraft(inboxId, draftId, input, idempotencyKey, false, excludedLabels),
      ).pipe(
        Effect.flatMap((response) =>
          "draft_id" in response
            ? Effect.die("Expected a queued draft send")
            : Effect.succeed(response),
        ),
      ),
    approve: (inboxId: string, draftId: string, idempotencyKey?: string) =>
      Effect.andThen(configured, outbox.sendDraft(inboxId, draftId, {}, idempotencyKey, true)),
    reject: (inboxId: string, draftId: string, reason?: string) =>
      run((db, now) => {
        const draft = Rows.getDraft(db, inboxId, draftId);
        Rows.ensureMutable(draft);
        const { send_status: _status, ...fields } = draft;
        if (draft.approval_state !== "rejected") draftEvent(db, draft, "draft.rejected", now);
        return Rows.saveDraft(db, {
          ...fields,
          pending_approval: false,
          approval_state: "rejected",
          ...(reason === undefined ? {} : { rejection_reason: reason }),
          updated_at: new Date(now).toISOString(),
        });
      }),
    processDue,
  };
}

export type DraftsService = ReturnType<typeof makeDrafts>;
export class Drafts extends Context.Service<Drafts, DraftsService>()("inbot/Drafts") {
  static readonly Live = Layer.effect(
    Drafts,
    Effect.gen(function* () {
      return makeDrafts(yield* Store, yield* Outbox, yield* TransportConfig);
    }),
  );
}
