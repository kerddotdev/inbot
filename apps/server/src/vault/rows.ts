import type Database from "better-sqlite3-multiple-ciphers";
import { Schema } from "effect";
import { CredentialFieldName, type Credential } from "../../../../packages/contracts/src/vault.js";
import { notFound } from "../mailbox/errors.js";
import { credentialOrigins } from "./origins.js";

export const CredentialRow = Schema.Struct({
  credential_id: Schema.String,
  inbox_id: Schema.String,
  name: Schema.String,
  url: Schema.NullOr(Schema.String),
  origins: Schema.fromJsonString(Schema.Array(Schema.String)),
  username: Schema.NullOr(Schema.String),
  created_by: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
  last_used_at: Schema.NullOr(Schema.String),
});
export type CredentialRow = typeof CredentialRow.Type;

export function getCredential(db: Database.Database, id: string, inboxId: string) {
  const value = db
    .prepare("SELECT * FROM credentials WHERE credential_id = ? AND inbox_id = ?")
    .get(id, inboxId);
  if (value === undefined) throw notFound();
  return Schema.decodeUnknownSync(CredentialRow)(value);
}

export function fieldNames(db: Database.Database, id: string) {
  return Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: CredentialFieldName })))(
    db.prepare("SELECT name FROM credential_fields WHERE credential_id = ? ORDER BY name").all(id),
  ).map((field) => field.name);
}

export function credentialWire(db: Database.Database, row: CredentialRow): Credential {
  const fields = fieldNames(db, row.credential_id);
  return {
    credential_id: row.credential_id,
    inbox_id: row.inbox_id,
    name: row.name,
    origins: credentialOrigins(row.url ?? undefined, row.origins),
    fields,
    refs: Object.fromEntries(
      fields.map((field) => [field, `inbot://credentials/${row.credential_id}/${field}`]),
    ),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.url === null ? {} : { url: row.url }),
    ...(row.username === null ? {} : { username: row.username }),
    ...(row.last_used_at === null ? {} : { last_used_at: row.last_used_at }),
  };
}
