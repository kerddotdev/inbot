import { Schema } from "effect";
import { expect, test } from "vitest";
import { Grant, UpdateApiKeyRequest, UsePolicy } from "./api-keys.js";
import { CredentialUseApi } from "./api/credential-use.js";
import { CredentialsApi } from "./api/vault.js";
import { CredentialUseRequest } from "./credential-use.js";
import { Event } from "./events.js";
import { SendHeaders } from "./common.js";
import { OwnerOnly } from "./security.js";

test("grants and key edits accept only supported credential use policies without changing omitted grants", () => {
  const grant = { permissions: {}, send_policy: "approval" };
  expect(Schema.decodeUnknownSync(Grant)(grant)).toEqual(grant);
  for (const policy of ["approval", "direct"]) {
    expect(Schema.decodeUnknownSync(UsePolicy)(policy)).toBe(policy);
    expect(Schema.decodeUnknownSync(Grant)({ ...grant, use_policy: policy })).toMatchObject({
      use_policy: policy,
    });
    expect(Schema.decodeUnknownSync(UpdateApiKeyRequest)({ use_policy: policy })).toEqual({
      use_policy: policy,
    });
  }
  expect(() => Schema.decodeUnknownSync(Grant)({ ...grant, use_policy: "read_only" })).toThrow();
});

test("approval contracts expose only metadata, owner-only decisions, and the shared idempotency header", () => {
  const request = {
    request_id: "a".repeat(32),
    api_key_id: "b".repeat(32),
    inbox_id: "agent@example.test",
    kind: "fill",
    credentials: [{ credential_id: "c".repeat(32), name: "Account", fields: ["password"] }],
    state: "pending",
    created_at: "2026-10-10T12:00:00Z",
    expires_at: "2026-10-11T12:00:00Z",
  };
  const decode = Schema.decodeUnknownSync(CredentialUseRequest, { onExcessProperty: "error" });
  expect(decode(request)).toEqual(request);
  const capture = {
    ...request,
    kind: "capture",
    browser: { endpoint: "http://127.0.0.1:9222", selector: "#password", target_id: "page-1" },
  };
  expect(decode(capture)).toEqual(capture);
  expect(() => decode({ ...request, values: { password: "secret" } })).toThrow();
  for (const endpoint of Object.values(CredentialUseApi.endpoints))
    expect(endpoint.middlewares.has(OwnerOnly)).toBe(true);
  for (const endpoint of [
    CredentialsApi.endpoints.inboxes_credentials_fill,
    CredentialsApi.endpoints.inboxes_credentials_capture,
    CredentialsApi.endpoints.credentials_resolve,
  ]) {
    if (endpoint.headers === undefined) throw new Error("Expected idempotency headers");
    expect(Schema.decodeUnknownSync(SendHeaders)({ "idempotency-key": "use-once" })).toEqual({
      "idempotency-key": "use-once",
    });
  }
  const event = {
    type: "event",
    event_type: "credential.use_requested",
    event_id: "event",
    credential_use: {
      request_id: request.request_id,
      inbox_id: request.inbox_id,
      kind: "fill",
      credential_ids: ["c".repeat(32)],
      fields: ["password"],
    },
  };
  expect(Schema.decodeUnknownSync(Event)(event)).toEqual(event);
  for (const event_type of [
    "credential.use_requested",
    "credential.use_approved",
    "credential.use_rejected",
  ])
    expect(
      Schema.decodeUnknownSync(Event)({
        ...event,
        event_type,
        credential_use: { ...event.credential_use, kind: "capture" },
      }),
    ).toMatchObject({ credential_use: { kind: "capture" } });
  expect(() =>
    Schema.decodeUnknownSync(Event, { onExcessProperty: "error" })({
      ...event,
      credential_use: { ...event.credential_use, idempotency_key: "private" },
    }),
  ).toThrow();
});
