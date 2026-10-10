import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import { KeychainStore } from "./keychain.js";

vi.mock("@napi-rs/keyring", () => {
  const passwords = new Map<string, string>();
  return {
    AsyncEntry: class {
      private readonly id: string;

      constructor(service: string, account: string) {
        this.id = `${service}\0${account}`;
      }

      async getPassword() {
        return passwords.get(this.id) ?? null;
      }

      async setPassword(password: string) {
        passwords.set(this.id, password);
      }

      async deletePassword() {
        return passwords.delete(this.id);
      }
    },
  };
});

test("normalizes native null for missing credentials and preserves roundtrips", async () => {
  const home = await mkdtemp(join(tmpdir(), "inbot-keychain-test-"));
  try {
    await Effect.runPromise(
      KeychainStore.use((store) =>
        Effect.gen(function* () {
          expect(yield* store.get("synthetic-service", home)).toBeUndefined();
          yield* store.set("synthetic-service", home, "synthetic-secret");
          expect(yield* store.get("synthetic-service", home)).toBe("synthetic-secret");
          yield* store.delete("synthetic-service", home);
          expect(yield* store.get("synthetic-service", home)).toBeUndefined();
        }).pipe(Effect.ensuring(store.delete("synthetic-service", home).pipe(Effect.orDie))),
      ).pipe(Effect.provide(KeychainStore.Live)),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
