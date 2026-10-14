import { expect, test } from "vitest";
import type { Credential } from "@inbot/contracts/src/vault.js";
import { buildCreate, buildGenerate, buildUpdate, initialEditForm } from "./forms";

const stamp = "2026-10-14T12:00:00Z";
const credential: Credential = {
  credential_id: "a".repeat(32),
  inbox_id: "agent@example.test",
  name: "Example",
  url: "https://example.test/login",
  origins: ["https://example.test", "https://accounts.example.test"],
  username: "agent",
  fields: ["password", "totp"],
  refs: {},
  created_at: stamp,
  updated_at: stamp,
};

test("an untouched edit form produces no update", () => {
  expect(buildUpdate(credential, initialEditForm(credential))).toBeUndefined();
});

test("edit sends only changed metadata, replaced and removed fields", () => {
  const form = {
    ...initialEditForm(credential),
    username: "new-agent",
    origins: "https://accounts.example.test\nhttps://sso.example.test\n",
    removed: new Set(["totp"]),
    replacements: { password: "n3w", totp: "ignored" },
    added: [{ id: 1, name: " recovery ", value: "code" }],
  };
  expect(buildUpdate(credential, form)).toEqual({
    username: "new-agent",
    origins: ["https://accounts.example.test", "https://sso.example.test"],
    fields: { password: "n3w", recovery: "code" },
    remove_fields: ["totp"],
  });
});

test("clearing the username is an update, clearing the URL is not", () => {
  const form = { ...initialEditForm(credential), username: "", url: "" };
  expect(buildUpdate(credential, form)).toEqual({ username: "" });
});

test("create either generates a password or sends entered fields, never both", () => {
  const base = { name: " Example ", url: "", username: " me ", fields: [] };
  expect(buildCreate({ ...base, mode: "generate" })).toEqual({
    name: "Example",
    username: "me",
    generate: {},
  });
  expect(
    buildCreate({ ...base, mode: "enter", fields: [{ id: 1, name: "password", value: "x" }] }),
  ).toEqual({ name: "Example", username: "me", fields: { password: "x" } });
});

test("generate ignores length for the memorable style and defaults the field", () => {
  expect(buildGenerate({ field: " ", mode: "apple", length: "20", rules: "" })).toEqual({
    field: "password",
    mode: "apple",
  });
  expect(
    buildGenerate({ field: "pin", mode: "random", length: "20", rules: " minlength: 8; " }),
  ).toEqual({
    field: "pin",
    mode: "random",
    length: 20,
    rules: "minlength: 8;",
  });
});
