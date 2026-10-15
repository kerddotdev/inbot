import { Schema } from "effect";
import {
  CredentialFieldName,
  type Credential,
  type CreateCredentialRequest,
  type GenerateFieldRequest,
  type UpdateCredentialRequest,
} from "@inbot/contracts/src/vault.js";

export interface AddedField {
  readonly id: number;
  readonly name: string;
  readonly value: string;
}

export interface EditForm {
  readonly name: string;
  readonly url: string;
  readonly origins: string;
  readonly username: string;
  readonly removed: ReadonlySet<string>;
  readonly replacements: Readonly<Record<string, string>>;
  readonly added: readonly AddedField[];
}

export const isFieldName = Schema.is(CredentialFieldName);

export function originOf(url: string | undefined) {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function extraOrigins(credential: Pick<Credential, "url" | "origins">) {
  const own = originOf(credential.url);
  return credential.origins.filter((origin) => origin !== own);
}

export const parseLines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export function addedFieldValues(added: readonly AddedField[]) {
  return added
    .filter((field) => field.name.trim() !== "" || field.value !== "")
    .map((field) => ({ name: field.name.trim(), value: field.value }));
}

export function invalidFieldNames(added: readonly AddedField[]) {
  return addedFieldValues(added)
    .filter((field) => !isFieldName(field.name) || field.value === "")
    .map((field) => field.name);
}

export function initialEditForm(credential: Credential): EditForm {
  return {
    name: credential.name,
    url: credential.url ?? "",
    origins: extraOrigins(credential).join("\n"),
    username: credential.username ?? "",
    removed: new Set(),
    replacements: {},
    added: [],
  };
}

export function buildUpdate(
  credential: Credential,
  form: EditForm,
): UpdateCredentialRequest | undefined {
  const origins = parseLines(form.origins);
  const original = extraOrigins(credential);
  const fields: Record<string, string> = {};
  for (const [field, value] of Object.entries(form.replacements))
    if (value !== "" && !form.removed.has(field)) fields[field] = value;
  for (const field of addedFieldValues(form.added)) fields[field.name] = field.value;
  const removeFields = credential.fields.filter((field) => form.removed.has(field));
  const url = form.url.trim();
  const name = form.name.trim();
  const username = form.username.trim();
  const update: UpdateCredentialRequest = {
    ...(name !== credential.name ? { name } : {}),
    ...(url !== "" && url !== (credential.url ?? "") ? { url } : {}),
    ...(origins.join("\n") !== original.join("\n") ? { origins } : {}),
    ...(username !== (credential.username ?? "") ? { username } : {}),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    ...(removeFields.length > 0 ? { remove_fields: removeFields } : {}),
  };
  return Object.keys(update).length === 0 ? undefined : update;
}

export interface CreateForm {
  readonly name: string;
  readonly url: string;
  readonly username: string;
  readonly mode: "generate" | "enter";
  readonly fields: readonly AddedField[];
}

export function buildCreate(form: CreateForm): CreateCredentialRequest {
  const url = form.url.trim();
  const username = form.username.trim();
  const fields = Object.fromEntries(
    addedFieldValues(form.fields).map((field) => [field.name, field.value]),
  );
  return {
    name: form.name.trim(),
    ...(url ? { url } : {}),
    ...(username ? { username } : {}),
    ...(form.mode === "generate" ? { generate: {} } : { fields }),
  };
}

export function buildGenerate(input: {
  field: string;
  mode: "apple" | "random";
  length: string;
  rules: string;
}): GenerateFieldRequest {
  const length = Number.parseInt(input.length, 10);
  const rules = input.rules.trim();
  return {
    field: input.field.trim() || "password",
    mode: input.mode,
    ...(input.mode === "random" && Number.isInteger(length) ? { length } : {}),
    ...(rules ? { rules } : {}),
  };
}
