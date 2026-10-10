import { Schema } from "effect";
import { McpSchema } from "effect/ai";

const bodyFields = new Set(["text", "html", "extracted_text", "extracted_html", "preview"]);
const messageGuidance =
  "Use get_message for individual messages and get_attachment for attachment downloads. If a page is truncated, repeat it with a smaller limit before using its next_page_token.";

function guidance(value: Schema.Json) {
  return Schema.is(Schema.JsonObject)(value) && ("draft_id" in value || "drafts" in value)
    ? "Use get_draft for an individual draft, or the REST draft endpoints for full content and attachment downloads. If a page is truncated, repeat it with a smaller limit before using its next_page_token."
    : messageGuidance;
}

function compact(value: Schema.Json, maxLength: number): Schema.Json {
  if (Array.isArray(value)) return value.map((item) => compact(item, maxLength));
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, Schema.Json> = {};
  let truncated = false;
  for (const [key, item] of Object.entries(value)) {
    if (bodyFields.has(key) && typeof item === "string" && item.length > maxLength) {
      result[key] = item.slice(0, maxLength);
      truncated = true;
    } else result[key] = compact(item, maxLength);
  }
  if (truncated) {
    result.truncated = true;
    result.fix = guidance(value);
  }
  return result;
}

function result(value: Schema.Json, isError: boolean) {
  return new McpSchema.CallToolResult({
    content: [
      Schema.decodeUnknownSync(McpSchema.TextContent)({
        type: "text",
        text: JSON.stringify(value),
      }),
    ],
    structuredContent: value,
    isError,
  });
}

export function toolResult(input: unknown, isError = false) {
  const json = Schema.decodeUnknownSync(Schema.Json)(input ?? {});
  const complete = result(json, isError);
  if (Buffer.byteLength(JSON.stringify(complete)) <= 19_000) return complete;
  for (const maxLength of [2048, 512, 0]) {
    const bounded = compact(json, maxLength);
    const response = result(bounded, isError);
    if (Buffer.byteLength(JSON.stringify(response)) <= 19_000) return response;
  }
  const identity: Record<string, Schema.Json> = { truncated: true, fix: guidance(json) };
  if (Schema.is(Schema.JsonObject)(json)) {
    for (const key of ["inbox_id", "message_id", "thread_id", "draft_id", "count", "limit"])
      if (
        (typeof json[key] === "string" && json[key].length <= 2048) ||
        typeof json[key] === "number"
      )
        identity[key] = json[key];
  }
  return result(identity, isError);
}
