import { expect, test } from "vitest";
import { consentRedirect, readAuthorizationRequest } from "./oauth";

const input = {
  response_type: "code",
  client_id: "a".repeat(32),
  redirect_uri: "com.example.agent:/callback",
  resource: "http://127.0.0.1:12345/mcp",
  code_challenge_method: "S256",
  code_challenge: "a".repeat(43),
  state: "client-state",
};

test("consent UI ignores public authorization extensions before submitting its strict owner body", () => {
  const query = new URLSearchParams({
    ...input,
    prompt: "consent",
    nonce: "client-nonce",
    constructor: "ignored",
  });
  expect(readAuthorizationRequest(query.toString())).toEqual(input);
  query.append("client_id", "b".repeat(32));
  expect(() => readAuthorizationRequest(query.toString())).toThrow(
    "Repeated authorization parameter",
  );
});

test("consent UI validates PKCE and resource parameters before displaying a request", () => {
  for (const change of [
    { code_challenge_method: "plain" },
    { code_challenge: "short" },
    { resource: undefined },
  ]) {
    const query = new URLSearchParams(input);
    for (const [key, value] of Object.entries(change))
      if (value === undefined) query.delete(key);
      else query.set(key, value);
    expect(() => readAuthorizationRequest(query.toString())).toThrow();
  }
});

test("consent redirects preserve native schemes, loopback ports and returned issuer/state while rejecting changed targets", () => {
  for (const requested of [
    "com.example.agent:/callback",
    "com.example.agent://auth/callback",
    "http://127.0.0.1:34567/callback",
  ]) {
    const target = new URL(requested);
    target.searchParams.set("code", "synthetic-code");
    target.searchParams.set("iss", input.resource.replace(/\/mcp$/, ""));
    target.searchParams.set("state", input.state);
    expect(consentRedirect(target.href, requested).href).toBe(target.href);
  }
  for (const target of [
    "com.example.other:/callback",
    "com.example.agent://other/callback",
    "com.example.agent:/different",
    "com.example.agent:/callback#fragment",
  ])
    expect(() => consentRedirect(target, input.redirect_uri)).toThrow("Invalid consent redirect");
  expect(() =>
    consentRedirect("http://127.0.0.1:54321/callback", "http://127.0.0.1:34567/callback"),
  ).toThrow("Invalid consent redirect");
  expect(() =>
    consentRedirect(
      "https://user:password@client.example.test/callback",
      "https://client.example.test/callback",
    ),
  ).toThrow("Invalid consent redirect");
});
