import { createHash, timingSafeEqual } from "node:crypto";
import { Context } from "effect";
import { HttpServerResponse } from "effect/http";

export interface BrowserSession {
  readonly id: string;
  readonly token: string;
  readonly csrf_token: string;
  readonly expires_at: string;
}
export const CurrentOwnerSession = Context.Reference<BrowserSession | undefined>(
  "inbot/CurrentOwnerSession",
  { defaultValue: () => undefined },
);
export const CurrentRequestOrigin = Context.Reference<string | undefined>(
  "inbot/CurrentRequestOrigin",
  { defaultValue: () => undefined },
);
export const cookieName = (origin: string) =>
  origin.startsWith("https://") ? "__Host-inbot_session" : "inbot_session";
export function sessionCookie(
  response: HttpServerResponse.HttpServerResponse,
  origin: string,
  session?: Pick<BrowserSession, "token" | "expires_at">,
) {
  return HttpServerResponse.setCookieUnsafe(response, cookieName(origin), session?.token ?? "", {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    secure: origin.startsWith("https://"),
    expires: new Date(session?.expires_at ?? 0),
    ...(session === undefined ? { maxAge: 0 } : {}),
  });
}
export function matchesCsrf(expected: string, actual: string | undefined) {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return actual !== undefined && timingSafeEqual(hash(expected), hash(actual));
}
