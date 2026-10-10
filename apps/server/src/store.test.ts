import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { expect, test as baseTest, vi } from "vitest";
import { Home, resolveHome } from "./home.js";
import { KeychainStore } from "./keychain.js";
import {
  InvalidPassphrase,
  KeychainEntryMissing,
  KeysFileCorrupt,
  KeyStateError,
} from "./key-errors.js";
import { KeyManager, keychainAccount, keychainService, type KeyManagerService } from "./keys.js";
import {
  DatabaseError,
  DatabaseKeyInvalid,
  Store,
  migrate,
  migrations,
  type StoreService,
} from "./store.js";

const test = baseTest.extend<{
  home: string;
  keychain: Layer.Layer<KeychainStore>;
}>({
  home: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-test-"));
    try {
      await use(home);
    } finally {
      await rm(home, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
  keychain: async ({ home: _home }, use) => {
    await use(KeychainStore.memory());
  },
});

function keysLayer(home: string, keychain: Layer.Layer<KeychainStore>) {
  return KeyManager.Live.pipe(
    Layer.provide(Layer.merge(Home.layer({ flag: home, flavor: "development" }), keychain)),
  );
}

function withKeys<A, E>(
  home: string,
  keychain: Layer.Layer<KeychainStore>,
  use: (keys: KeyManagerService) => Effect.Effect<A, E>,
) {
  return Effect.gen(function* () {
    return yield* use(yield* KeyManager);
  }).pipe(Effect.provide(keysLayer(home, keychain)));
}

function withStore<A, E>(
  home: string,
  dek: Uint8Array,
  use: (store: StoreService) => Effect.Effect<A, E>,
) {
  return Effect.gen(function* () {
    return yield* use(yield* Store);
  }).pipe(
    Effect.provide(
      Store.layer(dek).pipe(Layer.provide(Home.layer({ flag: home, flavor: "development" }))),
    ),
  );
}

const MetaRow = Schema.Struct({ value: Schema.String });
const plaintext = "synthetic-private-message-5f4147b2";

function writeMeta(home: string, dek: Uint8Array) {
  return Effect.runPromise(
    withStore(home, dek, (store) =>
      store.use((database) => {
        database.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("test", plaintext);
      }),
    ),
  );
}

function readMeta(home: string, dek: Uint8Array) {
  return Effect.runPromise(
    withStore(home, dek, (store) =>
      store.use((database) =>
        Schema.decodeUnknownSync(MetaRow)(
          database.prepare("SELECT value FROM meta WHERE key = ?").get("test"),
        ),
      ),
    ),
  );
}

async function databaseHash(home: string) {
  return createHash("sha256")
    .update(await readFile(join(home, "inbot.db")))
    .digest("hex");
}

test("resolves flags before the environment and flavor-specific defaults", ({ home }) => {
  vi.stubEnv("INBOT_HOME", join(home, "process-env"));
  expect(resolveHome({ flag: home, env: join(home, "explicit-env"), flavor: "production" })).toBe(
    home,
  );
  expect(resolveHome({ env: join(home, "explicit-env"), flavor: "production" })).toBe(
    join(home, "explicit-env"),
  );
  expect(resolveHome({ flavor: "production" })).toBe(join(home, "process-env"));
  vi.stubEnv("INBOT_HOME", undefined);
  expect(resolveHome({ flavor: "production" })).toBe(join(homedir(), ".inbot"));
  expect(resolveHome({ flavor: "development" })).toBe(join(homedir(), ".inbot-dev"));
  expect(resolveHome({ flag: "relative-home", flavor: "development" })).toBe(
    resolve("relative-home"),
  );
});

test("creates a private home and tightens existing directory permissions", async ({ home }) => {
  const nested = join(home, "private");
  await Effect.runPromise(
    Home.pipe(Effect.provide(Home.layer({ flag: nested, flavor: "development" }))),
  );
  expect((await stat(nested)).isDirectory()).toBe(true);
  if (process.platform !== "win32") {
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
    await chmod(nested, 0o755);
    await Effect.runPromise(
      Home.pipe(Effect.provide(Home.layer({ flag: nested, flavor: "development" }))),
    );
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
  }
});

test("reopens persisted data with a fresh keychain-unlocked service", async ({
  home,
  keychain,
}) => {
  const dek = await Effect.runPromise(
    withKeys(home, keychain, (keys) => keys.initialize({ useKeychain: true })),
  );
  await writeMeta(home, dek);
  const reopened = await Effect.runPromise(
    withKeys(home, keychain, (keys) => keys.unlockWithKeychain()),
  );
  expect(reopened).toEqual(dek);
  expect(await readMeta(home, reopened)).toEqual({ value: plaintext });
});

test("rejects a wrong passphrase and reopens with the correct passphrase", async ({
  home,
  keychain,
}) => {
  const dek = await Effect.runPromise(
    withKeys(home, keychain, (keys) =>
      keys.initialize({ useKeychain: false, passphrase: "synthetic-passphrase" }),
    ),
  );
  await writeMeta(home, dek);
  const failure = await Effect.runPromise(
    withKeys(home, keychain, (keys) => Effect.flip(keys.unlockWithPassphrase("wrong-passphrase"))),
  );
  expect(failure).toBeInstanceOf(InvalidPassphrase);
  const reopened = await Effect.runPromise(
    withKeys(home, keychain, (keys) => keys.unlockWithPassphrase("synthetic-passphrase")),
  );
  expect(await readMeta(home, reopened)).toEqual({ value: plaintext });
});

test("switches from keychain to passphrase without rewriting the database", async ({
  home,
  keychain,
}) => {
  const dek = await Effect.runPromise(
    withKeys(home, keychain, (keys) => keys.initialize({ useKeychain: true })),
  );
  await writeMeta(home, dek);
  const before = await databaseHash(home);
  await Effect.runPromise(
    withKeys(home, keychain, (keys) =>
      Effect.gen(function* () {
        yield* keys.unlockWithKeychain();
        yield* keys.enablePassphrase("new-passphrase");
        yield* keys.disableKeychain();
        expect(yield* keys.status()).toEqual({
          initialized: true,
          keychain: false,
          passphrase: true,
        });
      }),
    ),
  );
  expect(await databaseHash(home)).toBe(before);
  const credential = await Effect.runPromise(
    KeychainStore.use((store) => store.get(keychainService, keychainAccount(home))).pipe(
      Effect.provide(keychain),
    ),
  );
  expect(credential).toBeUndefined();
  const reopened = await Effect.runPromise(
    withKeys(home, keychain, (keys) => keys.unlockWithPassphrase("new-passphrase")),
  );
  expect(await readMeta(home, reopened)).toEqual({ value: plaintext });
});

test("switches from passphrase to keychain and can replace a passphrase", async ({
  home,
  keychain,
}) => {
  const dek = await Effect.runPromise(
    withKeys(home, keychain, (keys) =>
      keys.initialize({ useKeychain: false, passphrase: "original" }),
    ),
  );
  await writeMeta(home, dek);
  const before = await databaseHash(home);
  await Effect.runPromise(
    withKeys(home, keychain, (keys) =>
      Effect.gen(function* () {
        yield* keys.unlockWithPassphrase("original");
        yield* keys.enablePassphrase("replacement");
        expect(yield* Effect.flip(keys.unlockWithPassphrase("original"))).toBeInstanceOf(
          InvalidPassphrase,
        );
        yield* keys.unlockWithPassphrase("replacement");
        yield* keys.enableKeychain();
        yield* keys.disablePassphrase();
        expect(yield* keys.status()).toEqual({
          initialized: true,
          keychain: true,
          passphrase: false,
        });
      }),
    ),
  );
  expect(await databaseHash(home)).toBe(before);
  const reopened = await Effect.runPromise(
    withKeys(home, keychain, (keys) => keys.unlockWithKeychain()),
  );
  expect(await readMeta(home, reopened)).toEqual({ value: plaintext });
});

for (const method of ["keychain", "passphrase"]) {
  test(`refuses to remove the last ${method} unlock method`, async ({ home, keychain }) => {
    await Effect.runPromise(
      withKeys(home, keychain, (keys) =>
        Effect.gen(function* () {
          yield* keys.initialize(
            method === "keychain"
              ? { useKeychain: true }
              : { useKeychain: false, passphrase: "synthetic" },
          );
          const before = yield* keys.status();
          const error = yield* Effect.flip(
            method === "keychain" ? keys.disableKeychain() : keys.disablePassphrase(),
          );
          expect(error).toBeInstanceOf(KeyStateError);
          expect(error.code).toBe("last_unlock_method");
          expect(yield* keys.status()).toEqual(before);
        }),
      ),
    );
  });
}

test("initializes both unlock methods with the same data key", async ({ home, keychain }) => {
  const initialized = await Effect.runPromise(
    withKeys(home, keychain, (keys) =>
      keys.initialize({ useKeychain: true, passphrase: "synthetic" }),
    ),
  );
  const fromKeychain = await Effect.runPromise(
    withKeys(home, keychain, (keys) => keys.unlockWithKeychain()),
  );
  const fromPassphrase = await Effect.runPromise(
    withKeys(home, keychain, (keys) => keys.unlockWithPassphrase("synthetic")),
  );
  expect(fromKeychain).toEqual(initialized);
  expect(fromPassphrase).toEqual(initialized);
});

test("stores no plaintext secrets in a private keys file and refuses reinitialization", async ({
  home,
  keychain,
}) => {
  const dek = await Effect.runPromise(
    withKeys(home, keychain, (keys) =>
      keys.initialize({ useKeychain: true, passphrase: "synthetic-private-passphrase" }),
    ),
  );
  const path = join(home, "keys.json");
  const json = await readFile(path, "utf8");
  const kek = await Effect.runPromise(
    KeychainStore.use((store) => store.get(keychainService, keychainAccount(home))).pipe(
      Effect.provide(keychain),
    ),
  );
  expect(kek).toBeDefined();
  expect(json).not.toContain(kek);
  expect(json).not.toContain(dek.toString("hex"));
  expect(json).not.toContain("synthetic-private-passphrase");
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  const failure = await Effect.runPromise(
    withKeys(home, keychain, (keys) => Effect.flip(keys.initialize({ useKeychain: true }))),
  );
  expect(failure.code).toBe("already_initialized");
  expect(await readFile(path, "utf8")).toBe(json);
  expect((await readdir(home)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("refuses to replace keys missing from an existing database", async ({ home, keychain }) => {
  const dek = await Effect.runPromise(
    withKeys(home, keychain, (keys) => keys.initialize({ useKeychain: true })),
  );
  await writeMeta(home, dek);
  await rm(join(home, "keys.json"));
  const failure = await Effect.runPromise(
    withKeys(home, keychain, (keys) => Effect.flip(keys.initialize({ useKeychain: true }))),
  );
  expect(failure.code).toBe("already_initialized");
  expect(await readMeta(home, dek)).toEqual({ value: plaintext });
});

test("requires an unlock method and rejects empty passphrases", async ({ home, keychain }) => {
  await Effect.runPromise(
    withKeys(home, keychain, (keys) =>
      Effect.gen(function* () {
        expect(yield* keys.status()).toEqual({
          initialized: false,
          keychain: false,
          passphrase: false,
        });
        expect((yield* Effect.flip(keys.initialize({ useKeychain: false }))).code).toBe(
          "invalid_configuration",
        );
        expect(
          (yield* Effect.flip(keys.initialize({ useKeychain: false, passphrase: "" }))).code,
        ).toBe("invalid_configuration");
        yield* keys.initialize({ useKeychain: true });
        expect((yield* Effect.flip(keys.enablePassphrase(""))).code).toBe("invalid_configuration");
      }),
    ),
  );
});

test("requires an unlocked service before changing methods and supports locking again", async ({
  home,
  keychain,
}) => {
  await Effect.runPromise(
    withKeys(home, keychain, (keys) => keys.initialize({ useKeychain: true })),
  );
  await Effect.runPromise(
    withKeys(home, keychain, (keys) =>
      Effect.gen(function* () {
        expect((yield* Effect.flip(keys.enablePassphrase("synthetic"))).code).toBe("locked");
        yield* keys.unlockWithKeychain();
        yield* keys.lock();
        expect((yield* Effect.flip(keys.enablePassphrase("synthetic"))).code).toBe("locked");
        yield* keys.unlockWithKeychain();
        yield* keys.enablePassphrase("synthetic");
      }),
    ),
  );
});

test("reports a missing keychain credential and can restore it after passphrase unlock", async ({
  home,
  keychain,
}) => {
  const dek = await Effect.runPromise(
    withKeys(home, keychain, (keys) =>
      keys.initialize({ useKeychain: true, passphrase: "synthetic" }),
    ),
  );
  await Effect.runPromise(
    KeychainStore.use((store) => store.delete(keychainService, keychainAccount(home))).pipe(
      Effect.provide(keychain),
    ),
  );
  const failure = await Effect.runPromise(
    withKeys(home, keychain, (keys) => Effect.flip(keys.unlockWithKeychain())),
  );
  expect(failure).toBeInstanceOf(KeychainEntryMissing);
  await Effect.runPromise(
    withKeys(home, keychain, (keys) =>
      Effect.gen(function* () {
        yield* keys.unlockWithPassphrase("synthetic");
        yield* keys.enableKeychain();
      }),
    ),
  );
  const restored = await Effect.runPromise(
    withKeys(home, keychain, (keys) => keys.unlockWithKeychain()),
  );
  expect(restored).toEqual(dek);
});

test("reports corrupt JSON and unsupported key file versions without overwriting them", async ({
  home,
  keychain,
}) => {
  const path = join(home, "keys.json");
  for (const json of [
    "{invalid",
    '{"version":2}',
    '{"version":1}',
    '{"version":1,"keychain":{"nonce":"invalid"}}',
  ]) {
    await writeFile(path, json);
    const failure = await Effect.runPromise(
      withKeys(home, keychain, (keys) => Effect.flip(keys.status())),
    );
    expect(failure).toBeInstanceOf(KeysFileCorrupt);
    const initializeFailure = await Effect.runPromise(
      withKeys(home, keychain, (keys) => Effect.flip(keys.initialize({ useKeychain: true }))),
    );
    expect(initializeFailure).toBeInstanceOf(KeysFileCorrupt);
    expect(await readFile(path, "utf8")).toBe(json);
  }
});

test("keeps homes isolated even when they share a credential store", async ({ home, keychain }) => {
  const otherHome = join(home, "second-home");
  const first = await Effect.runPromise(
    withKeys(home, keychain, (keys) => keys.initialize({ useKeychain: true })),
  );
  const second = await Effect.runPromise(
    withKeys(otherHome, keychain, (keys) => keys.initialize({ useKeychain: true })),
  );
  expect(second).not.toEqual(first);
  expect(
    await Effect.runPromise(withKeys(home, keychain, (keys) => keys.unlockWithKeychain())),
  ).toEqual(first);
  expect(
    await Effect.runPromise(withKeys(otherHome, keychain, (keys) => keys.unlockWithKeychain())),
  ).toEqual(second);
});

test("serializes concurrent unlock method changes without losing a method", async ({
  home,
  keychain,
}) => {
  await Effect.runPromise(
    withKeys(home, keychain, (keys) =>
      Effect.gen(function* () {
        yield* keys.initialize({ useKeychain: false, passphrase: "original" });
        yield* Effect.all([keys.enableKeychain(), keys.enablePassphrase("replacement")], {
          concurrency: "unbounded",
        });
        expect(yield* keys.status()).toEqual({
          initialized: true,
          keychain: true,
          passphrase: true,
        });
        expect(yield* keys.unlockWithKeychain()).toEqual(
          yield* keys.unlockWithPassphrase("replacement"),
        );
      }),
    ),
  );
});

test("encrypts database and WAL bytes and enables foreign keys", async ({ home, keychain }) => {
  const dek = await Effect.runPromise(
    withKeys(home, keychain, (keys) => keys.initialize({ useKeychain: true })),
  );
  await Effect.runPromise(
    withStore(home, dek, (store) =>
      Effect.gen(function* () {
        yield* store.use((database) => {
          expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
          expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
          expect(database.pragma("temp_store", { simple: true })).toBe(2);
          database.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("test", plaintext);
        });
        const wal = yield* Effect.promise(() => readFile(join(home, "inbot.db-wal")));
        expect(wal.byteLength).toBeGreaterThan(0);
        expect(wal.includes(Buffer.from(plaintext))).toBe(false);
        yield* store.use((database) => {
          database.pragma("wal_checkpoint(TRUNCATE)");
        });
      }),
    ),
  );
  const bytes = await readFile(join(home, "inbot.db"));
  expect(bytes.subarray(0, 15).toString()).not.toBe("SQLite format 3");
  expect(bytes.includes(Buffer.from(plaintext))).toBe(false);
  expect(await readMeta(home, dek)).toEqual({ value: plaintext });
});

test("rejects a different database key without damaging persisted data", async ({
  home,
  keychain,
}) => {
  const dek = await Effect.runPromise(
    withKeys(home, keychain, (keys) => keys.initialize({ useKeychain: true })),
  );
  await writeMeta(home, dek);
  const before = await databaseHash(home);
  const failure = await Effect.runPromise(
    Effect.flip(withStore(home, randomBytes(32), (store) => store.use(() => undefined))),
  );
  expect(failure).toBeInstanceOf(DatabaseKeyInvalid);
  expect(await databaseHash(home)).toBe(before);
  expect(await readMeta(home, dek)).toEqual({ value: plaintext });
});

test("runs FTS5 MATCH queries inside the encrypted database", async ({ home, keychain }) => {
  const dek = await Effect.runPromise(
    withKeys(home, keychain, (keys) => keys.initialize({ useKeychain: true })),
  );
  const row = await Effect.runPromise(
    withStore(home, dek, (store) =>
      store.use((database) => {
        database.exec("CREATE VIRTUAL TABLE search_probe USING fts5(body)");
        database
          .prepare("INSERT INTO search_probe (body) VALUES (?)")
          .run("searchable synthetic mail");
        return database
          .prepare("SELECT body FROM search_probe WHERE search_probe MATCH ?")
          .get("searchable");
      }),
    ),
  );
  expect(row).toEqual({ body: "searchable synthetic mail" });
});

test("advances migrations transactionally and repeated migrations preserve data", async ({
  home,
  keychain,
}) => {
  const dek = await Effect.runPromise(
    withKeys(home, keychain, (keys) => keys.initialize({ useKeychain: true })),
  );
  await Effect.runPromise(
    withStore(home, dek, (store) =>
      Effect.gen(function* () {
        const database = yield* store.use((connection) => connection);
        expect(database.pragma("user_version", { simple: true })).toBe(migrations.length);
        const ordered = [
          ...migrations,
          {
            version: migrations.length + 1,
            sql: "CREATE TABLE migration_probe (value TEXT NOT NULL)",
          },
        ];
        yield* migrate(database, ordered);
        expect(database.pragma("user_version", { simple: true })).toBe(migrations.length + 1);
        database.prepare("INSERT INTO migration_probe (value) VALUES (?)").run("keep-me");
        yield* migrate(database, ordered);
        expect(database.prepare("SELECT value FROM migration_probe").all()).toEqual([
          { value: "keep-me" },
        ]);
      }),
    ),
  );
});

test("rolls back a failed migration batch including its schema version", async ({
  home,
  keychain,
}) => {
  const dek = await Effect.runPromise(
    withKeys(home, keychain, (keys) => keys.initialize({ useKeychain: true })),
  );
  await Effect.runPromise(
    withStore(home, dek, (store) =>
      Effect.gen(function* () {
        const database = yield* store.use((connection) => connection);
        const failure = yield* Effect.flip(
          migrate(database, [
            ...migrations,
            { version: migrations.length + 1, sql: "CREATE TABLE rolled_back (value TEXT)" },
            { version: migrations.length + 2, sql: "INVALID SQL" },
          ]),
        );
        expect(failure).toBeInstanceOf(DatabaseError);
        expect(database.pragma("user_version", { simple: true })).toBe(migrations.length);
        expect(
          database.prepare("SELECT name FROM sqlite_master WHERE name = ?").all("rolled_back"),
        ).toEqual([]);
      }),
    ),
  );
});

test("refuses a database from a newer schema version", async ({ home, keychain }) => {
  const dek = await Effect.runPromise(
    withKeys(home, keychain, (keys) => keys.initialize({ useKeychain: true })),
  );
  await Effect.runPromise(
    withStore(home, dek, (store) =>
      store.use((database) => {
        database.pragma(`user_version = ${migrations.length + 1}`);
      }),
    ),
  );
  const failure = await Effect.runPromise(
    Effect.flip(withStore(home, dek, (store) => store.use(() => undefined))),
  );
  expect(failure).toBeInstanceOf(DatabaseError);
  expect(failure).toMatchObject({ operation: "migrate" });
});

test("closes the database when the layer scope is released", async ({ home, keychain }) => {
  const dek = await Effect.runPromise(
    withKeys(home, keychain, (keys) => keys.initialize({ useKeychain: true })),
  );
  const database = await Effect.runPromise(
    withStore(home, dek, (store) => store.use((connection) => connection)),
  );
  expect(database.open).toBe(false);
});
