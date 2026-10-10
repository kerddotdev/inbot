import { Schema } from "effect";

const WrappedKey = Schema.Struct({
  nonce: Schema.String.check(Schema.isPattern(/^[0-9a-f]{24}$/)),
  ciphertext: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  tag: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
});

export const PassphraseKdf = Schema.Struct({
  algorithm: Schema.Literal("argon2id"),
  memory: Schema.Int.check(Schema.isBetween({ minimum: 19456, maximum: 262144 })),
  passes: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 10 })),
  parallelism: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 })),
  salt: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
});

export const KeysFile = Schema.Struct({
  version: Schema.Literal(1),
  keychain: Schema.optionalKey(WrappedKey),
  passphrase: Schema.optionalKey(
    Schema.Struct({
      wrapped: WrappedKey,
      kdf: PassphraseKdf,
    }),
  ),
}).check(
  Schema.makeFilter((file) =>
    file.keychain || file.passphrase ? undefined : "At least one unlock method is required.",
  ),
);

export const KeysJson = Schema.fromJsonString(KeysFile);
export type KeysFile = typeof KeysFile.Type;
export type PassphraseKdf = typeof PassphraseKdf.Type;
export type WrappedKey = typeof WrappedKey.Type;
