import { createHash, randomUUID } from "node:crypto";
import { domainToASCII } from "node:url";
import type Database from "better-sqlite3-multiple-ciphers";
import { Schema } from "effect";
import { addressParser, type Address } from "postal-mime";
import { Direction, RejectionRule } from "../../../../packages/contracts/src/lists.js";
import { validationError } from "../mailbox/errors.js";
import { OutboundError } from "../outbound/errors.js";

export function normalizeEntry(input: string) {
  if (/[\r\n\0]/.test(input))
    throw validationError("List entries cannot contain line breaks or null bytes.");
  const value = input.trim();
  const parts = value.split("@");
  if (parts.length > 2) throw validationError("Use one exact email address or domain.");
  const local = parts.length === 2 ? parts[0] : undefined;
  const rawDomain = parts.at(-1) ?? "";
  if (!/^[^\s/@:?#%\\<>]+$/.test(rawDomain))
    throw validationError("Use a domain without a wildcard, URL, or display name.");
  const domain = domainToASCII(rawDomain).toLowerCase();
  if (
    !domain ||
    domain.length > 253 ||
    !domain
      .split(".")
      .every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  )
    throw validationError("Use a valid domain name.");
  if (
    local !== undefined &&
    (local.length === 0 ||
      local.length > 64 ||
      !/^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) ||
      local.startsWith(".") ||
      local.endsWith(".") ||
      local.includes(".."))
  )
    throw validationError("Use a valid unquoted email address without a display name.");
  return {
    entry: local === undefined ? domain : `${local.toLowerCase()}@${domain}`,
    entry_type: local === undefined ? ("domain" as const) : ("email" as const),
  };
}

const Rejection = Schema.Struct({
  reason_code: Schema.Literals(["blocked_sender", "sender_not_allowed"]),
});
export type InboundRejection = (typeof Rejection.Type)["reason_code"];

function mailboxes(values: readonly Address[]): string[] {
  return values.flatMap((value) =>
    value.group ? mailboxes(value.group) : value.address ? [value.address] : [],
  );
}

function identity(input: string) {
  try {
    if (/[\r\n\0]/.test(input)) return undefined;
    const addresses = mailboxes(addressParser(input));
    if (addresses.length !== 1 || addresses[0] === undefined) return undefined;
    const normalized = normalizeEntry(addresses[0]);
    if (normalized.entry_type !== "email") return undefined;
    return {
      email: normalized.entry,
      domain: normalized.entry.slice(normalized.entry.lastIndexOf("@") + 1),
    };
  } catch {
    return undefined;
  }
}

function decision(
  db: Database.Database,
  inboxId: string,
  direction: Direction,
  addresses: readonly string[],
) {
  const rules = Schema.decodeUnknownSync(Schema.Array(RejectionRule))(
    db
      .prepare(
        "SELECT entry, entry_type, list_type, inbox_id FROM list_entries WHERE scope IN ('', ?) AND direction = ? ORDER BY scope, entry",
      )
      .all(inboxId, direction),
  );
  const allowed = rules.filter((rule) => rule.list_type === "allow");
  const blocked = rules.filter((rule) => rule.list_type === "block");
  const identities = addresses.map(identity);
  const matches = (
    rule: typeof RejectionRule.Type,
    value: NonNullable<ReturnType<typeof identity>>,
  ) => rule.entry === (rule.entry_type === "email" ? value.email : value.domain);
  for (const value of identities) {
    const rule = value && blocked.find((rule) => matches(rule, value));
    if (rule)
      return {
        reason_code: "blocked_sender" as const,
        sender_address: value?.email ?? null,
        rules: [rule],
      };
  }
  if (allowed.length > 0) {
    const deniedIndex = identities.findIndex(
      (value) => !value || !allowed.some((rule) => matches(rule, value)),
    );
    if (identities.length === 0 || deniedIndex !== -1)
      return {
        reason_code: "sender_not_allowed" as const,
        sender_address: identities[deniedIndex]?.email ?? null,
        rules: allowed,
      };
  }
  return undefined;
}

export function evaluate(
  db: Database.Database,
  inboxId: string,
  direction: Direction,
  addresses: readonly string[],
) {
  return decision(db, inboxId, direction, addresses)?.reason_code;
}

export function acceptInbound(
  db: Database.Database,
  inboxId: string,
  senders: readonly string[],
  raw: Uint8Array,
  receivedAt: string,
) {
  const hash = createHash("sha256").update(raw).digest("hex");
  const existing = db
    .prepare(
      "SELECT reason_code FROM inbound_list_rejections WHERE inbox_id = ? AND payload_hash = ? UNION ALL SELECT reason_code FROM inbound_list_rejection_receipts WHERE inbox_id = ? AND payload_hash = ?",
    )
    .get(inboxId, hash, inboxId, hash);
  if (existing !== undefined) return Schema.decodeUnknownSync(Rejection)(existing).reason_code;
  const rejected = decision(db, inboxId, "receive", senders);
  if (rejected !== undefined)
    db.prepare(
      "INSERT INTO inbound_list_rejections (rejection_id, inbox_id, payload_hash, reason_code, received_at, sender_address, rules) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      randomUUID(),
      inboxId,
      hash,
      rejected.reason_code,
      receivedAt,
      rejected.sender_address,
      JSON.stringify(rejected.rules),
    );
  return rejected?.reason_code;
}

export function assertOutbound(
  db: Database.Database,
  inboxId: string,
  recipients: readonly string[],
  reply: boolean,
) {
  for (const direction of reply ? (["send", "reply"] as const) : (["send"] as const)) {
    const reason = evaluate(db, inboxId, direction, recipients);
    if (reason !== undefined)
      throw new OutboundError({
        code: "message_rejected",
        message: `The ${direction} lists reject one or more recipients.`,
        fix: "Choose permitted recipients, or ask the owner to remove matching block entries and add missing allow entries in the global and inbox lists.",
        retryable: false,
      });
  }
}
