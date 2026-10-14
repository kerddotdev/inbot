import { Schema } from "effect";
import { expect, test } from "vitest";
import { Permissions } from "./api-keys.js";
import { CredentialEvent, Event } from "./events.js";
import {
  Credential,
  CreateCredentialRequest,
  UpdateCredentialRequest,
  GenerateFieldRequest,
} from "./vault.js";

const id = "1234567890abcdef1234567890abcdef";
const metadata = {
  credential_id: id,
  inbox_id: "agent@example.test",
  name: "GitHub",
  origins: ["https://github.com"],
  fields: ["password"],
  refs: { password: `inbot://credentials/${id}/password` },
  created_at: "2026-10-10T12:00:00Z",
  updated_at: "2026-10-10T12:00:00Z",
};

test("keeps credential metadata and event schemas separate from secret input values", () => {
  expect(Schema.decodeUnknownSync(Credential)(metadata)).toEqual(metadata);
  expect(() =>
    Schema.decodeUnknownSync(Credential, { onExcessProperty: "error" })({
      ...metadata,
      fields: { password: "secret" },
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(Credential, { onExcessProperty: "error" })({
      ...metadata,
      password: "secret",
    }),
  ).toThrow();
  const event = {
    type: "event",
    event_type: "credential.created",
    event_id: "event-1",
    credential: { credential_id: id, inbox_id: metadata.inbox_id, fields: ["password"] },
  };
  expect(Schema.decodeUnknownSync(Event)(event)).toEqual(event);
  expect(() =>
    Schema.decodeUnknownSync(CredentialEvent, { onExcessProperty: "error" })({
      ...event,
      credential: { ...event.credential, fields: { password: "secret" } },
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(Credential)({
      ...metadata,
      refs: { password: "https://wrong.test/password" },
    }),
  ).toThrow();
});

test("enforces request limits and requires an effective update field", () => {
  const decode = Schema.decodeUnknownSync(CreateCredentialRequest, { onExcessProperty: "error" });
  expect(
    decode({
      name: "Stored",
      fields: { password: "x".repeat(16384) },
      generate: { mode: "random", length: 32 },
    }).name,
  ).toBe("Stored");
  for (const value of [
    { name: "" },
    { name: "x".repeat(201) },
    { name: "Stored", username: "x".repeat(321) },
    { name: "Stored", fields: { password: "" } },
    { name: "Stored", fields: { password: "x".repeat(16385) } },
    { name: "Stored", fields: { "bad.name": "secret" } },
    { name: "Stored", fields: { Totp: "secret" } },
    {
      name: "Stored",
      fields: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`field_${i}`, "value"])),
    },
    { name: "Stored", origins: Array.from({ length: 17 }, (_, i) => `https://origin${i}.test`) },
  ])
    expect(() => decode(value)).toThrow();
  expect(() => Schema.decodeUnknownSync(UpdateCredentialRequest)({})).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(UpdateCredentialRequest, { onExcessProperty: "error" })({
      unknown: "value",
    }),
  ).toThrow();
  expect(() => Schema.decodeUnknownSync(GenerateFieldRequest)({ field: "totp" })).toThrow();
  expect(
    Schema.decodeUnknownSync(UpdateCredentialRequest)({ remove_fields: ["password"] }),
  ).toEqual({ remove_fields: ["password"] });
  const permissions = {
    credential_read: true,
    credential_create: false,
    credential_update: true,
    credential_delete: true,
    credential_totp: false,
  };
  expect(Schema.decodeUnknownSync(Permissions, { onExcessProperty: "error" })(permissions)).toEqual(
    permissions,
  );
});
