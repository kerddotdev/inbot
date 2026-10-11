import { Schema } from "effect";

export class MailboxError extends Schema.TaggedError<MailboxError>()("MailboxError", {
  code: Schema.Literals(["not_found", "already_exists", "validation_error", "page_token_stale"]),
  message: Schema.String,
  fix: Schema.String,
}) {}

export function notFound() {
  return new MailboxError({
    code: "not_found",
    message: "The requested mailbox resource was not found.",
    fix: "Check the inbox and resource identifiers.",
  });
}

export function alreadyExists() {
  return new MailboxError({
    code: "already_exists",
    message: "The mailbox resource or identifier already exists.",
    fix: "Use the existing resource or choose a different identifier.",
  });
}

export function validationError(
  message: string,
  fix = "Check the request fields and their documented limits.",
) {
  return new MailboxError({
    code: "validation_error",
    message,
    fix,
  });
}

export function staleToken() {
  return new MailboxError({
    code: "page_token_stale",
    message: "The page token is invalid or no longer matches this query.",
    fix: "Restart pagination without a page token.",
  });
}

export function validate<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: unknown,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    throw validationError("The mailbox request is invalid.");
  }
}
