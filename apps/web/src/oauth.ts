import { Schema } from "effect";
import { AuthorizationRequest } from "@inbot/contracts/src/oauth.js";

export function readAuthorizationRequest(search: string) {
  const values = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(search)) {
    if (values.has(key)) throw new Error("Repeated authorization parameter");
    values.set(key, value);
  }
  return Schema.decodeUnknownSync(AuthorizationRequest)(Object.fromEntries(values));
}

export function consentRedirect(redirectUri: string, requestedUri: string) {
  const target = new URL(redirectUri);
  const requested = new URL(requestedUri);
  if (
    target.protocol !== requested.protocol ||
    target.host !== requested.host ||
    target.pathname !== requested.pathname ||
    target.username !== requested.username ||
    target.password !== requested.password ||
    target.hash !== requested.hash
  )
    throw new Error("Invalid consent redirect");
  return target;
}
