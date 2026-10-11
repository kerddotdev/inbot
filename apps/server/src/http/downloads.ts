import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { HttpApiBuilder, HttpApiSecurity } from "effect/http-api";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { CurrentPrincipal } from "../../../../packages/contracts/src/security.js";
import { OAuth, OAuthAudience } from "../oauth/service.js";
import { ApiKeys, hashToken } from "../auth/api-keys.js";
import { OwnerAuth } from "../auth/owner.js";
import { OwnerSessions } from "../auth/sessions.js";
import { notFound } from "../mailbox/errors.js";
import { Drafts } from "../drafts/drafts.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { inScope, permits, visible } from "../agent/authorization.js";
import { errorResponse, respond, wireError } from "./errors.js";
import { CurrentOwnerSession, CurrentRequestOrigin } from "./owner-session.js";
import { authenticate } from "./middleware.js";

const Resource = Schema.Struct({
  inbox_id: Schema.String,
  message_id: Schema.optionalKey(Schema.String),
  draft_id: Schema.optionalKey(Schema.String),
  thread_id: Schema.optionalKey(Schema.String),
  attachment_id: Schema.optionalKey(Schema.String),
});
const Issuer = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("owner"), session_id: Schema.optionalKey(Schema.String) }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    api_key_id: Schema.String,
    oauth: Schema.optionalKey(Schema.Struct({ hash: Schema.String, audience: Schema.String })),
  }),
]);
const Ticket = Schema.Struct({
  ...Resource.fields,
  expires: Schema.Finite,
  origin: Schema.String,
  issuer: Issuer,
});
const TicketJson = Schema.fromJsonString(Ticket);

function makeDownloads(url: string, secret: Buffer) {
  const sign = (value: string) => createHmac("sha256", secret).update(value).digest();
  return {
    link: (resource: typeof Resource.Type) =>
      Effect.gen(function* () {
        const principal = yield* CurrentPrincipal;
        const session = yield* CurrentOwnerSession;
        const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
        const bearer =
          request._tag === "Some"
            ? request.value.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
            : undefined;
        const issuer: typeof Issuer.Type =
          principal.kind === "owner"
            ? { kind: "owner", ...(session === undefined ? {} : { session_id: session.id }) }
            : {
                kind: "agent",
                api_key_id: principal.api_key_id,
                ...(bearer?.startsWith("inbot_oauth_")
                  ? {
                      oauth: {
                        hash: hashToken(bearer).toString("hex"),
                        audience: yield* OAuthAudience,
                      },
                    }
                  : {}),
              };
        const origin = (yield* CurrentRequestOrigin) ?? url;
        const expires = (yield* Clock.currentTimeMillis) + 5 * 60_000;
        const payload = Buffer.from(
          JSON.stringify({ ...resource, expires, origin, issuer }),
        ).toString("base64url");
        return {
          download_url: `${origin}/v0/downloads/${payload}.${sign(payload).toString("base64url")}`,
          expires_at: new Date(expires).toISOString(),
        };
      }),
    read: (token: string) =>
      Effect.gen(function* () {
        const ticket = yield* Effect.try({
          try: () => {
            if (token.length > 8192) throw notFound();
            const [payload, signature, extra] = token.split(".");
            if (!payload || !signature || extra !== undefined) throw notFound();
            const bytes = Buffer.from(signature, "base64url");
            if (bytes.byteLength !== 32 || !timingSafeEqual(sign(payload), bytes)) throw notFound();
            return Schema.decodeUnknownSync(TicketJson)(
              Buffer.from(payload, "base64url").toString("utf8"),
            );
          },
          catch: () => notFound(),
        });
        if (ticket.expires <= (yield* Clock.currentTimeMillis)) return yield* notFound();
        if (ticket.origin !== ((yield* CurrentRequestOrigin) ?? url)) return yield* notFound();
        return ticket;
      }),
  };
}

export class Downloads extends Context.Service<Downloads, ReturnType<typeof makeDownloads>>()(
  "inbot/Downloads",
) {
  static layer(url: string) {
    return Layer.effect(
      Downloads,
      Effect.gen(function* () {
        const secret = randomBytes(32);
        yield* Effect.addFinalizer(() => Effect.sync(() => secret.fill(0)));
        return makeDownloads(url, secret);
      }),
    );
  }
}

export const DownloadRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const downloads = yield* Downloads;
    const owner = yield* OwnerAuth;
    const sessions = yield* OwnerSessions;
    const keys = yield* ApiKeys;
    const oauth = yield* OAuth;
    const mailbox = yield* Mailbox;
    const drafts = yield* Drafts;
    yield* router.add(
      "GET",
      "/v0/downloads/:token",
      respond(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const params = yield* HttpRouter.params;
          const ticket = yield* downloads.read(params.token ?? "");
          const issuer = ticket.issuer;
          const principal = yield* Effect.gen(function* () {
            if (issuer.kind === "owner") {
              if (issuer.session_id !== undefined && !(yield* sessions.active(issuer.session_id)))
                return undefined;
              return { kind: "owner" as const };
            }
            if (issuer.oauth === undefined) return yield* keys.principal(issuer.api_key_id);
            return yield* oauth.authenticateHash(
              Buffer.from(issuer.oauth.hash, "hex"),
              issuer.oauth.audience,
            );
          });
          if (principal === undefined)
            return errorResponse(
              wireError(
                "unauthorized",
                "The download issuer is no longer active.",
                "Request a new download URL with active credentials.",
              ),
            );
          if (
            principal.kind === "agent" &&
            issuer.kind === "agent" &&
            principal.api_key_id !== issuer.api_key_id
          )
            return yield* notFound();
          if (request.headers.authorization !== undefined) {
            const credential = yield* HttpApiBuilder.securityDecode(HttpApiSecurity.bearer);
            const authenticated = yield* authenticate(credential, owner, keys, oauth).pipe(
              Effect.provideService(
                OAuthAudience,
                issuer.kind === "agent" && issuer.oauth !== undefined
                  ? issuer.oauth.audience
                  : yield* OAuthAudience,
              ),
            );
            if (HttpServerResponse.isHttpServerResponse(authenticated)) return authenticated;
            if (
              authenticated.kind !== principal.kind ||
              (authenticated.kind === "agent" &&
                (principal.kind !== "agent" || authenticated.api_key_id !== principal.api_key_id))
            )
              return yield* notFound();
          }
          if (!inScope(principal, ticket.inbox_id)) return yield* notFound();
          if (!permits(principal, ticket.draft_id === undefined ? "message_read" : "draft_read"))
            return errorResponse(
              wireError(
                "missing_permission",
                "The download issuer does not permit reading this resource.",
                `Ask the owner for the ${ticket.draft_id === undefined ? "message_read" : "draft_read"} permission.`,
              ),
            );
          const content = yield* Effect.gen(function* () {
            if (ticket.draft_id !== undefined && ticket.attachment_id !== undefined) {
              yield* visible(drafts.get(ticket.inbox_id, ticket.draft_id));
              const attachment = yield* drafts.attachment(
                ticket.inbox_id,
                ticket.draft_id,
                ticket.attachment_id,
              );
              return {
                bytes: attachment.content,
                type: attachment.attachment.content_type ?? "application/octet-stream",
              };
            }
            if (ticket.message_id !== undefined) {
              yield* visible(mailbox.getMessage(ticket.inbox_id, ticket.message_id));
              if (ticket.attachment_id === undefined)
                return {
                  bytes: yield* mailbox.getRawMessage(ticket.inbox_id, ticket.message_id),
                  type: "message/rfc822",
                };
              const attachment = yield* mailbox.getAttachment(
                ticket.inbox_id,
                ticket.message_id,
                ticket.attachment_id,
              );
              return {
                bytes: attachment.content,
                type: attachment.attachment.content_type ?? "application/octet-stream",
              };
            }
            if (ticket.thread_id !== undefined && ticket.attachment_id !== undefined) {
              yield* visible(mailbox.getThread(ticket.inbox_id, ticket.thread_id, { limit: 1 }));
              const attachment = yield* mailbox.getThreadAttachment(
                ticket.inbox_id,
                ticket.thread_id,
                ticket.attachment_id,
              );
              return {
                bytes: attachment.content,
                type: attachment.attachment.content_type ?? "application/octet-stream",
              };
            }
            return yield* notFound();
          }).pipe(Effect.provideService(CurrentPrincipal, principal));
          return HttpServerResponse.uint8Array(content.bytes, {
            headers: {
              "content-type": content.type,
              "content-disposition": "attachment",
              "x-content-type-options": "nosniff",
              "cache-control": "no-store",
              "content-security-policy": "sandbox; default-src 'none'",
            },
          });
        }),
      ),
    );
  }),
);
