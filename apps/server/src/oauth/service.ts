import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { Clock, Context, Effect, Result, Schema } from "effect";
import { Grant } from "../../../../packages/contracts/src/api-keys.js";
import * as OAuthContract from "../../../../packages/contracts/src/oauth.js";
import type { Principal } from "../../../../packages/contracts/src/security.js";
import { appendEvent } from "../events/log.js";
import type { OAuthGrantEvent } from "../../../../packages/contracts/src/events.js";
import { hashToken, keyRow } from "../auth/api-keys.js";
import { notFound } from "../mailbox/errors.js";
import type { StoreService } from "../store.js";

export const OAuthAudience = Context.Reference<string>("inbot/OAuthAudience", {
  defaultValue: () => "",
});
export const OAuthRateLimitKey = Context.Reference<string>("inbot/OAuthRateLimitKey", {
  defaultValue: () => "loopback",
});
export const ACCESS_TOKEN_SECONDS = 300;
const UNUSED_CLIENT_MS = 24 * 60 * 60_000;
const CODE_MS = 5 * 60_000;
const FAMILY_MS = 30 * 24 * 60 * 60_000;
const opaque = () => randomBytes(32).toString("base64url");
const id = () => randomBytes(16).toString("hex");
const containsControl = (text: string, includeSpace = false) =>
  Array.from(text).some(
    (character) =>
      character.charCodeAt(0) <= (includeSpace ? 32 : 31) || character.charCodeAt(0) === 127,
  );

export class OAuthError extends Error {
  constructor(
    readonly code: OAuthContract.OAuthErrorResponse["error"],
    message: string,
    readonly status = 400,
    readonly redirect_uri?: string,
  ) {
    super(message);
  }
}
function invalidGrant() {
  return new OAuthError(
    "invalid_grant",
    "The code or token is invalid, expired, consumed, or does not match this request.",
  );
}
function decode<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: unknown,
  strict = false,
  error: OAuthContract.OAuthErrorResponse["error"] = "invalid_request",
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: strict ? "error" : "ignore" })(
      value,
    );
  } catch {
    throw new OAuthError(error, "The OAuth request contains invalid fields.");
  }
}
const ClientRow = Schema.Struct({
  client_id: Schema.String,
  client_name: Schema.String,
  redirect_uris: Schema.fromJsonString(Schema.Array(Schema.String)),
});
const CodeRow = Schema.Struct({
  grant_id: Schema.String,
  client_id: Schema.String,
  redirect_uri: Schema.String,
  resource: Schema.String,
  challenge: Schema.String,
  expires_at: Schema.Number,
  consumed: Schema.Number,
});
const TokenRow = Schema.Struct({
  family_id: Schema.String,
  grant_id: Schema.String,
  client_id: Schema.String,
  resource: Schema.String,
  kind: Schema.String,
  expires_at: Schema.Number,
  family_expires_at: Schema.Number,
  consumed: Schema.Number,
  revoked: Schema.Number,
});

function loopback(url: URL) {
  return (
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(url.hostname)
  );
}
export function redirectUri(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new OAuthError("invalid_redirect_uri", "Use an absolute redirect URI.");
  }
  const forbidden = [
    "javascript:",
    "data:",
    "file:",
    "vbscript:",
    "about:",
    "blob:",
    "ftp:",
    "mailto:",
    "tel:",
    "ws:",
    "wss:",
  ];
  if (
    url.username ||
    url.password ||
    input.includes("#") ||
    containsControl(input, true) ||
    forbidden.includes(url.protocol) ||
    (url.protocol === "http:" && !loopback(url))
  )
    throw new OAuthError(
      "invalid_redirect_uri",
      "Use HTTPS, HTTP loopback or a private-use scheme, without credentials or fragments.",
    );
  return url;
}
function redirectTarget(input: string) {
  const url = redirectUri(input);
  return ["https:", "http:"].includes(url.protocol)
    ? url.host
    : `${url.protocol}${url.host ? `//${url.host}` : ""}`;
}
function matchesRedirect(requested: string, registered: string) {
  if (requested === registered) return true;
  const target = redirectUri(requested);
  const saved = redirectUri(registered);
  if (
    !["http:", "https:"].includes(target.protocol) ||
    !loopback(target) ||
    target.protocol !== saved.protocol ||
    target.hostname !== saved.hostname
  )
    return false;
  // Preserve the literal path and query; only the loopback authority's port may vary.
  const withoutPort = (text: string) =>
    text.replace(/^(https?:\/\/(?:\[[^\]]+\]|[^:/?#]+)):\d+(?=\/|\?|$)/i, "$1");
  return withoutPort(requested) === withoutPort(registered);
}
function callback(input: { redirect_uri: string; state?: string }, origin: string) {
  const target = new URL(input.redirect_uri);
  target.searchParams.set("iss", origin);
  if (input.state !== undefined) target.searchParams.set("state", input.state);
  return target;
}
function resource(input: string, origin: string) {
  if (input !== `${origin}/mcp` && input !== `${origin}/v0`)
    throw new OAuthError(
      "invalid_target",
      "The resource must be this listener's Inbot MCP or REST resource URL.",
    );
}
function client(db: Database.Database, clientId: string) {
  const value = db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId);
  if (value === undefined) throw new OAuthError("invalid_client", "The client is not registered.");
  return Schema.decodeUnknownSync(ClientRow)(value);
}
function authorization(db: Database.Database, value: unknown, origin: string) {
  const identity = decode(
    Schema.Struct({
      client_id: OAuthContract.AuthorizationRequest.fields.client_id,
      redirect_uri: OAuthContract.AuthorizationRequest.fields.redirect_uri,
      state: OAuthContract.AuthorizationRequest.fields.state,
    }),
    value,
  );
  const registered = client(db, identity.client_id);
  if (!registered.redirect_uris.some((uri) => matchesRedirect(identity.redirect_uri, uri)))
    throw new OAuthError(
      "invalid_redirect_uri",
      "Use a registered redirect URI; loopback ports may vary.",
    );
  try {
    const input = decode(OAuthContract.AuthorizationRequest, value);
    resource(input.resource, origin);
    return { input, registered };
  } catch (error) {
    if (!(error instanceof OAuthError)) throw error;
    const target = callback(identity, origin);
    target.searchParams.set("error", error.code);
    target.searchParams.set("error_description", error.message);
    throw new OAuthError(error.code, error.message, error.status, target.href);
  }
}
function tokenRow(db: Database.Database, token: string) {
  return tokenHashRow(db, hashToken(token));
}
function tokenHashRow(db: Database.Database, hash: Uint8Array) {
  const value = db
    .prepare(`SELECT t.*, f.grant_id, f.revoked, f.expires_at AS family_expires_at,
    g.client_id, g.resource FROM oauth_tokens t
    JOIN oauth_families f ON f.family_id = t.family_id
    JOIN oauth_grants g ON g.grant_id = f.grant_id WHERE t.token_hash = ?`)
    .get(hash);
  return value === undefined ? undefined : Schema.decodeUnknownSync(TokenRow)(value);
}

export function makeOAuth(store: StoreService) {
  function run<A>(operation: (db: Database.Database, now: number) => Result.Result<A, OAuthError>) {
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* store.use((db) => {
        try {
          return db.transaction(() => operation(db, now)).immediate();
        } catch (error) {
          if (error instanceof OAuthError) return Result.fail(error);
          throw error;
        }
      });
      return yield* Effect.fromResult(result);
    });
  }
  function authenticateHash(hash: Uint8Array, audience: string) {
    return run((db, now): Result.Result<Principal | undefined, OAuthError> => {
      const token = tokenHashRow(db, hash);
      if (
        token === undefined ||
        token.kind !== "access" ||
        token.resource !== audience ||
        token.revoked ||
        token.expires_at <= now ||
        token.family_expires_at <= now
      )
        return Result.succeed(undefined);
      const key = keyRow(
        db.prepare("SELECT * FROM api_keys WHERE api_key_id = ?").get(token.grant_id),
      );
      const { inbox_id, inbox_ids, permissions, send_policy, use_policy } = key;
      return Result.succeed({
        kind: "agent",
        api_key_id: key.api_key_id,
        grant: {
          ...(inbox_id === undefined ? {} : { inbox_id }),
          ...(inbox_ids === undefined ? {} : { inbox_ids }),
          permissions,
          send_policy,
          use_policy: use_policy ?? "approval",
        },
      });
    });
  }
  function maintenance(db: Database.Database, now: number) {
    const abandoned = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          grant_id: Schema.String,
          client_id: Schema.String,
        }),
      ),
    )(
      db
        .prepare(`SELECT g.grant_id, g.client_id FROM oauth_grants g
      JOIN oauth_codes c ON c.grant_id = g.grant_id
      WHERE c.consumed = 0 AND c.expires_at <= ?`)
        .all(now),
    );
    for (const grant of abandoned) {
      db.prepare("DELETE FROM api_keys WHERE api_key_id = ? AND prefix = 'oauth'").run(
        grant.grant_id,
      );
      event(db, grant.grant_id, grant.client_id, "oauth.revoked", now);
    }
    db.prepare(
      "DELETE FROM oauth_tokens WHERE token_hash IN (SELECT token_hash FROM oauth_tokens WHERE kind = 'access' AND expires_at <= ? LIMIT 500)",
    ).run(now);
    db.prepare(
      "DELETE FROM oauth_families WHERE family_id IN (SELECT family_id FROM oauth_families WHERE expires_at <= ? LIMIT 100)",
    ).run(now);
    db.prepare(
      "DELETE FROM oauth_codes WHERE code_hash IN (SELECT code_hash FROM oauth_codes WHERE expires_at <= ? LIMIT 100)",
    ).run(now);
    const prunedClients = db
      .prepare(`DELETE FROM oauth_clients WHERE consented_at IS NULL AND created_at <= ?
      AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id)`)
      .run(now - UNUSED_CLIENT_MS);
    db.prepare(`DELETE FROM oauth_limits WHERE
      (operation LIKE 'register:%' AND window < ?) OR
      (operation NOT LIKE 'register:%' AND window < ?)`).run(
      Math.floor(now / 3_600_000),
      Math.floor(now / 60_000),
    );
    return prunedClients.changes;
  }
  function limited<A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) {
    return Effect.gen(function* () {
      const bucket = `${operation}:${yield* OAuthRateLimitKey}`;
      yield* run((db, now) => {
        maintenance(db, now);
        const windowMs = operation === "register" ? 60 * 60_000 : 60_000;
        const maximum = operation === "register" ? 20 : 120;
        const window = Math.floor(now / windowMs);
        db.prepare(`INSERT INTO oauth_limits (operation, window, count) VALUES (?, ?, 1)
          ON CONFLICT(operation) DO UPDATE SET window = excluded.window,
          count = CASE WHEN window = excluded.window THEN count + 1 ELSE 1 END`).run(
          bucket,
          window,
        );
        const row = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(
          db.prepare("SELECT count FROM oauth_limits WHERE operation = ?").get(bucket),
        );
        return row.count > maximum
          ? Result.fail(
              new OAuthError(
                "temporarily_unavailable",
                "OAuth rate limit reached. Try again later.",
                429,
              ),
            )
          : Result.succeed(undefined);
      });
      return yield* effect;
    });
  }
  function issue(
    db: Database.Database,
    familyId: string,
    now: number,
    expires: number,
  ): OAuthContract.TokenResponse {
    const lifetime = Math.min(ACCESS_TOKEN_SECONDS, Math.floor((expires - now) / 1000));
    if (lifetime < 1) throw invalidGrant();
    const access = `inbot_oauth_${opaque()}`;
    const refresh = opaque();
    const insert = db.prepare(
      "INSERT INTO oauth_tokens (token_hash, family_id, kind, expires_at) VALUES (?, ?, ?, ?)",
    );
    insert.run(hashToken(access), familyId, "access", now + lifetime * 1000);
    insert.run(hashToken(refresh), familyId, "refresh", expires);
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: lifetime,
      refresh_token: refresh,
      scope: "inbot",
    };
  }
  function event(
    db: Database.Database,
    grantId: string,
    clientId: string,
    eventType: (typeof OAuthGrantEvent.Type)["event_type"],
    now: number,
  ) {
    appendEvent(
      db,
      {
        type: "event",
        event_type: eventType,
        event_id: randomUUID(),
        oauth: {
          grant_id: grantId,
          client_id: clientId,
          timestamp: new Date(now).toISOString(),
        },
      },
      now,
    );
  }
  function revokeGrant(grantId: string) {
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const removed = yield* store.use((db) =>
        db
          .transaction(() => {
            const row = db
              .prepare("SELECT client_id FROM oauth_grants WHERE grant_id = ?")
              .get(grantId);
            if (row === undefined) return false;
            const { client_id } = Schema.decodeUnknownSync(
              Schema.Struct({ client_id: Schema.String }),
            )(row);
            db.prepare("DELETE FROM api_keys WHERE api_key_id = ? AND prefix = 'oauth'").run(
              grantId,
            );
            event(db, grantId, client_id, "oauth.revoked", now);
            return true;
          })
          .immediate(),
      );
      if (!removed) return yield* notFound();
    });
  }

  return {
    register: (value: unknown) =>
      limited(
        "register",
        run((db, now) => {
          const input = decode(
            OAuthContract.RegisterClientRequest,
            value,
            false,
            "invalid_client_metadata",
          );
          if (input.grant_types !== undefined && !input.grant_types.includes("authorization_code"))
            throw new OAuthError(
              "invalid_client_metadata",
              "Include authorization_code in grant_types.",
            );
          for (const field of [input.client_uri, input.logo_uri]) {
            if (field === undefined) continue;
            let url: URL;
            try {
              url = new URL(field);
            } catch {
              throw new OAuthError(
                "invalid_client_metadata",
                "Client and logo URIs must be absolute HTTP or HTTPS URLs.",
              );
            }
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
              throw new OAuthError(
                "invalid_client_metadata",
                "Client and logo URIs must use HTTP or HTTPS without credentials.",
              );
          }
          for (const uri of input.redirect_uris) redirectUri(uri);
          if (input.client_name !== undefined && containsControl(input.client_name))
            throw new OAuthError("invalid_client_metadata", "Client names must be plain text.");
          const count = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(
            db.prepare("SELECT count(*) AS count FROM oauth_clients").get(),
          );
          if (count.count >= 1000)
            throw new OAuthError("temporarily_unavailable", "The client registry is full.", 429);
          const clientId = id();
          const name = input.client_name?.trim() || "Unnamed client";
          db.prepare(
            "INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)",
          ).run(clientId, name, JSON.stringify(input.redirect_uris), now);
          return Result.succeed({
            ...input,
            client_id: clientId,
            client_name: name,
            redirect_uris: input.redirect_uris,
            token_endpoint_auth_method: "none" as const,
            grant_types: (["authorization_code", "refresh_token"] as const).filter((type) =>
              (input.grant_types ?? ["authorization_code"]).includes(type),
            ),
            response_types: ["code"],
          } satisfies typeof OAuthContract.RegisteredClient.Type);
        }),
      ),
    inspectAuthorization: (value: unknown, origin: string) =>
      run((db) => {
        const { input, registered } = authorization(db, value, origin);
        return Result.succeed({
          client_name: registered.client_name,
          redirect_host: redirectTarget(input.redirect_uri),
          resource: input.resource,
        });
      }),
    consent: (value: unknown, origin: string) =>
      run((db, now) => {
        const request = decode(OAuthContract.ConsentRequest, value, true);
        const { approved, grant: requestedGrant, ...parameters } = request;
        const { input, registered } = authorization(db, parameters, origin);
        const target = callback(input, origin);
        if (!approved) {
          target.searchParams.set("error", "access_denied");
          return Result.succeed({ redirect_uri: target.href });
        }
        if (requestedGrant === undefined)
          throw new OAuthError("invalid_request", "Select a grant before approving.");
        const grant = decode(Grant, requestedGrant, true);
        for (const inboxId of [
          ...(grant.inbox_ids ?? []),
          ...(grant.inbox_id === undefined ? [] : [grant.inbox_id]),
        ])
          if (
            db.prepare("SELECT inbox_id FROM inboxes WHERE inbox_id = ?").get(inboxId) === undefined
          )
            throw new OAuthError("invalid_request", "A selected inbox no longer exists.");
        db.prepare("UPDATE oauth_clients SET consented_at = ? WHERE client_id = ?").run(
          now,
          input.client_id,
        );
        const grantId = id();
        const timestamp = new Date(now).toISOString();
        db.prepare(`INSERT INTO api_keys (api_key_id, name, prefix, secret_hash, inbox_id, inbox_ids,
        permissions, send_policy, created_at, updated_at, use_policy) VALUES (?, ?, 'oauth', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          grantId,
          registered.client_name,
          hashToken(opaque()),
          grant.inbox_id ?? null,
          grant.inbox_ids === undefined ? null : JSON.stringify(grant.inbox_ids),
          JSON.stringify(grant.permissions),
          grant.send_policy,
          timestamp,
          timestamp,
          grant.use_policy ?? "approval",
        );
        db.prepare("INSERT INTO oauth_grants VALUES (?, ?, ?, ?)").run(
          grantId,
          input.client_id,
          input.redirect_uri,
          input.resource,
        );
        const code = opaque();
        db.prepare(
          "INSERT INTO oauth_codes (code_hash, grant_id, challenge, expires_at) VALUES (?, ?, ?, ?)",
        ).run(hashToken(code), grantId, input.code_challenge, now + CODE_MS);
        event(db, grantId, input.client_id, "oauth.authorized", now);
        target.searchParams.set("code", code);
        return Result.succeed({ redirect_uri: target.href });
      }),
    token: (value: unknown, origin: string) =>
      run((db) => {
        const identity = decode(Schema.Struct({ client_id: OAuthContract.OAuthClientId }), value);
        client(db, identity.client_id);
        return Result.succeed(undefined);
      }).pipe(
        Effect.andThen(
          limited(
            "token",
            run((db, now) => {
              const input = decode(OAuthContract.TokenRequest, value);
              client(db, input.client_id);
              resource(input.resource, origin);
              if (input.grant_type === "authorization_code") {
                const value = db
                  .prepare(`SELECT c.*, g.client_id, g.redirect_uri, g.resource FROM oauth_codes c
          JOIN oauth_grants g ON g.grant_id = c.grant_id WHERE code_hash = ?`)
                  .get(hashToken(input.code));
                if (value === undefined) throw invalidGrant();
                const code = Schema.decodeUnknownSync(CodeRow)(value);
                if (
                  code.client_id !== input.client_id ||
                  code.redirect_uri !== input.redirect_uri ||
                  code.resource !== input.resource ||
                  code.expires_at <= now
                )
                  throw invalidGrant();
                const challenge = createHash("sha256")
                  .update(input.code_verifier)
                  .digest("base64url");
                if (!timingSafeEqual(Buffer.from(challenge), Buffer.from(code.challenge)))
                  throw invalidGrant();
                if (code.consumed) {
                  db.prepare("UPDATE oauth_families SET revoked = 1 WHERE grant_id = ?").run(
                    code.grant_id,
                  );
                  event(db, code.grant_id, code.client_id, "oauth.tokens_revoked", now);
                  return Result.fail(invalidGrant());
                }
                db.prepare("UPDATE oauth_codes SET consumed = 1 WHERE code_hash = ?").run(
                  hashToken(input.code),
                );
                const familyId = id();
                db.prepare(
                  "INSERT INTO oauth_families (family_id, grant_id, expires_at) VALUES (?, ?, ?)",
                ).run(familyId, code.grant_id, now + FAMILY_MS);
                return Result.succeed(issue(db, familyId, now, now + FAMILY_MS));
              }
              const token = tokenRow(db, input.refresh_token);
              if (
                token === undefined ||
                token.kind !== "refresh" ||
                token.client_id !== input.client_id ||
                token.resource !== input.resource ||
                token.revoked ||
                token.family_expires_at <= now ||
                token.expires_at <= now
              )
                throw invalidGrant();
              if (token.consumed) {
                db.prepare("UPDATE oauth_families SET revoked = 1 WHERE family_id = ?").run(
                  token.family_id,
                );
                event(db, token.grant_id, token.client_id, "oauth.tokens_revoked", now);
                return Result.fail(invalidGrant());
              }
              db.prepare("UPDATE oauth_tokens SET consumed = 1 WHERE token_hash = ?").run(
                hashToken(input.refresh_token),
              );
              return Result.succeed(issue(db, token.family_id, now, token.family_expires_at));
            }),
          ),
        ),
      ),
    revoke: (value: unknown) =>
      limited(
        "revoke",
        run((db, now) => {
          const input = decode(OAuthContract.RevokeTokenRequest, value);
          client(db, input.client_id);
          const token = tokenRow(db, input.token);
          if (token !== undefined && token.client_id === input.client_id && !token.revoked) {
            db.prepare("UPDATE oauth_families SET revoked = 1 WHERE family_id = ?").run(
              token.family_id,
            );
            event(db, token.grant_id, token.client_id, "oauth.tokens_revoked", now);
          }
          return Result.succeed(undefined);
        }),
      ),
    authenticateHash,
    authenticate: (bearer: string, audience: string) =>
      /^inbot_oauth_[A-Za-z0-9_-]{43}$/.test(bearer)
        ? authenticateHash(hashToken(bearer), audience)
        : Effect.succeed(undefined),
    clients: () =>
      run((db, now) => {
        maintenance(db, now);
        return Result.succeed({
          grants: db
            .prepare(`SELECT k.*, g.*, c.client_name FROM oauth_grants g
      JOIN api_keys k ON k.api_key_id = g.grant_id JOIN oauth_clients c ON c.client_id = g.client_id
      ORDER BY k.created_at DESC, g.grant_id DESC`)
            .all()
            .map((row) => {
              const key = keyRow(row);
              const grant = Schema.decodeUnknownSync(
                Schema.Struct({
                  grant_id: Schema.String,
                  client_id: Schema.String,
                  client_name: Schema.String,
                  redirect_uri: Schema.String,
                  resource: Schema.String,
                }),
              )(row);
              return {
                grant_id: grant.grant_id,
                client_id: grant.client_id,
                client_name: grant.client_name,
                redirect_host: redirectTarget(grant.redirect_uri),
                resource: grant.resource,
                created_at: key.created_at,
                ...(key.inbox_id === undefined ? {} : { inbox_id: key.inbox_id }),
                ...(key.inbox_ids === undefined ? {} : { inbox_ids: key.inbox_ids }),
                permissions: key.permissions,
                send_policy: key.send_policy,
                use_policy: key.use_policy ?? "approval",
              };
            }),
        });
      }),
    purge: () =>
      run((db, now) => {
        const prunedClients = maintenance(db, now);
        const removed = db
          .prepare(`DELETE FROM oauth_clients WHERE NOT EXISTS
        (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id)`)
          .run();
        return Result.succeed({ deleted_clients: removed.changes + prunedClients });
      }),
    revokeGrant,
  };
}
export class OAuth extends Context.Service<OAuth, ReturnType<typeof makeOAuth>>()("inbot/OAuth") {}
