import {
  argon2,
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import { Home } from "./home.js";
import { KeychainStore } from "./keychain.js";
import {
  InvalidPassphrase,
  KeychainEntryMissing,
  KeyCryptoError,
  KeysFileCorrupt,
  KeyStateError,
  KeyStorageError,
  type KeyError,
} from "./key-errors.js";
import { KeysJson, type KeysFile, type PassphraseKdf, type WrappedKey } from "./key-format.js";

export const keychainService = "dev.kerd.inbot";

export function keychainAccount(absoluteHome: string): string {
  return createHash("sha256").update(absoluteHome).digest("hex").slice(0, 16);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function readKeys(path: string) {
  return Effect.gen(function* () {
    const json = yield* Effect.tryPromise({
      try: () =>
        readFile(path, "utf8").catch((error: unknown) => {
          if (isMissing(error)) return undefined;
          throw error;
        }),
      catch: () => new KeyStorageError({ operation: "read" }),
    });
    if (json === undefined) return undefined;
    return yield* Schema.decodeUnknownEffect(KeysJson)(json).pipe(
      Effect.mapError(() => new KeysFileCorrupt({})),
    );
  });
}

function writeKeys(path: string, file: KeysFile) {
  return Effect.gen(function* () {
    const json = yield* Schema.encodeEffect(KeysJson)(file).pipe(
      Effect.mapError(() => new KeysFileCorrupt({})),
    );
    yield* Effect.tryPromise({
      try: async () => {
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          const handle = await open(temporary, "wx", 0o600);
          try {
            await handle.writeFile(`${json}\n`, "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
      },
      catch: () => new KeyStorageError({ operation: "write" }),
    });
  });
}

function derivePassphrase(passphrase: string, kdf: PassphraseKdf) {
  return Effect.tryPromise({
    try: () =>
      new Promise<Buffer>((resolve, reject) => {
        argon2(
          "argon2id",
          {
            message: passphrase,
            nonce: Buffer.from(kdf.salt, "hex"),
            memory: kdf.memory,
            passes: kdf.passes,
            parallelism: kdf.parallelism,
            tagLength: 32,
          },
          (error, key) => {
            if (error) reject(error);
            else resolve(key);
          },
        );
      }),
    catch: () => new KeyCryptoError({}),
  });
}

function wrap(dek: Buffer, kek: Buffer, method: "keychain" | "passphrase") {
  return Effect.try({
    try: (): WrappedKey => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", kek, nonce);
      cipher.setAAD(Buffer.from(`dev.kerd.inbot:1:${method}`));
      const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
      return {
        nonce: nonce.toString("hex"),
        ciphertext: ciphertext.toString("hex"),
        tag: cipher.getAuthTag().toString("hex"),
      };
    },
    catch: () => new KeyCryptoError({}),
  });
}

function unwrap<E>(wrapped: WrappedKey, kek: Buffer, method: "keychain" | "passphrase", error: E) {
  return Effect.try({
    try: () => {
      const decipher = createDecipheriv("aes-256-gcm", kek, Buffer.from(wrapped.nonce, "hex"));
      decipher.setAAD(Buffer.from(`dev.kerd.inbot:1:${method}`));
      decipher.setAuthTag(Buffer.from(wrapped.tag, "hex"));
      return Buffer.concat([
        decipher.update(Buffer.from(wrapped.ciphertext, "hex")),
        decipher.final(),
      ]);
    },
    catch: () => error,
  });
}

function passphraseWrap(dek: Buffer, passphrase: string) {
  return Effect.gen(function* () {
    if (passphrase.length === 0) {
      return yield* new KeyStateError({ reason: "invalid_configuration" });
    }
    const kdf: PassphraseKdf = {
      algorithm: "argon2id",
      memory: 19456,
      passes: 2,
      parallelism: 1,
      salt: randomBytes(16).toString("hex"),
    };
    const kek = yield* derivePassphrase(passphrase, kdf);
    const wrapped = yield* wrap(dek, kek, "passphrase").pipe(
      Effect.ensuring(Effect.sync(() => kek.fill(0))),
    );
    return { kdf, wrapped };
  });
}

export interface KeyStatus {
  readonly initialized: boolean;
  readonly keychain: boolean;
  readonly passphrase: boolean;
}

export interface KeyManagerService {
  readonly initialize: (options: {
    readonly passphrase?: string;
    readonly useKeychain: boolean;
  }) => Effect.Effect<Buffer, KeyError>;
  readonly unlockWithKeychain: () => Effect.Effect<Buffer, KeyError>;
  readonly unlockWithPassphrase: (passphrase: string) => Effect.Effect<Buffer, KeyError>;
  readonly enablePassphrase: (passphrase: string) => Effect.Effect<void, KeyError>;
  readonly disablePassphrase: () => Effect.Effect<void, KeyError>;
  readonly enableKeychain: () => Effect.Effect<void, KeyError>;
  readonly disableKeychain: () => Effect.Effect<void, KeyError>;
  readonly status: () => Effect.Effect<KeyStatus, KeyError>;
  readonly lock: () => Effect.Effect<void>;
}

export class KeyManager extends Context.Service<KeyManager, KeyManagerService>()(
  "inbot/KeyManager",
) {
  static readonly Live = Layer.effect(
    KeyManager,
    Effect.gen(function* () {
      const home = yield* Home;
      const keychain = yield* KeychainStore;
      const mutex = yield* Semaphore.make(1);
      const path = join(home.path, "keys.json");
      const account = keychainAccount(home.path);
      let unlocked: Buffer | undefined;

      const clear = () => {
        unlocked?.fill(0);
        unlocked = undefined;
      };
      yield* Effect.addFinalizer(() => Effect.sync(clear));

      const remember = (dek: Buffer) => {
        clear();
        unlocked = dek;
        return Buffer.from(dek);
      };
      const serialized = <A, E>(effect: Effect.Effect<A, E>) =>
        mutex.withPermit(Effect.uninterruptible(effect));
      const requireUnlocked = Effect.suspend(() =>
        unlocked ? Effect.succeed(unlocked) : Effect.fail(new KeyStateError({ reason: "locked" })),
      );
      const requireFile = Effect.gen(function* () {
        const file = yield* readKeys(path);
        if (!file) return yield* new KeyStateError({ reason: "not_initialized" });
        return file;
      });

      const addKeychain = (file: KeysFile, dek: Buffer) =>
        Effect.gen(function* () {
          const existing = yield* keychain.get(keychainService, account);
          if (existing !== undefined && !/^[0-9a-f]{64}$/.test(existing)) {
            return yield* new KeysFileCorrupt({});
          }
          const kek = existing === undefined ? randomBytes(32) : Buffer.from(existing, "hex");
          yield* Effect.gen(function* () {
            const wrapped = yield* wrap(dek, kek, "keychain");
            if (existing === undefined) {
              yield* keychain.set(keychainService, account, kek.toString("hex"));
            }
            yield* writeKeys(path, { ...file, keychain: wrapped }).pipe(
              Effect.catch((error) =>
                existing === undefined
                  ? keychain
                      .delete(keychainService, account)
                      .pipe(Effect.andThen(Effect.fail(error)))
                  : Effect.fail(error),
              ),
            );
          }).pipe(Effect.ensuring(Effect.sync(() => kek.fill(0))));
        });

      return KeyManager.of({
        initialize: (options) =>
          serialized(
            Effect.gen(function* () {
              if (
                (!options.useKeychain && options.passphrase === undefined) ||
                options.passphrase === ""
              ) {
                return yield* new KeyStateError({ reason: "invalid_configuration" });
              }
              if (yield* readKeys(path)) {
                return yield* new KeyStateError({ reason: "already_initialized" });
              }
              const databaseExists = yield* Effect.tryPromise({
                try: () =>
                  stat(join(home.path, "inbot.db"))
                    .then(() => true)
                    .catch((error: unknown) => {
                      if (isMissing(error)) return false;
                      throw error;
                    }),
                catch: () => new KeyStorageError({ operation: "inspect" }),
              });
              if (databaseExists) {
                return yield* new KeyStateError({ reason: "already_initialized" });
              }
              const dek = randomBytes(32);
              return yield* Effect.gen(function* () {
                const file: KeysFile =
                  options.passphrase === undefined
                    ? { version: 1 }
                    : { version: 1, passphrase: yield* passphraseWrap(dek, options.passphrase) };
                if (options.useKeychain) yield* addKeychain(file, dek);
                else yield* writeKeys(path, file);
                return remember(dek);
              }).pipe(
                Effect.catch((error) => {
                  dek.fill(0);
                  return Effect.fail(error);
                }),
              );
            }),
          ),
        unlockWithKeychain: () =>
          serialized(
            Effect.gen(function* () {
              const file = yield* requireFile;
              if (!file.keychain) {
                return yield* new KeyStateError({ reason: "method_not_configured" });
              }
              const password = yield* keychain.get(keychainService, account);
              if (password === undefined) return yield* new KeychainEntryMissing({});
              if (!/^[0-9a-f]{64}$/.test(password)) return yield* new KeysFileCorrupt({});
              const kek = Buffer.from(password, "hex");
              const dek = yield* unwrap(
                file.keychain,
                kek,
                "keychain",
                new KeysFileCorrupt({}),
              ).pipe(Effect.ensuring(Effect.sync(() => kek.fill(0))));
              return remember(dek);
            }),
          ),
        unlockWithPassphrase: (passphrase) =>
          serialized(
            Effect.gen(function* () {
              const file = yield* requireFile;
              if (!file.passphrase) {
                return yield* new KeyStateError({ reason: "method_not_configured" });
              }
              const kek = yield* derivePassphrase(passphrase, file.passphrase.kdf);
              const dek = yield* unwrap(
                file.passphrase.wrapped,
                kek,
                "passphrase",
                new InvalidPassphrase({}),
              ).pipe(Effect.ensuring(Effect.sync(() => kek.fill(0))));
              return remember(dek);
            }),
          ),
        enablePassphrase: (passphrase) =>
          serialized(
            Effect.gen(function* () {
              const dek = yield* requireUnlocked;
              const file = yield* requireFile;
              yield* writeKeys(path, {
                ...file,
                passphrase: yield* passphraseWrap(dek, passphrase),
              });
            }),
          ),
        disablePassphrase: () =>
          serialized(
            Effect.gen(function* () {
              yield* requireUnlocked;
              const file = yield* requireFile;
              if (!file.keychain) return yield* new KeyStateError({ reason: "last_unlock_method" });
              if (file.passphrase) yield* writeKeys(path, { version: 1, keychain: file.keychain });
            }),
          ),
        enableKeychain: () =>
          serialized(
            Effect.gen(function* () {
              const dek = yield* requireUnlocked;
              const file = yield* requireFile;
              yield* addKeychain(file, dek);
            }),
          ),
        disableKeychain: () =>
          serialized(
            Effect.gen(function* () {
              yield* requireUnlocked;
              const file = yield* requireFile;
              if (!file.passphrase)
                return yield* new KeyStateError({ reason: "last_unlock_method" });
              if (file.keychain) {
                yield* writeKeys(path, { version: 1, passphrase: file.passphrase });
              }
              yield* keychain.delete(keychainService, account);
            }),
          ),
        status: () =>
          serialized(
            Effect.gen(function* () {
              const file = yield* readKeys(path);
              return {
                initialized: file !== undefined,
                keychain: file?.keychain !== undefined,
                passphrase: file?.passphrase !== undefined,
              };
            }),
          ),
        lock: () => mutex.withPermit(Effect.sync(clear)),
      });
    }),
  );
}
