import { Schema } from "effect";

export const ErrorStatus = {
  validation_error: 400,
  unauthorized: 401,
  missing_permission: 403,
  permission_escalation: 403,
  limit_exceeded: 403,
  domain_not_verified: 403,
  message_rejected: 403,
  inbox_paused: 403,
  approval_required: 403,
  not_found: 404,
  already_exists: 409,
  resource_taken: 409,
  idempotency_conflict: 409,
  page_token_stale: 409,
  payload_too_large: 413,
  locked: 423,
  rate_limit_exceeded: 429,
  not_supported: 501,
  service_unavailable: 503,
} as const satisfies Record<ErrorCode, number>;
export const ErrorCode = Schema.Literals([
  "validation_error",
  "unauthorized",
  "missing_permission",
  "permission_escalation",
  "limit_exceeded",
  "domain_not_verified",
  "message_rejected",
  "inbox_paused",
  "approval_required",
  "not_found",
  "already_exists",
  "resource_taken",
  "idempotency_conflict",
  "page_token_stale",
  "payload_too_large",
  "locked",
  "rate_limit_exceeded",
  "not_supported",
  "service_unavailable",
]);
export type ErrorCode = typeof ErrorCode.Type;

const ErrorFields = {
  name: Schema.String,
  message: Schema.String,
  fix: Schema.optionalKey(Schema.String),
  docs: Schema.optionalKey(Schema.String),
};

export const ErrorResponse = Schema.Struct({
  ...ErrorFields,
  code: ErrorCode,
}).annotate({ identifier: "ErrorResponse" });
export type ErrorResponse = typeof ErrorResponse.Type;

export const BadRequestError = Schema.Struct({
  ...ErrorFields,
  code: Schema.Literals(["validation_error"]),
}).annotate({ identifier: "BadRequestError", httpApiStatus: 400 });
export type BadRequestError = typeof BadRequestError.Type;

export const UnauthorizedError = Schema.Struct({
  ...ErrorFields,
  code: Schema.Literals(["unauthorized"]),
}).annotate({ identifier: "UnauthorizedError", httpApiStatus: 401 });
export type UnauthorizedError = typeof UnauthorizedError.Type;

export const ForbiddenError = Schema.Struct({
  ...ErrorFields,
  code: Schema.Literals([
    "missing_permission",
    "permission_escalation",
    "limit_exceeded",
    "domain_not_verified",
    "message_rejected",
    "inbox_paused",
    "approval_required",
  ]),
}).annotate({ identifier: "ForbiddenError", httpApiStatus: 403 });
export type ForbiddenError = typeof ForbiddenError.Type;

export const NotFoundError = Schema.Struct({
  ...ErrorFields,
  code: Schema.Literals(["not_found"]),
}).annotate({ identifier: "NotFoundError", httpApiStatus: 404 });
export type NotFoundError = typeof NotFoundError.Type;

export const ConflictError = Schema.Struct({
  ...ErrorFields,
  code: Schema.Literals([
    "already_exists",
    "resource_taken",
    "idempotency_conflict",
    "page_token_stale",
  ]),
}).annotate({ identifier: "ConflictError", httpApiStatus: 409 });
export type ConflictError = typeof ConflictError.Type;

export const PayloadTooLargeError = Schema.Struct({
  ...ErrorFields,
  code: Schema.Literals(["payload_too_large"]),
}).annotate({ identifier: "PayloadTooLargeError", httpApiStatus: 413 });
export type PayloadTooLargeError = typeof PayloadTooLargeError.Type;

export const LockedError = Schema.Struct({
  ...ErrorFields,
  code: Schema.Literals(["locked"]),
}).annotate({ identifier: "LockedError", httpApiStatus: 423 });
export type LockedError = typeof LockedError.Type;

export const RateLimitExceededError = Schema.Struct({
  ...ErrorFields,
  code: Schema.Literals(["rate_limit_exceeded"]),
}).annotate({ identifier: "RateLimitExceededError", httpApiStatus: 429 });
export type RateLimitExceededError = typeof RateLimitExceededError.Type;

export const NotSupportedError = Schema.Struct({
  ...ErrorFields,
  code: Schema.Literals(["not_supported"]),
}).annotate({ identifier: "NotSupportedError", httpApiStatus: 501 });
export type NotSupportedError = typeof NotSupportedError.Type;

export const ServiceUnavailableError = Schema.Struct({
  ...ErrorFields,
  code: Schema.Literals(["service_unavailable"]),
}).annotate({ identifier: "ServiceUnavailableError", httpApiStatus: 503 });
export type ServiceUnavailableError = typeof ServiceUnavailableError.Type;

export const CommonErrors = [
  BadRequestError,
  ForbiddenError,
  UnauthorizedError,
  LockedError,
  RateLimitExceededError,
  ServiceUnavailableError,
] as const;
export const ReadErrors = [...CommonErrors, NotFoundError] as const;
export const ListErrors = [...ReadErrors, ConflictError] as const;
export const WriteErrors = [
  ...ReadErrors,
  ConflictError,
  PayloadTooLargeError,
  NotSupportedError,
] as const;
