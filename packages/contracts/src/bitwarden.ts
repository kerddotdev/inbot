import { Schema } from "effect";
import { InboxId } from "./common.js";
import { Credential } from "./vault.js";

const nullableText = Schema.optionalKey(Schema.NullOr(Schema.String));
export const BitwardenLoginItem = Schema.Struct({
  id: nullableText,
  folderId: nullableText,
  type: Schema.Int,
  name: Schema.String,
  notes: nullableText,
  login: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        username: nullableText,
        password: nullableText,
        totp: nullableText,
        uris: Schema.optionalKey(
          Schema.NullOr(
            Schema.Array(
              Schema.Struct({
                uri: nullableText,
                match: Schema.optionalKey(Schema.NullOr(Schema.Int)),
              }),
            ),
          ),
        ),
      }),
    ),
  ),
  fields: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          name: nullableText,
          value: nullableText,
          type: Schema.Int,
        }),
      ),
    ),
  ),
});
export type BitwardenLoginItem = typeof BitwardenLoginItem.Type;

export const BitwardenImport = Schema.Struct({
  encrypted: Schema.optionalKey(Schema.Boolean),
  items: Schema.optionalKey(Schema.Array(Schema.Unknown)),
}).annotate({ identifier: "BitwardenImport" });
export const BitwardenExport = Schema.Struct({
  encrypted: Schema.Literal(false),
  folders: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  items: Schema.Array(BitwardenLoginItem),
}).annotate({ identifier: "BitwardenExport" });
export type BitwardenExport = typeof BitwardenExport.Type;

export const ExportCredentialsQuery = Schema.Struct({ inbox_id: Schema.optionalKey(InboxId) });
export const ImportCredentialsQuery = Schema.Struct({
  inbox_id: InboxId,
  on_duplicate: Schema.optionalKey(Schema.Literals(["skip", "create"])),
});
export type ImportCredentialsQuery = typeof ImportCredentialsQuery.Type;
export const ImportCredentialsResponse = Schema.Struct({
  imported: Schema.Int,
  skipped: Schema.Int,
  reasons: Schema.Record(Schema.String, Schema.Int),
  credentials: Schema.Array(Credential),
}).annotate({ identifier: "ImportCredentialsResponse" });
export type ImportCredentialsResponse = typeof ImportCredentialsResponse.Type;
export const BITWARDEN_MAX_BYTES = 5 * 1024 * 1024;
