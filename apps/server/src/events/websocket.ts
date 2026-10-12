import { Clock, Effect, Redacted, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";
import { NodeHttpServerRequest } from "@effect/platform-node";
import { Subscribe, Pong } from "../../../../packages/contracts/src/events.js";
import type { Principal } from "../../../../packages/contracts/src/security.js";
import { OAuth, OAuthAudience } from "../oauth/service.js";
import { ApiKeys } from "../auth/api-keys.js";
import { OwnerAuth } from "../auth/owner.js";
import { OwnerSessions } from "../auth/sessions.js";
import { authenticatePrincipal } from "../auth/bearer.js";
import { permits } from "../agent/authorization.js";
import { cookieName, matchesCsrf } from "../http/owner-session.js";
import { errorResponse, wireError, wireFailure } from "../http/errors.js";
import { EventLog } from "./log.js";

export const WEBSOCKET_MAX_BUFFER_BYTES = 1024 * 1024;

export function boundedSocketWriter(writer: Socket.Writer, bufferedAmount: () => number) {
  return (data: string) =>
    Effect.gen(function* () {
      // The Node server disables compression, so queued frames live in the TCP write buffer.
      if (bufferedAmount() + Buffer.byteLength(data) + 14 > WEBSOCKET_MAX_BUFFER_BYTES) {
        yield* writer.write(new Socket.CloseEvent(1013, "Client too slow or event too large"));
        return false;
      }
      yield* writer.write(data);
      return true;
    });
}

export function websocket(origin: string) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const owner = yield* OwnerAuth;
    const keys = yield* ApiKeys;
    const oauth = yield* OAuth;
    const audience = yield* OAuthAudience;
    const sessions = yield* OwnerSessions;
    const events = yield* EventLog;
    if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket")
      return errorResponse(
        wireError(
          "validation_error",
          "A WebSocket upgrade is required.",
          "Connect using a WebSocket client.",
        ),
      );
    const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const token = request.cookies[cookieName(origin)] ?? "";
    const session = bearer === undefined ? yield* sessions.authenticate(token) : undefined;
    const protocols = (request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim());
    if (
      session !== undefined &&
      (request.headers.origin !== origin ||
        !protocols.includes("inbot.events") ||
        !protocols.some(
          (value) => value.startsWith("csrf.") && matchesCsrf(session.csrf_token, value.slice(5)),
        ))
    )
      return errorResponse(
        wireError(
          "missing_permission",
          "The WebSocket handshake requires the owner origin and CSRF token.",
          "Use inbot.events and csrf.<token> subprotocols from the owner session.",
        ),
      );
    const authenticated =
      session === undefined
        ? yield* authenticatePrincipal(Redacted.make(bearer ?? ""), owner, keys, oauth).pipe(
            Effect.result,
          )
        : undefined;
    if (authenticated !== undefined && authenticated._tag === "Failure")
      return errorResponse(wireFailure(authenticated.failure));
    const initial: Principal =
      authenticated !== undefined && authenticated._tag === "Success"
        ? authenticated.success
        : { kind: "owner" };
    if (!permits(initial, "message_read") && !permits(initial, "draft_read"))
      return errorResponse(
        wireError(
          "missing_permission",
          "Event streaming requires message_read or draft_read.",
          "Ask the owner for an event resource read permission.",
        ),
      );
    const query = new URL(request.url, origin).searchParams;
    const resume = query.get("last_event_id") ?? undefined;
    const position = yield* events.cursor(resume).pipe(Effect.result);
    if (position._tag === "Failure") return errorResponse(wireFailure(position.failure));
    let cursor = position.success;
    let subscription: Subscribe = { type: "subscribe" };
    let initialized = false;
    let lastPong = yield* Clock.currentTimeMillis;
    let lastPing = lastPong;
    const checkPrincipal = () =>
      session !== undefined
        ? sessions
            .authenticate(token)
            .pipe(
              Effect.map((value) => (value === undefined ? undefined : { kind: "owner" as const })),
            )
        : initial.kind === "owner"
          ? Effect.sync(() => (owner.authenticate(bearer ?? "") ? initial : undefined))
          : bearer?.startsWith("inbot_oauth_")
            ? oauth.authenticate(bearer, audience)
            : keys.authenticate(bearer ?? "");
    const socket = yield* request.upgrade;
    return yield* Effect.gen(function* () {
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      const transport = NodeHttpServerRequest.toIncomingMessage(request).socket;
      const write = boundedSocketWriter(writer, () => transport.writableLength);
      const close = (code: number, reason: string) =>
        writer.write(new Socket.CloseEvent(code, reason));
      const read = Effect.gen(function* () {
        while (true) {
          const chunks = yield* reader.pull;
          for (const chunk of chunks) {
            const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
            if (text.length > 8192) {
              yield* close(1009, "Frame too large");
              return;
            }
            let value: unknown;
            try {
              value = JSON.parse(text);
            } catch {
              yield* close(1008, "Invalid frame");
              return;
            }
            if (Schema.is(Pong)(value)) {
              lastPong = yield* Clock.currentTimeMillis;
              continue;
            }
            const decoded = yield* Schema.decodeUnknownEffect(Subscribe, {
              onExcessProperty: "error",
            })(value).pipe(Effect.result);
            if (decoded._tag === "Failure" || initialized) {
              yield* close(1008, "Send one valid subscription per connection");
              return;
            }
            const next = decoded.success;
            if (next.last_event_id !== undefined) {
              const resumed = yield* events.cursor(next.last_event_id).pipe(Effect.result);
              if (resumed._tag === "Failure") {
                yield* close(1008, "Unknown resume event id");
                return;
              }
              cursor = resumed.success;
            }
            subscription = next;
            initialized = true;
            if (!(yield* write(JSON.stringify({ ...next, type: "subscribed" })))) return;
          }
        }
      });
      const stream = Effect.gen(function* () {
        while (true) {
          const principal = yield* checkPrincipal();
          if (
            principal === undefined ||
            (!permits(principal, "message_read") && !permits(principal, "draft_read"))
          ) {
            yield* close(1008, "Credentials revoked");
            return;
          }
          if (initialized) {
            const rows = yield* events.read(cursor);
            for (const row of rows) {
              const current = yield* checkPrincipal();
              if (current === undefined) {
                yield* close(1008, "Credentials revoked");
                return;
              }
              const payload = yield* events.readable(row.sequence, current, subscription);
              if (payload !== undefined && !(yield* write(JSON.stringify(payload)))) return;
              cursor = row.sequence;
            }
            if (rows.length === 100) continue;
          }
          const now = yield* Clock.currentTimeMillis;
          if (now - lastPong >= 60_000) {
            yield* close(1001, "Heartbeat timeout");
            return;
          }
          if (now - lastPing >= 20_000) {
            if (
              !(yield* write(
                JSON.stringify({ type: "ping", timestamp: new Date(now).toISOString() }),
              ))
            )
              return;
            lastPing = now;
          }
          yield* Effect.sleep("250 millis");
        }
      });
      yield* Effect.raceFirst(read, stream);
      return HttpServerResponse.empty();
    }).pipe(
      Effect.scoped,
      Effect.catch(() => Effect.succeed(HttpServerResponse.empty())),
    );
  });
}
