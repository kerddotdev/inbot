export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cell(value: unknown): string {
  const text = Array.isArray(value)
    ? value.map(cell).join(", ")
    : record(value)
      ? JSON.stringify(value)
      : value === undefined
        ? ""
        : String(value);
  return Array.from(text, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) ? " " : character;
  }).join("");
}

function table(rows: readonly Record<string, unknown>[], columns: readonly string[]): string {
  if (rows.length === 0) return "No results.\n";
  const values = [
    columns.map((key) => key.toUpperCase()),
    ...rows.map((row) => columns.map((key) => cell(row[key]))),
  ];
  const widths = columns.map((_, index) =>
    Math.max(...values.map((row) => row[index]?.length ?? 0)),
  );
  return (
    values
      .map((row) =>
        row
          .map((value, index) => value.padEnd(widths[index] ?? 0))
          .join("  ")
          .trimEnd(),
      )
      .join("\n") + "\n"
  );
}

export function humanOutput(value: unknown): string {
  if (value === undefined) return "Done.\n";
  if (!record(value)) return `${cell(value)}\n`;
  if (typeof value.url === "string" && typeof value.webhook_id !== "string")
    return `${value.url}\n`;
  const collections: Record<string, readonly string[]> = {
    webhooks: ["webhook_id", "url", "enabled", "failure_count", "disabled_reason"],
    inboxes: ["inbox_id", "display_name", "status"],
    threads: ["thread_id", "inbox_id", "subject", "labels"],
    messages: ["message_id", "inbox_id", "subject", "send_status", "send_reason", "labels"],
    drafts: ["draft_id", "inbox_id", "subject", "approval_state", "send_status"],
    grants: ["grant_id", "client_name", "redirect_host", "resource", "send_policy", "inbox_ids"],
    api_keys: ["api_key_id", "name", "send_policy", "inbox_id", "inbox_ids"],
    rejections: [
      "rejection_id",
      "received_at",
      "inbox_id",
      "sender_address",
      "reason_code",
      "rules",
    ],
    entries: ["entry", "entry_type", "direction", "list_type", "inbox_id", "reason"],
  };
  for (const [key, columns] of Object.entries(collections)) {
    const rows = value[key];
    if (Array.isArray(rows) && rows.every(record)) {
      return (
        table(rows, columns) +
        (typeof value.next_page_token === "string"
          ? `Next page token: ${cell(value.next_page_token)}\n`
          : "")
      );
    }
  }
  return table(
    Object.entries(value).map(([field, entry]) => ({ field, value: entry })),
    ["field", "value"],
  );
}
