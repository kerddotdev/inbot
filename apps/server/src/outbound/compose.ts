import { Schema } from "effect";
import { addressParser, type Address } from "postal-mime";
import type { SendAttachment } from "../../../../packages/contracts/src/attachments.js";
import type { Addresses, Message } from "../../../../packages/contracts/src/messages.js";
import { OutboundRequest } from "../../../../packages/contracts/src/outbound.js";
import type { StoredAttachment } from "../mailbox/types.js";
import { ProviderMessage, type ProviderAttachment } from "./cloudflare.js";
import { invalid, OutboundError, tooLarge } from "./errors.js";
import { renderMime } from "./mime.js";

export const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
export const MAX_HEADER_BYTES = 16 * 1024;
export const MAX_HEADER_VALUE_BYTES = 2048;
const allowedHeaders = new Set(["in-reply-to", "references", "auto-submitted"]);
const rfcId = /^<[^\s<>@]+@[^\s<>@]+>$/;

export function decodeRequest(value: unknown) {
  try {
    return Schema.decodeUnknownSync(OutboundRequest)(value);
  } catch {
    throw invalid();
  }
}

function flatten(values: readonly Address[]): { address: string; name: string }[] {
  return values.flatMap((value) =>
    value.group !== undefined
      ? flatten(value.group)
      : value.address
        ? [{ address: value.address, name: value.name ?? "" }]
        : [],
  );
}

export function address(value: string) {
  if (/[\r\n\0]/.test(value)) throw invalid("Address fields cannot contain line breaks.");
  const parsed = flatten(addressParser(value));
  const mailbox = parsed[0];
  if (parsed.length !== 1 || !mailbox || !/^[^\s<>@,;]+@[^\s<>@,;]+$/.test(mailbox.address))
    throw invalid("Each recipient entry must contain one mailbox address.");
  return mailbox.name ? mailbox : mailbox.address;
}

function addressKey(value: string) {
  const parsed = address(value);
  return (typeof parsed === "string" ? parsed : parsed.address).toLowerCase();
}

function addresses(value: Addresses | undefined): string[] {
  return typeof value === "string" ? [value] : [...(value ?? [])];
}

function unique(values: readonly string[], exclude: readonly string[] = []) {
  const seen = new Set(exclude.map(addressKey));
  return values.filter((value) => {
    const key = addressKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function attachment(input: SendAttachment): typeof ProviderAttachment.Type {
  if (input.url !== undefined)
    throw new OutboundError({
      code: "not_supported",
      message: "URL attachments are not supported.",
      fix: "Supply base64 content. Arbitrary server-side URL fetching risks SSRF.",
      retryable: false,
    });
  if (input.content === undefined) throw invalid("Attachment content must be canonical base64.");
  if (input.content.length > Math.ceil(MAX_MESSAGE_BYTES / 3) * 4) throw tooLarge();
  if (input.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content))
    throw invalid("Attachment content must be canonical base64.");
  if (Buffer.from(input.content, "base64").toString("base64") !== input.content)
    throw invalid("Attachment content must be canonical base64.");
  const filename = input.filename ?? "attachment";
  const type = input.content_type ?? "application/octet-stream";
  if (/[\r\n\0]/.test(filename) || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(type))
    throw invalid("Attachment metadata is invalid.");
  if (input.content_disposition === "inline" && !input.content_id)
    throw invalid("Inline attachments require content_id.");
  const contentId = input.content_id?.replace(/^<(.+)>$/, "$1");
  if (contentId !== undefined && (!contentId || /[\s<>\0]/.test(contentId)))
    throw invalid("Attachment content_id is invalid.");
  return {
    content: input.content,
    filename,
    type,
    disposition: input.content_disposition ?? "attachment",
    ...(contentId !== undefined ? { content_id: contentId } : {}),
  };
}

export function validateHeaders(headers: Readonly<Record<string, string>>) {
  let bytes = 0;
  let standard = 0;
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    const custom = lower.startsWith("x-");
    if (
      seen.has(lower) ||
      name.length > 100 ||
      !(custom ? /^x-[a-z0-9_-]+$/i : /^[a-z0-9-]+$/i).test(name) ||
      (!custom && !allowedHeaders.has(lower))
    )
      throw invalid("A custom header name is disallowed or duplicated.");
    if (!value || /[\r\n\0]/.test(value) || Buffer.byteLength(value) > MAX_HEADER_VALUE_BYTES)
      throw invalid("A custom header value is empty, malformed, or too long.");
    if (
      ["in-reply-to", "references"].includes(lower) &&
      value.split(/ +/).some((id) => !rfcId.test(id))
    )
      throw invalid("Threading headers must contain RFC message identifiers.");
    if (lower === "auto-submitted" && !/^(?:no|auto-generated|auto-replied)$/.test(value))
      throw invalid("Auto-Submitted has an unsupported value.");
    seen.add(lower);
    if (!custom) standard++;
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
  }
  if (bytes > MAX_HEADER_BYTES || standard > 20)
    throw invalid("Custom headers exceed the provider limits.");
  return bytes;
}

function prefix(subject: string | undefined, kind: "Re" | "Fwd") {
  return new RegExp(`^${kind}:\\s*`, "i").test(subject ?? "")
    ? (subject ?? "")
    : `${kind}: ${subject ?? ""}`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export interface ComposeContext {
  readonly parent?: Message;
  readonly attachments?: readonly StoredAttachment[];
  readonly parent_rfc_id?: string;
  readonly draft?: boolean;
}

export function localMessageId(inboxId: string, id: string) {
  return `<${id}@${inboxId.slice(inboxId.lastIndexOf("@") + 1)}>`;
}

export function compose(inboxId: string, input: OutboundRequest, context: ComposeContext = {}) {
  const decoded = decodeRequest(input);
  const request = decoded.request;
  const parent = context.parent;
  if (
    decoded.kind !== "send" &&
    (!parent || parent.inbox_id !== inboxId || parent.message_id !== decoded.message_id)
  )
    throw invalid("The reply or forward parent must belong to the sending inbox.");
  let to = addresses("to" in request ? request.to : undefined);
  let cc = addresses("cc" in request ? request.cc : undefined);
  const bcc = addresses("bcc" in request ? request.bcc : undefined);
  const replyTo = addresses(request.reply_to);
  let subject = "subject" in request ? (request.subject ?? "") : "";
  let text = request.text;
  let html = request.html;
  const headers = { ...request.headers };
  validateHeaders(headers);
  if (
    !context.draft &&
    (decoded.kind === "send" || decoded.kind === "forward") &&
    Object.keys(headers).some((name) => ["in-reply-to", "references"].includes(name.toLowerCase()))
  )
    throw invalid("Threading headers are reserved for reply operations.");
  if ((request.attachments?.length ?? 0) > 32)
    throw invalid("Messages support at most 32 attachments.");
  const attachments = (request.attachments ?? []).map(attachment);
  let references: string[] = [];
  let inReplyTo: string | undefined;
  if (context.draft) {
    inReplyTo = headers["In-Reply-To"];
    references = headers.References?.split(/ +/) ?? [];
  }
  if ((decoded.kind === "reply" || decoded.kind === "reply-all") && parent) {
    const all =
      decoded.kind === "reply-all" || ("reply_all" in request && request.reply_all === true);
    const senders = parent.reply_to?.length ? parent.reply_to : [parent.from];
    if (!("to" in request) || request.to === undefined)
      to = unique([...senders, ...(all ? parent.to : [])], all ? [inboxId] : []);
    if (!("cc" in request) || request.cc === undefined)
      cc = all ? unique(parent.cc ?? [], [inboxId, ...to]) : [];
    subject = prefix(parent.subject, "Re");
    inReplyTo = context.parent_rfc_id ?? parent.message_id;
    if (!rfcId.test(inReplyTo)) throw invalid("The parent has no usable RFC message identifier.");
    for (const name of Object.keys(headers))
      if (["in-reply-to", "references"].includes(name.toLowerCase())) delete headers[name];
    headers["In-Reply-To"] = inReplyTo;
    const budget = Math.min(
      MAX_HEADER_VALUE_BYTES,
      MAX_HEADER_BYTES - validateHeaders(headers) - Buffer.byteLength("References") - 4,
    );
    references = [
      ...(parent.references ?? []).filter((id) => rfcId.test(id) && id !== inReplyTo),
      inReplyTo,
    ];
    let referenceBytes = Buffer.byteLength(references.join(" "));
    let start = 0;
    while (start < references.length - 1 && referenceBytes > budget) {
      referenceBytes -= Buffer.byteLength(references[start] ?? "") + 1;
      start++;
    }
    references = references.slice(start);
    headers.References = references.join(" ");
  }
  if (decoded.kind === "forward" && parent) {
    subject = prefix(subject || parent.subject, "Fwd");
    const summary = `---------- Forwarded message ----------\nFrom: ${parent.from}\nDate: ${parent.timestamp}\nSubject: ${parent.subject ?? ""}\nTo: ${parent.to.join(", ")}`;
    text = [text, `${summary}\n\n${parent.text ?? ""}`]
      .filter((part) => part !== undefined)
      .join("\n\n");
    if (html !== undefined || parent.html !== undefined)
      html = `${html ?? ""}<section><pre>${escapeHtml(summary)}</pre>${parent.html ?? `<pre>${escapeHtml(parent.text ?? "")}</pre>`}</section>`;
    const originals = context.attachments ?? [];
    if (originals.length + attachments.length > 32)
      throw invalid("Messages support at most 32 attachments.");
    if (originals.length !== (parent.attachments?.length ?? 0))
      throw invalid("All original attachments must be available to forward.");
    attachments.push(
      ...originals.map(({ attachment: metadata, content }) =>
        attachment({ ...metadata, content: Buffer.from(content).toString("base64") }),
      ),
    );
  }
  if (to.length + cc.length + bcc.length === 0 || to.length + cc.length + bcc.length > 50)
    throw invalid("Messages require 1 to 50 recipients across to, cc, and bcc.");
  if (attachments.length > 32) throw invalid("Messages support at most 32 attachments.");
  if (Array.from(subject).length > 998 || /[\r\n\0]/.test(subject))
    throw invalid("The subject exceeds its limit or contains line breaks.");
  if (!text && !html) throw invalid("Messages require a non-empty text or HTML body.");
  if (Buffer.byteLength(text ?? "") + Buffer.byteLength(html ?? "") > MAX_MESSAGE_BYTES)
    throw tooLarge();
  validateHeaders(headers);
  if (replyTo.length > 1) throw invalid("The provider supports only one Reply-To address.");
  const provider: ProviderMessage = {
    from: address(inboxId),
    to: to.map(address),
    cc: cc.map(address),
    bcc: bcc.map(address),
    ...(replyTo[0] !== undefined ? { reply_to: address(replyTo[0]) } : {}),
    subject,
    ...(text !== undefined ? { text } : {}),
    ...(html !== undefined ? { html } : {}),
    attachments,
    headers,
  };
  const raw = renderMime(
    provider,
    localMessageId(inboxId, "00000000-0000-0000-0000-000000000000"),
    "2026-01-01T00:00:00.000Z",
  );
  if (Math.max(raw.byteLength, Buffer.byteLength(JSON.stringify(provider))) > MAX_MESSAGE_BYTES)
    throw tooLarge();
  return {
    provider,
    to,
    cc,
    bcc,
    reply_to: replyTo,
    references,
    ...(inReplyTo !== undefined ? { in_reply_to: inReplyTo } : {}),
    size: raw.byteLength,
  };
}
