import { AsyncEntry } from "@napi-rs/keyring";
import { Context, Effect, Layer, Schema } from "effect";

export class KeychainError extends Schema.TaggedError<KeychainError>()("KeychainError", {
  operation: Schema.String,
}) {
  readonly code = "keychain_unavailable";
  readonly fix = "Unlock the OS credential store and allow Inbot to access it, then retry.";
}

export interface KeychainService {
  readonly get: (
    service: string,
    account: string,
  ) => Effect.Effect<string | undefined, KeychainError>;
  readonly set: (
    service: string,
    account: string,
    password: string,
  ) => Effect.Effect<void, KeychainError>;
  readonly delete: (service: string, account: string) => Effect.Effect<void, KeychainError>;
}

export class KeychainStore extends Context.Service<KeychainStore, KeychainService>()(
  "inbot/KeychainStore",
) {
  static readonly Live = Layer.succeed(KeychainStore, {
    get: (service, account) =>
      Effect.tryPromise({
        try: async () => (await new AsyncEntry(service, account).getPassword()) ?? undefined,
        catch: () => new KeychainError({ operation: "get" }),
      }),
    set: (service, account, password) =>
      Effect.tryPromise({
        try: () => new AsyncEntry(service, account).setPassword(password),
        catch: () => new KeychainError({ operation: "set" }),
      }),
    delete: (service, account) =>
      Effect.tryPromise({
        try: async () => {
          await new AsyncEntry(service, account).deletePassword();
        },
        catch: () => new KeychainError({ operation: "delete" }),
      }),
  });

  static memory() {
    const passwords = new Map<string, string>();
    return Layer.succeed(KeychainStore, {
      get: (service, account) => Effect.sync(() => passwords.get(`${service}\0${account}`)),
      set: (service, account, password) =>
        Effect.sync(() => {
          passwords.set(`${service}\0${account}`, password);
        }),
      delete: (service, account) =>
        Effect.sync(() => {
          passwords.delete(`${service}\0${account}`);
        }),
    });
  }
}
