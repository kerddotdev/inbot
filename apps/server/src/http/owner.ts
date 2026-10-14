import type { UpdateState } from "../update/state.js";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { OwnerSessions } from "../auth/sessions.js";
import { Lists } from "../lists/lists.js";
import { OwnerTransport } from "../outbound/owner-transport.js";
import { OwnerAuth } from "../auth/owner.js";
import { ServerApi } from "./api.js";
import { respond, wireError } from "./errors.js";
import {
  CurrentOwnerSession,
  CurrentRequestOrigin,
  sessionCookie,
  type BrowserSession,
} from "./owner-session.js";

export function ownerHandlers(origin: string, updates: UpdateState) {
  return HttpApiBuilder.group(ServerApi, "owner", (handlers) =>
    Effect.gen(function* () {
      const sessions = yield* OwnerSessions;
      const owner = yield* OwnerAuth;
      const transport = yield* OwnerTransport;
      const lists = yield* Lists;
      const issue = <E, R>(
        effect: Effect.Effect<Pick<BrowserSession, "token" | "csrf_token" | "expires_at">, E, R>,
      ) =>
        respond(
          Effect.gen(function* () {
            const session = yield* effect;
            return sessionCookie(
              HttpServerResponse.jsonUnsafe({
                csrf_token: session.csrf_token,
                expires_at: session.expires_at,
              }),
              (yield* CurrentRequestOrigin) ?? origin,
              session,
            );
          }),
        );
      const userAgent = Effect.map(
        HttpServerRequest.HttpServerRequest,
        (request) => request.headers["user-agent"] ?? "",
      );
      return handlers
        .handle("owner_updates", () => respond(Effect.tryPromise(() => updates.read())))
        .handle("owner_setUpdates", ({ payload }) =>
          respond(Effect.tryPromise(() => updates.configure(payload))),
        )
        .handle("owner_listRejections", ({ query }) => respond(lists.rejections(query)))
        .handle("owner_deleteRejection", ({ params }) =>
          respond(lists.deleteRejection(params.rejection_id)),
        )
        .handle("owner_transport", () => respond(transport.inspect()))
        .handle("owner_setTransport", ({ payload }) => respond(transport.configure(payload)))
        .handle("owner_clearTransport", () => respond(transport.clear()))
        .handle("owner_status", () =>
          respond(
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const session = yield* CurrentOwnerSession;
              const credential =
                request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
              const response = HttpServerResponse.jsonUnsafe({
                setup_required: yield* sessions.setupRequired(),
                authenticated: session !== undefined || owner.authenticate(credential),
                locked: false,
              });
              return session === undefined
                ? response
                : HttpServerResponse.setHeader(response, "x-inbot-csrf", session.csrf_token);
            }),
          ),
        )
        .handle("owner_setup", ({ payload }) =>
          issue(
            Effect.flatMap(userAgent, (agent) =>
              sessions.setup(payload.password, payload.code, agent),
            ),
          ),
        )
        .handle("owner_login", ({ payload }) =>
          issue(Effect.flatMap(userAgent, (agent) => sessions.login(payload.password, agent))),
        )
        .handle("owner_redeem", ({ payload }) =>
          issue(Effect.flatMap(userAgent, (agent) => sessions.redeem(payload.token, agent))),
        )
        .handle("owner_logout", () =>
          respond(
            Effect.gen(function* () {
              const session = yield* CurrentOwnerSession;
              if (session !== undefined) yield* sessions.revoke(session.id);
              return sessionCookie(
                HttpServerResponse.empty({ status: 200 }),
                (yield* CurrentRequestOrigin) ?? origin,
              );
            }),
          ),
        )
        .handle("owner_sessions", () =>
          respond(Effect.flatMap(CurrentOwnerSession, (session) => sessions.list(session?.id))),
        )
        .handle("owner_revoke", ({ params }) =>
          respond(
            Effect.gen(function* () {
              yield* sessions.revoke(params.id);
              const session = yield* CurrentOwnerSession;
              const response = HttpServerResponse.empty({ status: 200 });
              return session?.id === params.id
                ? sessionCookie(response, (yield* CurrentRequestOrigin) ?? origin)
                : response;
            }),
          ),
        )
        .handle("owner_password", ({ payload }) =>
          respond(
            Effect.flatMap(CurrentOwnerSession, (session) =>
              sessions.changePassword(payload.current_password, payload.password, session?.id),
            ),
          ),
        )
        .handle("owner_loginLink", () =>
          respond(
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const credential =
                request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
              if (!owner.authenticate(credential))
                return yield* Effect.fail(
                  wireError(
                    "missing_permission",
                    "Login links require the owner bearer token.",
                    "Use the local owner token from connection.json.",
                  ),
                );
              return yield* sessions.createLink(origin);
            }),
          ),
        );
    }),
  );
}
