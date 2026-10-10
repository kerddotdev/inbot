import { Schema } from "effect";
import type { KeychainError } from "./keychain.js";

export class InvalidPassphrase extends Schema.TaggedError<InvalidPassphrase>()(
  "InvalidPassphrase",
  {},
) {
  readonly code = "invalid_passphrase";
  readonly fix = "Enter the correct passphrase or unlock with the OS credential store.";
}

export class KeychainEntryMissing extends Schema.TaggedError<KeychainEntryMissing>()(
  "KeychainEntryMissing",
  {},
) {
  readonly code = "keychain_entry_missing";
  readonly fix = "Unlock with a passphrase and enable keychain access again.";
}

export class KeysFileCorrupt extends Schema.TaggedError<KeysFileCorrupt>()("KeysFileCorrupt", {}) {
  readonly code = "keys_file_corrupt";
  readonly fix = "Restore keys.json from a backup of this home. Do not initialize new keys.";
}

export class KeyStorageError extends Schema.TaggedError<KeyStorageError>()("KeyStorageError", {
  operation: Schema.String,
}) {
  readonly code = "key_storage_unavailable";
  readonly fix = "Check the home directory permissions and available disk space, then retry.";
}

export class KeyStateError extends Schema.TaggedError<KeyStateError>()("KeyStateError", {
  reason: Schema.Literals([
    "already_initialized",
    "not_initialized",
    "locked",
    "last_unlock_method",
    "invalid_configuration",
    "method_not_configured",
  ]),
}) {
  get code() {
    return this.reason;
  }

  get fix() {
    switch (this.reason) {
      case "already_initialized":
        return "Unlock the existing home instead of replacing its keys.";
      case "not_initialized":
        return "Initialize this home with at least one unlock method.";
      case "locked":
        return "Unlock this home before changing its unlock methods.";
      case "last_unlock_method":
        return "Enable another unlock method before removing this one.";
      case "invalid_configuration":
        return "Enable keychain access or provide a non-empty passphrase.";
      case "method_not_configured":
        return "Use an unlock method configured for this home.";
    }
  }
}

export class KeyCryptoError extends Schema.TaggedError<KeyCryptoError>()("KeyCryptoError", {}) {
  readonly code = "key_crypto_failed";
  readonly fix = "Check the Node.js version and available memory, then retry.";
}

export type KeyError =
  | InvalidPassphrase
  | KeychainEntryMissing
  | KeysFileCorrupt
  | KeyStorageError
  | KeyStateError
  | KeyCryptoError
  | KeychainError;
