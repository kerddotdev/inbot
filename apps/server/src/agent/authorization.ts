import { wireError } from "../http/errors.js";
import { Effect } from "effect";
import type { Grant, Permission } from "../../../../packages/contracts/src/api-keys.js";
import { CurrentPrincipal, type Principal } from "../../../../packages/contracts/src/security.js";
import { notFound } from "../mailbox/errors.js";
import { hiddenLabels } from "../mailbox/queries.js";

export function allowedInboxes(grant: Grant): readonly string[] | undefined {
  if (grant.inbox_id === undefined) return grant.inbox_ids;
  return grant.inbox_ids === undefined || grant.inbox_ids.includes(grant.inbox_id)
    ? [grant.inbox_id]
    : [];
}

export const inboxAllowlist = Effect.map(CurrentPrincipal, (principal) =>
  principal.kind === "owner" ? undefined : allowedInboxes(principal.grant),
);

export function permits(principal: Principal, permission: Permission) {
  return principal.kind === "owner" || principal.grant.permissions[permission] === true;
}

export function inScope(principal: Principal, inboxId: string) {
  const ids = principal.kind === "owner" ? undefined : allowedInboxes(principal.grant);
  return ids === undefined || ids.includes(inboxId);
}

export function labelsAllowed(principal: Principal, labels: readonly string[]) {
  return hiddenLabels.every(
    (label) => !labels.includes(label) || permits(principal, `label_${label}_read`),
  );
}

export function visible<A extends { readonly labels: readonly string[] }, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const resource = yield* effect;
    if (!labelsAllowed(yield* CurrentPrincipal, resource.labels)) return yield* notFound();
    return resource;
  });
}

export function visibleQuery<
  Q extends {
    readonly include_spam?: boolean;
    readonly include_blocked?: boolean;
    readonly include_unauthenticated?: boolean;
    readonly include_trash?: boolean;
  },
>(query: Q) {
  return Effect.map(CurrentPrincipal, (principal) => ({
    ...query,
    include_spam: query.include_spam === true && permits(principal, "label_spam_read"),
    include_blocked: query.include_blocked === true && permits(principal, "label_blocked_read"),
    include_unauthenticated:
      query.include_unauthenticated === true && permits(principal, "label_unauthenticated_read"),
    include_trash: query.include_trash === true && permits(principal, "label_trash_read"),
  }));
}

export function authorize(permission: Permission, inboxId?: string) {
  return Effect.gen(function* () {
    const principal = yield* CurrentPrincipal;
    if (inboxId !== undefined && !inScope(principal, inboxId)) return yield* notFound();
    if (!permits(principal, permission))
      return yield* Effect.fail(
        wireError(
          "missing_permission",
          "The API key does not permit this operation.",
          `Ask the owner for the ${permission} permission.`,
        ),
      );
  });
}

export const authorizeSendPolicy = Effect.gen(function* () {
  const principal = yield* CurrentPrincipal;
  if (principal.kind === "owner" || principal.grant.send_policy !== "read_only") return;
  return yield* Effect.fail(
    wireError(
      "missing_permission",
      "This API key has a read-only send policy.",
      "Ask the owner for a direct or approval send policy before sending mail.",
    ),
  );
});
