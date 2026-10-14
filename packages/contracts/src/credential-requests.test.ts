import { Context, Schema } from "effect";
import { expect, test } from "vitest";
import { Permissions } from "./api-keys.js";
import { CredentialRequestsApi } from "./api/credential-requests.js";
import {
  CreateCredentialRequestRequest,
  FulfillCredentialRequestRequest,
} from "./credential-requests.js";
import { OwnerOnly, RequiredPermission } from "./security.js";

const input = { name: "Account", fields: ["password"], reason: "Use my existing account" };
test("bounds unique requested fields and reason while declaring owner decisions and agent permission", () => {
  expect(Schema.decodeUnknownSync(CreateCredentialRequestRequest)(input)).toEqual(input);
  for (const fields of [
    [],
    ["password", "password"],
    Array.from({ length: 9 }, (_, i) => `field_${i}`),
    ["bad-field"],
  ])
    expect(() =>
      Schema.decodeUnknownSync(CreateCredentialRequestRequest)({ ...input, fields }),
    ).toThrow();
  for (const reason of ["", "x".repeat(501)])
    expect(() =>
      Schema.decodeUnknownSync(CreateCredentialRequestRequest)({ ...input, reason }),
    ).toThrow();
  expect(Schema.decodeUnknownSync(Permissions)({ credential_request: true })).toEqual({
    credential_request: true,
  });
  expect(() => Schema.decodeUnknownSync(FulfillCredentialRequestRequest)({ fields: {} })).toThrow();
  for (const endpoint of [
    CredentialRequestsApi.endpoints.credentialRequests_fulfill,
    CredentialRequestsApi.endpoints.credentialRequests_decline,
  ])
    expect(endpoint.middlewares.has(OwnerOnly)).toBe(true);
  for (const endpoint of [
    CredentialRequestsApi.endpoints.credentialRequests_create,
    CredentialRequestsApi.endpoints.credentialRequests_get,
    CredentialRequestsApi.endpoints.credentialRequests_list,
  ])
    expect(Context.get(endpoint.annotations, RequiredPermission)).toBe("credential_request");
});
