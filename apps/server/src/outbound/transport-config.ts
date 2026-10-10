import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { Store, type DatabaseError } from "../store.js";
import { invalid, type OutboundError } from "./errors.js";

const Settings = Schema.Struct({
  account_id: Schema.String.check(Schema.isMinLength(1)),
  api_token: Schema.String.check(Schema.isMinLength(1)),
});

export class TransportConfig extends Context.Service<
  TransportConfig,
  {
    readonly get: () => Effect.Effect<
      | {
          readonly account_id: string;
          readonly api_token: Redacted.Redacted<string>;
          readonly verified_at?: string;
        }
      | undefined,
      DatabaseError
    >;
    readonly set: (
      settings: typeof Settings.Type,
      verifiedAt?: string,
    ) => Effect.Effect<void, DatabaseError | OutboundError>;
    readonly clear: () => Effect.Effect<void, DatabaseError>;
  }
>()("inbot/TransportConfig") {
  static readonly Live = Layer.effect(
    TransportConfig,
    Effect.gen(function* () {
      const store = yield* Store;
      return {
        get: () =>
          store.use((db) => {
            const row = db
              .prepare("SELECT account_id, api_token FROM transport_config WHERE id = 1")
              .get();
            if (row === undefined) return undefined;
            const settings = Schema.decodeUnknownSync(Settings)(row);
            const verification = db
              .prepare("SELECT value FROM meta WHERE key = 'transport_verified_at'")
              .get();
            const verifiedAt =
              verification === undefined
                ? undefined
                : Schema.decodeUnknownSync(Schema.Struct({ value: Schema.String }))(verification)
                    .value;
            return {
              account_id: settings.account_id,
              api_token: Redacted.make(settings.api_token),
              ...(verifiedAt === undefined ? {} : { verified_at: verifiedAt }),
            };
          }),
        set: (input, verifiedAt) =>
          Effect.gen(function* () {
            const settings = yield* Schema.decodeUnknownEffect(Settings)(input).pipe(
              Effect.mapError(() => invalid("A Cloudflare account ID and API token are required.")),
            );
            yield* store.use((db) => {
              db.transaction(() => {
                db.prepare(
                  "INSERT INTO transport_config (id, account_id, api_token) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, api_token = excluded.api_token",
                ).run(settings.account_id, settings.api_token);
                db.prepare("DELETE FROM meta WHERE key = 'transport_verified_at'").run();
                if (verifiedAt !== undefined)
                  db.prepare(
                    "INSERT INTO meta (key, value) VALUES ('transport_verified_at', ?)",
                  ).run(verifiedAt);
              }).immediate();
            });
          }),
        clear: () =>
          store.use((db) => {
            db.transaction(() => {
              db.prepare("DELETE FROM transport_config").run();
              db.prepare("DELETE FROM meta WHERE key = 'transport_verified_at'").run();
            }).immediate();
          }),
      };
    }),
  );
}
