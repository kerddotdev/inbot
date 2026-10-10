import { Schema } from "effect";
import type { Store } from "../store.js";

export const RemoteRow = Schema.Struct({
  desired: Schema.Literals(["enabled", "disabling"]),
  hostname: Schema.String,
  account_id: Schema.String,
  zone_id: Schema.String,
  zone_name: Schema.String,
  tunnel_name: Schema.String,
  tunnel_intent: Schema.Int,
  tunnel_id: Schema.NullOr(Schema.String),
  dns_intent: Schema.Int,
  dns_id: Schema.NullOr(Schema.String),
  token: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
});
export type RemoteRow = typeof RemoteRow.Type;

export function remoteRepository(store: Store["Service"]) {
  return {
    get: () =>
      store.use((db) => {
        const row = db.prepare("SELECT * FROM remote_access WHERE id = 1").get();
        return row === undefined ? undefined : Schema.decodeUnknownSync(RemoteRow)(row);
      }),
    save: (row: RemoteRow) =>
      store.use((db) => {
        const fields = Object.keys(RemoteRow.fields);
        db.prepare(
          `INSERT INTO remote_access (id, ${fields.join(", ")}) VALUES (1, ${fields.map((key) => `@${key}`).join(", ")}) ON CONFLICT(id) DO UPDATE SET ${fields.map((key) => `${key} = excluded.${key}`).join(", ")}`,
        ).run(row);
      }),
    clear: () =>
      store.use((db) => {
        db.prepare("DELETE FROM remote_access WHERE id = 1").run();
      }),
  };
}
