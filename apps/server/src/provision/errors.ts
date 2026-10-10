import { Schema } from "effect";

export class ProvisionError extends Schema.TaggedError<ProvisionError>()("ProvisionError", {
  code: Schema.Literals([
    "validation_error",
    "not_found",
    "already_exists",
    "resource_taken",
    "action_required",
    "missing_permission",
    "service_unavailable",
    "not_supported",
  ]),
  message: Schema.String,
  fix: Schema.String,
}) {}

export function actionRequired(
  message: string,
  fix = "Review the recorded DNS snapshot and restore the original apex records before retrying.",
) {
  return new ProvisionError({
    code: "action_required",
    message,
    fix,
  });
}

export function invalid(message: string) {
  return new ProvisionError({
    code: "validation_error",
    message,
    fix: "Use one mail subdomain inside a Cloudflare zone in the configured account.",
  });
}

export function unavailable() {
  return new ProvisionError({
    code: "service_unavailable",
    message: "Cloudflare did not confirm the provisioning operation.",
    fix: "Retry to reconcile durable progress. Check the account, token, and provider availability.",
  });
}

export function missingPermission(permission: string) {
  return new ProvisionError({
    code: "missing_permission",
    message: `The Cloudflare token needs ${permission}.`,
    fix: `Grant ${permission} on the configured account or zone, then retry.`,
  });
}
