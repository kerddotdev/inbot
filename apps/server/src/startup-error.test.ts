import { expect, test } from "vitest";
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
import { startupFailure } from "./startup-error.js";

const secret = "synthetic-secret-must-not-be-logged";

test("startup failures keep existing stable codes and fixes without serializing sensitive details", () => {
  const failures = [
    new HomeError({}),
    ...(
      [
        "not_initialized",
        "already_initialized",
        "locked",
        "last_unlock_method",
        "invalid_configuration",
        "method_not_configured",
      ] as const
    ).map((reason) => new KeyStateError({ reason })),
    new KeychainError({ operation: secret }),
    new KeychainEntryMissing({}),
    new KeysFileCorrupt({}),
    new KeyStorageError({ operation: secret }),
    new KeyCryptoError({}),
    new InvalidPassphrase({}),
    new DatabaseKeyInvalid({}),
    new DatabaseError({ operation: secret }),
    new ConnectionError({}),
  ];
  for (const error of failures) {
    const wire: unknown = JSON.parse(JSON.stringify(startupFailure(error)));
    expect(wire).toMatchObject({
      event: "server.failed",
      code: error.code,
      fix: error.fix,
      cause: error._tag,
      message: expect.any(String),
    });
    expect(JSON.stringify(wire)).not.toContain(secret);
  }
});

test("unknown startup failures cannot inject a code, fix, cause or secret into diagnostics", () => {
  for (const error of [
    new Error(secret),
    { _tag: secret, code: secret, fix: secret },
    secret,
    null,
  ]) {
    const result = startupFailure(error);
    expect(result.code).toBe("service_unavailable");
    expect(result.fix).toContain("--init");
    expect(JSON.stringify(result)).not.toContain(secret);
  }
});
