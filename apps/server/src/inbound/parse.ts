import { createHash } from "node:crypto";
import PostalMime, { type Address } from "postal-mime";
import type { IngestAttachment } from "../mailbox/types.js";

export interface ParsedInbound {
  readonly message_id: string;
  readonly from: string;
  readonly reply_to: readonly string[];
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject?: string;
  readonly date: string;
  readonly text?: string;
  readonly html?: string;
  readonly in_reply_to?: string;
  readonly references: readonly string[];
  readonly headers: Readonly<Record<string, string>>;
  readonly authentication_results: readonly string[];
  readonly attachments: readonly IngestAttachment[];
}

const selectedHeaders = new Set([
  "message-id",
  "in-reply-to",
  "references",
  "date",
  "list-id",
  "list-unsubscribe",
  "auto-submitted",
  "authentication-results",
]);

function addresses(values: readonly Address[]): string[] {
  return values.flatMap((value) => {
    if (value.group !== undefined) return addresses(value.group);
    if (!value.address) return [];
    return [value.name ? `${value.name} <${value.address}>` : value.address];
  });
}

function identifiers(value: string | undefined) {
  return [
    ...new Set(
      Array.from(
        (value ?? "").matchAll(/<?([^\s<>@(),]+@[^\s<>@(),]+)>?/g),
        (match) => `<${match[1]}>`,
      ),
    ),
  ];
}

export async function parseInbound(raw: Uint8Array, receivedAt: string): Promise<ParsedInbound> {
  const email = await PostalMime.parse(raw, {
    attachmentEncoding: "arraybuffer",
    forceRfc822Attachments: true,
  });
  const headers = new Map<string, string>();
  const authenticationResults: string[] = [];
  for (const header of email.headers) {
    const name = header.key.toLowerCase();
    if (name === "authentication-results") authenticationResults.push(header.value);
    if (!selectedHeaders.has(name)) continue;
    const previous = headers.get(name);
    headers.set(name, previous === undefined ? header.value : `${previous}\n${header.value}`);
  }
  const date = email.date === undefined ? NaN : Date.parse(email.date);
  const inReplyTo = identifiers(email.inReplyTo)[0];
  return {
    message_id:
      identifiers(email.messageId)[0] ??
      `<${createHash("sha256").update(raw).digest("hex")}@inbot.invalid>`,
    from: addresses(email.from === undefined ? [] : [email.from]).join(", "),
    reply_to: addresses(email.replyTo ?? []),
    to: addresses(email.to ?? []),
    cc: addresses(email.cc ?? []),
    ...(email.subject !== undefined ? { subject: email.subject } : {}),
    date: Number.isFinite(date) ? new Date(date).toISOString() : receivedAt,
    ...(email.text !== undefined ? { text: email.text } : {}),
    ...(email.html !== undefined ? { html: email.html } : {}),
    ...(inReplyTo !== undefined ? { in_reply_to: inReplyTo } : {}),
    references: identifiers(email.references),
    headers: Object.fromEntries(headers),
    authentication_results: authenticationResults,
    attachments: email.attachments.map((attachment) => {
      if (typeof attachment.content === "string")
        throw new Error("The MIME parser returned an unexpected attachment encoding.");
      return {
        ...(attachment.filename !== null ? { filename: attachment.filename } : {}),
        content_type: attachment.mimeType,
        content_disposition:
          attachment.disposition === "inline" ||
          (attachment.disposition === null && attachment.related)
            ? "inline"
            : "attachment",
        ...(attachment.contentId !== undefined ? { content_id: attachment.contentId } : {}),
        content:
          attachment.content instanceof Uint8Array
            ? attachment.content
            : new Uint8Array(attachment.content),
      };
    }),
  };
}
