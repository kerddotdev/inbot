import { Effect, Redacted } from "effect";
import type { ApiKeysService } from "./api-keys.js";
import type { OwnerAuth } from "./owner.js";
import { OAuth, OAuthAudience } from "../oauth/service.js";
import { wireError } from "../http/errors.js";

export function authenticatePrincipal(
  credential: Redacted.Redacted<string>,
  owner: OwnerAuth["Service"],
  keys: ApiKeysService,
  oauth: OAuth["Service"],
) {
  return Effect.gen(function* () {
    const bearer = Redacted.value(credential);
    if (owner.authenticate(bearer)) return { kind: "owner" as const };
    const principal = bearer.startsWith("inbot_oauth_")
      ? yield* oauth.authenticate(bearer, yield* OAuthAudience)
      : yield* keys.authenticate(bearer);
    if (principal !== undefined) return principal;
    return yield* Effect.fail(
      wireError(
        "unauthorized",
        "A valid bearer token is required.",
        "Read the local owner token from connection.json or supply an active API key or OAuth access token.",
      ),
    );
  });
}
