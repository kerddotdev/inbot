import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { Schema } from "effect";
import {
  Draft,
  CreateDraftRequest,
  UpdateDraftRequest,
  type SendDraftRequest,
} from "../../../../packages/contracts/src/drafts.js";
import { SendAttachment } from "../../../../packages/contracts/src/attachments.js";
import type { OutboundRequest } from "../../../../packages/contracts/src/outbound.js";
import { notFound, validate, validationError } from "../mailbox/errors.js";
import { getInbox } from "../mailbox/rows.js";
import { attachment } from "../outbound/compose.js";
import { prepare } from "../outbound/prepare.js";
import { OutboundError } from "../outbound/errors.js";

export const StoredDraft = Schema.Struct({
  ...Draft.fields,
  approval_state: Schema.Literals(["pending", "approved", "rejected"]),
  pending_approval: Schema.Boolean,
  send_attachments: Schema.Array(
    Schema.Struct({ attachment_id: Schema.String, ...SendAttachment.fields }),
  ),
  requires_approval: Schema.Boolean,
  send_idempotency_key: Schema.optionalKey(Schema.String),
  headers: Schema.Record(Schema.String, Schema.String),
});
export type StoredDraft = typeof StoredDraft.Type;
const Row = Schema.Struct({ data: Schema.String });

export function readDraft(value: unknown) {
  return Schema.decodeUnknownSync(Schema.fromJsonString(StoredDraft))(
    Schema.decodeUnknownSync(Row)(value).data,
  );
}

export function getDraft(
  db: Database.Database,
  inboxId: string | undefined,
  draftId: string,
  inboxIds?: readonly string[],
) {
  const conditions = ["draft_id = ?"];
  const values = [draftId];
  if (inboxId !== undefined) {
    conditions.push("inbox_id = ?");
    values.push(inboxId);
  }
  if (inboxIds !== undefined) {
    conditions.push(`inbox_id IN (${inboxIds.map(() => "?").join(",") || "NULL"})`);
    values.push(...inboxIds);
  }
  const value = db
    .prepare(`SELECT data FROM drafts WHERE ${conditions.join(" AND ")}`)
    .get(...values);
  if (value === undefined) throw notFound();
  return readDraft(value);
}

export function publicDraft(stored: StoredDraft): Draft {
  const {
    send_attachments: _attachments,
    headers: _headers,
    requires_approval: _approval,
    send_idempotency_key: _key,
    ...draft
  } = stored;
  return draft;
}

export function saveDraft(db: Database.Database, draft: StoredDraft) {
  db.prepare(`INSERT INTO drafts (draft_id, inbox_id, client_id, data, send_at, send_status, approval_state, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (draft_id) DO UPDATE SET
    data = excluded.data, send_at = excluded.send_at, send_status = excluded.send_status,
    approval_state = excluded.approval_state, updated_at = excluded.updated_at`).run(
    draft.draft_id,
    draft.inbox_id,
    draft.client_id ?? null,
    JSON.stringify(draft),
    draft.send_at === undefined ? null : Date.parse(draft.send_at),
    draft.send_status ?? null,
    draft.approval_state ?? "approved",
    draft.updated_at,
  );
  return publicDraft(draft);
}

function attachments(inputs: readonly SendAttachment[]) {
  return inputs.map((input) => {
    const normalized = attachment(input);
    const attachmentId = randomUUID();
    return {
      attachment_id: attachmentId,
      filename: normalized.filename,
      content_type: normalized.type,
      content_disposition: normalized.disposition,
      ...(normalized.content_id === undefined ? {} : { content_id: normalized.content_id }),
      content: normalized.content,
    };
  });
}

function metadata(inputs: StoredDraft["send_attachments"]) {
  return inputs.map(({ content, url: _url, ...input }) => ({
    ...input,
    size: Buffer.from(content ?? "", "base64").byteLength,
  }));
}

export function createDraft(
  db: Database.Database,
  inboxId: string,
  request: CreateDraftRequest,
  now: string,
  creator: string,
  approval: boolean,
  headers: Readonly<Record<string, string>> = {},
) {
  getInbox(db, inboxId);
  const input = validate(CreateDraftRequest, request);
  if (input.client_id !== undefined) {
    if (!input.client_id) throw validationError("client_id must be non-empty.");
    const existing = db
      .prepare("SELECT data FROM drafts WHERE inbox_id = ? AND client_id = ?")
      .get(inboxId, input.client_id);
    if (existing !== undefined) return publicDraft(readDraft(existing));
  }
  if (input.in_reply_to !== undefined && input.forward_of !== undefined)
    throw validationError("A draft cannot be both a reply and a forward.");
  let fields = input;
  let draftHeaders = { ...headers };
  if (input.in_reply_to !== undefined || input.forward_of !== undefined) {
    const source = input.in_reply_to ?? input.forward_of;
    if (source === undefined) throw notFound();
    const outbound: OutboundRequest =
      input.in_reply_to !== undefined
        ? {
            kind: input.reply_all ? "reply-all" : "reply",
            message_id: source,
            request: { ...input, text: input.text || "Draft", headers },
          }
        : {
            kind: "forward",
            message_id: source,
            request: {
              ...input,
              headers,
              to: input.to?.length ? input.to : [inboxId],
              text: input.text || "Draft",
            },
          };
    const composed = prepare(db, inboxId, outbound);
    fields = {
      ...input,
      to: input.in_reply_to === undefined ? (input.to ?? []) : composed.to,
      cc: composed.cc,
      bcc: composed.bcc,
      reply_to: composed.reply_to,
      subject: input.subject ?? composed.provider.subject,
      ...(input.forward_of === undefined
        ? {}
        : {
            text: input.text
              ? (composed.provider.text ?? "")
              : (composed.provider.text?.replace(/^Draft\n\n/, "") ?? ""),
            ...(composed.provider.html === undefined ? {} : { html: composed.provider.html }),
            attachments: composed.provider.attachments.map((value) => ({
              filename: value.filename,
              content_type: value.type,
              content_disposition: value.disposition,
              content: value.content,
              ...(value.content_id === undefined ? {} : { content_id: value.content_id }),
            })),
          }),
      references: input.references ?? composed.references,
    };
    draftHeaders = { ...composed.provider.headers };
  }
  if (fields.in_reply_to !== undefined && draftHeaders["In-Reply-To"] === undefined)
    draftHeaders["In-Reply-To"] = fields.in_reply_to;
  if (fields.references?.length) draftHeaders.References = fields.references.join(" ");
  const sendAttachments = attachments(fields.attachments ?? []);
  const { attachments: _attachments, labels, ...body } = fields;
  const draft: StoredDraft = {
    ...body,
    inbox_id: inboxId,
    draft_id: randomUUID(),
    labels: [...new Set(labels ?? [])],
    attachments: metadata(sendAttachments),
    send_attachments: sendAttachments,
    headers: draftHeaders,
    requires_approval: approval,
    created_by: creator,
    pending_approval: approval,
    approval_state: approval ? "pending" : "approved",
    ...(fields.send_at === undefined ? {} : { send_status: "scheduled" }),
    preview: (fields.text ?? "").slice(0, 200),
    created_at: now,
    updated_at: now,
  };
  return saveDraft(db, draft);
}

export function draftRequest(draft: StoredDraft): OutboundRequest {
  return {
    kind: "send",
    request: {
      to: draft.to ?? [],
      cc: draft.cc ?? [],
      bcc: draft.bcc ?? [],
      reply_to: draft.reply_to ?? [],
      ...(draft.subject === undefined ? {} : { subject: draft.subject }),
      ...(draft.text === undefined ? {} : { text: draft.text }),
      ...(draft.html === undefined ? {} : { html: draft.html }),
      attachments: draft.send_attachments,
      labels: draft.labels,
      headers: draft.headers,
    },
  };
}

export function ensureMutable(draft: StoredDraft) {
  if (draft.send_status === "sending")
    throw new OutboundError({
      code: "resource_taken",
      message: "This draft is being sent.",
      fix: "Wait for the send to finish before changing this draft.",
      retryable: false,
    });
}

export function updateDraft(
  db: Database.Database,
  inboxId: string,
  draftId: string,
  request: UpdateDraftRequest,
  now: string,
  approval: boolean,
) {
  const draft = getDraft(db, inboxId, draftId);
  ensureMutable(draft);
  approval = approval || draft.requires_approval;
  const input = validate(UpdateDraftRequest, request);
  const { send_status: _status, send_idempotency_key: _key, ...base } = draft;
  const updated = { ...base };
  for (const field of [
    "to",
    "cc",
    "bcc",
    "reply_to",
    "subject",
    "text",
    "html",
    "send_at",
  ] as const) {
    const value = input[field];
    if (value === null) delete updated[field];
  }
  const sendAttachments = [
    ...draft.send_attachments.filter(
      (value) => !input.remove_attachments?.includes(value.attachment_id),
    ),
    ...attachments(input.add_attachments ?? []),
  ];
  const changes = Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) =>
        value !== null &&
        ["to", "cc", "bcc", "reply_to", "subject", "text", "html", "send_at"].includes(key),
    ),
  );
  const merged = validate(StoredDraft, {
    ...updated,
    ...changes,
    attachments: metadata(sendAttachments),
    send_attachments: sendAttachments,
    labels: [...new Set([...draft.labels, ...(input.add_labels ?? [])])].filter(
      (label) => !input.remove_labels?.includes(label),
    ),
    requires_approval: approval,
    pending_approval:
      draft.approval_state !== "rejected" && (approval || draft.approval_state === "pending"),
    approval_state:
      draft.approval_state === "rejected"
        ? "rejected"
        : approval || draft.approval_state === "pending"
          ? "pending"
          : draft.approval_state,
    updated_at: now,
  });
  return saveDraft(db, {
    ...merged,
    preview: (merged.text ?? "").slice(0, 200),
    ...(merged.send_at === undefined ? {} : { send_status: "scheduled" }),
  });
}

export function sendLabels(labels: readonly string[], input: SendDraftRequest) {
  const array = (value: string | readonly string[] | undefined) =>
    typeof value === "string" ? [value] : (value ?? []);
  return [...new Set([...labels, ...array(input.add_labels)])].filter(
    (label) => !array(input.remove_labels).includes(label),
  );
}
