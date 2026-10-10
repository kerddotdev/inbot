import { identityToRecipient } from "age-encryption";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { generateIdentity } from "../../../../packages/envelope/src/index.js";
import { Store, type DatabaseError } from "../store.js";
import { BufferError } from "./cloudflare.js";

const Name = Schema.String.check(Schema.isMinLength(1));
const Settings = Schema.Struct({
  account_id: Name,
  bucket: Name,
  inbound_queue_id: Name,
  events_queue_id: Name,
});
export type InboundSettings = typeof Settings.Type & {
  readonly identity: Redacted.Redacted<string>;
};
const IdentityRow = Schema.Struct({ identity: Schema.String });

export class InboundConfig extends Context.Service<
  InboundConfig,
  {
    readonly get: () => Effect.Effect<InboundSettings | undefined, DatabaseError>;
    readonly set: (
      settings: typeof Settings.Type,
    ) => Effect.Effect<void, DatabaseError | BufferError>;
    readonly clear: () => Effect.Effect<void, DatabaseError>;
    readonly generateInboundIdentity: () => Effect.Effect<
      Redacted.Redacted<string>,
      DatabaseError | BufferError
    >;
    readonly getRecipient: () => Effect.Effect<string | undefined, DatabaseError | BufferError>;
  }
>()("inbot/InboundConfig") {
  static readonly Live = Layer.effect(
    InboundConfig,
    Effect.gen(function* () {
      const store = yield* Store;
      const getIdentity = () =>
        store.use((db) => {
          const row = db.prepare("SELECT identity FROM inbound_identity WHERE id = 1").get();
          return row === undefined
            ? undefined
            : Redacted.make(Schema.decodeUnknownSync(IdentityRow)(row).identity);
        });
      const generateInboundIdentity = () =>
        Effect.gen(function* () {
          const existing = yield* getIdentity();
          if (existing !== undefined) return existing;
          const generated = yield* Effect.tryPromise({
            try: generateIdentity,
            catch: () => new BufferError({ code: "identity_failed" }),
          });
          return yield* store.use((db) => {
            db.prepare("INSERT OR IGNORE INTO inbound_identity (id, identity) VALUES (1, ?)").run(
              generated.identity,
            );
            return Redacted.make(
              Schema.decodeUnknownSync(IdentityRow)(
                db.prepare("SELECT identity FROM inbound_identity WHERE id = 1").get(),
              ).identity,
            );
          });
        });
      return {
        get: () =>
          Effect.gen(function* () {
            const settings = yield* store.use((db) => {
              const row = db
                .prepare(
                  "SELECT account_id, bucket, inbound_queue_id, events_queue_id FROM inbound_config WHERE id = 1",
                )
                .get();
              return row === undefined ? undefined : Schema.decodeUnknownSync(Settings)(row);
            });
            const identity = yield* getIdentity();
            return settings === undefined || identity === undefined
              ? undefined
              : { ...settings, identity };
          }),
        set: (input) =>
          Effect.gen(function* () {
            const settings = yield* Schema.decodeUnknownEffect(Settings)(input).pipe(
              Effect.mapError(() => new BufferError({ code: "invalid_config" })),
            );
            yield* generateInboundIdentity();
            yield* store.use((db) => {
              db.prepare(
                "INSERT INTO inbound_config (id, account_id, bucket, inbound_queue_id, events_queue_id) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, bucket = excluded.bucket, inbound_queue_id = excluded.inbound_queue_id, events_queue_id = excluded.events_queue_id",
              ).run(
                settings.account_id,
                settings.bucket,
                settings.inbound_queue_id,
                settings.events_queue_id,
              );
            });
          }),
        clear: () =>
          store.use((db) => {
            db.prepare("DELETE FROM inbound_config").run();
          }),
        generateInboundIdentity,
        getRecipient: () =>
          Effect.gen(function* () {
            const identity = yield* getIdentity();
            if (identity === undefined) return undefined;
            return yield* Effect.tryPromise({
              try: () => identityToRecipient(Redacted.value(identity)),
              catch: () => new BufferError({ code: "identity_failed" }),
            });
          }),
      };
    }),
  );
}

export function generateInboundIdentity() {
  return Effect.flatMap(InboundConfig, (config) => config.generateInboundIdentity());
}
