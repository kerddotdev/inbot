import { ConnectionError } from "./auth/owner.js";
import { HomeError } from "./home.js";
import {
  InvalidPassphrase,
  KeychainEntryMissing,
  KeyCryptoError,
  KeysFileCorrupt,
  KeyStateError,
  KeyStorageError,
} from "./key-errors.js";
import { KeychainError } from "./keychain.js";
import { DatabaseError, DatabaseKeyInvalid } from "./store.js";

export function startupFailure(error: unknown) {
  const known =
    error instanceof HomeError ||
    error instanceof KeyStateError ||
    error instanceof KeychainError ||
    error instanceof KeychainEntryMissing ||
    error instanceof KeysFileCorrupt ||
    error instanceof KeyStorageError ||
    error instanceof KeyCryptoError ||
    error instanceof InvalidPassphrase ||
    error instanceof DatabaseKeyInvalid ||
    error instanceof DatabaseError ||
    error instanceof ConnectionError;
  return {
    event: "server.failed",
    code: known ? error.code : "service_unavailable",
    cause: known ? error._tag : "UnexpectedError",
    message: "The server could not start or shut down cleanly.",
    fix: known
      ? error.fix
      : "Check command options, home permissions, and keychain access. A new home requires --init.",
  };
}
