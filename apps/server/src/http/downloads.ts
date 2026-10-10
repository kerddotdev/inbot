import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { HttpApiBuilder, HttpApiSecurity } from "effect/http-api";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { CurrentPrincipal } from "../../../../packages/contracts/src/security.js";
import { ApiKeys } from "../auth/api-keys.js";
import { OwnerAuth } from "../auth/owner.js";
import { notFound } from "../mailbox/errors.js";
import { Drafts } from "../drafts/drafts.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { inScope, permits, visible } from "../agent/authorization.js";
import { errorResponse, respond, wireError } from "./errors.js";
import { authenticate } from "./middleware.js";

const Resource = Schema.Struct({
  inbox_id: Schema.String,
  message_id: Schema.optionalKey(Schema.String),
  draft_id: Schema.optionalKey(Schema.String),
  thread_id: Schema.optionalKey(Schema.String),
  attachment_id: Schema.optionalKey(Schema.String),
});
const Ticket = Schema.Struct({ ...Resource.fields, expires: Schema.Finite });
const TicketJson = Schema.fromJsonString(Ticket);

function makeDownloads(url: string, secret: Buffer) {
  const sign = (value: string) => createHmac("sha256", secret).update(value).digest();
  return {
    link: (resource: typeof Resource.Type) =>
      Effect.gen(function* () {
        const expires = (yield* Clock.currentTimeMillis) + 5 * 60_000;
        const payload = Buffer.from(JSON.stringify({ ...resource, expires })).toString("base64url");
        return {
          download_url: `${url}/v0/downloads/${payload}.${sign(payload).toString("base64url")}`,
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
    const keys = yield* ApiKeys;
    const mailbox = yield* Mailbox;
    const drafts = yield* Drafts;
    yield* router.add(
      "GET",
      "/v0/downloads/:token",
      respond(
        Effect.gen(function* () {
          const credential = yield* HttpApiBuilder.securityDecode(HttpApiSecurity.bearer);
          const principal = yield* authenticate(credential, owner, keys);
          if (HttpServerResponse.isHttpServerResponse(principal)) return principal;
          const params = yield* HttpRouter.params;
          const ticket = yield* downloads.read(params.token ?? "");
          if (!inScope(principal, ticket.inbox_id)) return yield* notFound();
          if (!permits(principal, ticket.draft_id === undefined ? "message_read" : "draft_read"))
            return errorResponse(
              wireError(
                "missing_permission",
                "The API key does not permit reading messages.",
                "Ask the owner for the message_read permission.",
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
            },
          });
        }),
      ),
    );
  }),
);
