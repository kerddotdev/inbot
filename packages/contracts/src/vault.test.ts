import { Schema } from "effect";
import { expect, test } from "vitest";
import { Permissions } from "./api-keys.js";
import { CredentialEvent, Event } from "./events.js";
import {
  Credential,
  CreateCredentialRequest,
  UpdateCredentialRequest,
  GenerateFieldRequest,
  ResolveCredentialsRequest,
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
    credential_run: true,
    credential_fill: true,
  };
  expect(Schema.decodeUnknownSync(Permissions, { onExcessProperty: "error" })(permissions)).toEqual(
    permissions,
  );
});

test("validates browser targets, owner host settings and metadata-only usage events", async () => {
  const { FillCredentialRequest, CaptureCredentialRequest, FillCredentialResponse, VaultSettings } =
    await import("./vault.js");
  for (const schema of [FillCredentialRequest, CaptureCredentialRequest]) {
    const decode = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });
    const target = { cdp_endpoint: "http://127.0.0.1:9222", field: "totp", selector: "#code" };
    expect(decode(target)).toEqual(target);
    for (const cdp_endpoint of [
      "https://browser.test",
      "ws://localhost:9222/page",
      "wss://browser.test/connect",
    ])
      expect(
        decode({ ...target, cdp_endpoint, url: "https://site.test", target_id: "page-1" })
          .cdp_endpoint,
      ).toBe(cdp_endpoint);
    for (const input of [
      { ...target, cdp_endpoint: "file:///tmp/cdp" },
      { ...target, cdp_endpoint: "invalid" },
      { ...target, selector: "" },
      { ...target, selector: "x".repeat(1025) },
      { ...target, field: "invalid.field" },
      { ...target, value: "secret" },
    ])
      expect(() => decode(input)).toThrow();
  }
  const decode = Schema.decodeUnknownSync(VaultSettings);
  expect(
    decode({ remote_cdp_hosts: ["browser.test", "*.browserbase.com", "localhost"] })
      .remote_cdp_hosts,
  ).toHaveLength(3);
  for (const host of [
    "127.0.0.1",
    "127.1",
    "2130706433",
    "0x7f000001",
    "::1",
    "[::1]",
    "Browser.test",
    "https://browser.test",
    "browser.test:9222",
    "browser.test/path",
    "browser.test.",
    "*browser.test",
    "*.*.test",
    "-bad.test",
    "bad-.test",
    "",
    "999999999999999999999999999",
    "a".repeat(64) + ".test",
  ])
    expect(() => decode({ remote_cdp_hosts: [host] }), host).toThrow();
  expect(() =>
    decode({ remote_cdp_hosts: Array.from({ length: 33 }, (_, i) => `host${i}.test`) }),
  ).toThrow();
  for (const event_type of ["credential.used", "credential.captured"]) {
    const credential = {
      credential_id: id,
      inbox_id: metadata.inbox_id,
      field: "password",
      origin: "https://example.test",
      ...(event_type === "credential.used" ? { via: "fill" } : {}),
    };
    const event = { type: "event", event_type, event_id: "event-use", credential };
    expect(Schema.decodeUnknownSync(Event)(event)).toEqual(event);
    expect(() =>
      Schema.decodeUnknownSync(Event, { onExcessProperty: "error" })({
        ...event,
        credential: { ...credential, value: "secret" },
      }),
    ).toThrow();
    if (event_type === "credential.used")
      expect(() =>
        Schema.decodeUnknownSync(Event)({ ...event, credential: { ...credential, via: "paste" } }),
      ).toThrow();
  }
  expect(() =>
    Schema.decodeUnknownSync(FillCredentialResponse, { onExcessProperty: "error" })({
      credential_id: id,
      field: "password",
      origin: "https://example.test",
      url: "https://example.test/login",
      value: "secret",
    }),
  ).toThrow();
});

test("bounds and deduplicates credential resolution references and requires an age recipient", () => {
  const request = { refs: [metadata.refs.password], public_key: `age1${"q".repeat(58)}` };
  const decode = Schema.decodeUnknownSync(ResolveCredentialsRequest, { onExcessProperty: "error" });
  expect(decode(request)).toEqual(request);
  for (const refs of [
    [],
    [metadata.refs.password, metadata.refs.password],
    Array.from({ length: 33 }, (_, index) => `inbot://credentials/${id}/field_${index}`),
    [`inbot://credentials/${id}/Password`],
    [`inbot://credentials/${id}/password/extra`],
  ])
    expect(() => decode({ ...request, refs })).toThrow();
  for (const public_key of ["not-age", "AGE-SECRET-KEY-1SECRET", "age1invalid"])
    expect(() => decode({ ...request, public_key })).toThrow();
});
