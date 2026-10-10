import {
  argon2,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { Store, type StoreService } from "../store.js";
import { wireError } from "../http/errors.js";

const slidingLifetime = 14 * 24 * 60 * 60_000;
const absoluteLifetime = 30 * 24 * 60 * 60_000;
const digest = (value: string) => createHash("sha256").update(value).digest();
const csrf = (token: string) =>
  createHmac("sha256", token).update("inbot-csrf").digest("base64url");
const Account = Schema.Struct({ password_hash: Schema.String });
const SessionRow = Schema.Struct({
  id: Schema.String,
  created_at: Schema.String,
  last_seen_at: Schema.String,
  expires_at: Schema.String,
  user_agent: Schema.String,
  revoked: Schema.Int,
});
const PasswordHash = Schema.Struct({ salt: Schema.String, hash: Schema.String });
const PasswordJson = Schema.fromJsonString(PasswordHash);
const unauthorized = () =>
  wireError(
    "unauthorized",
    "The credentials are invalid or expired.",
    "Sign in again with valid owner credentials.",
  );
const throttled = () =>
  wireError(
    "rate_limit_exceeded",
    "Owner password verification is temporarily limited.",
    "Wait before trying again.",
  );

function derive(password: string, salt: string) {
  return Effect.tryPromise({
    try: () =>
      new Promise<Buffer>((resolve, reject) => {
        argon2(
          "argon2id",
          {
            message: password,
            nonce: Buffer.from(salt, "hex"),
            memory: 19456,
            passes: 2,
            parallelism: 1,
            tagLength: 32,
          },
          (error, key) => (error ? reject(error) : resolve(key)),
        );
      }),
    catch: () =>
      wireError(
        "service_unavailable",
        "Password verification failed.",
        "Retry when the service is available.",
      ),
  });
}
function hashPassword(password: string) {
  return Effect.gen(function* () {
    const salt = randomBytes(16).toString("hex");
    const key = yield* derive(password, salt);
    try {
      return JSON.stringify({ salt, hash: key.toString("hex") });
    } finally {
      key.fill(0);
    }
  });
}
function verifyPassword(password: string, stored: string) {
  return Effect.gen(function* () {
    const value = yield* Schema.decodeUnknownEffect(PasswordJson)(stored);
    const key = yield* derive(password, value.salt);
    try {
      return timingSafeEqual(key, Buffer.from(value.hash, "hex"));
    } finally {
      key.fill(0);
    }
  });
}

function makeSessions(store: StoreService, dummyHash: string, setupDigest: Buffer) {
  let failures = 0;
  let retryAt = 0;
  let verifying = false;
  const links = new Map<string, number>();
  const account = () =>
    store.use((db) =>
      Schema.decodeUnknownSync(Schema.optional(Account))(
        db.prepare("SELECT password_hash FROM owner_account WHERE id = 1").get(),
      ),
    );
  const sessionData = (userAgent: string, now: number) => {
    const token = randomBytes(32).toString("base64url");
    const row = {
      id: randomUUID(),
      created_at: new Date(now).toISOString(),
      last_seen_at: new Date(now).toISOString(),
      expires_at: new Date(now + slidingLifetime).toISOString(),
      user_agent: digest(userAgent).toString("hex"),
      revoked: 0,
    };
    return { token, row, csrf_token: csrf(token), expires_at: row.expires_at };
  };
  const insertSession = (db: Database.Database, session: ReturnType<typeof sessionData>) => {
    db.prepare(
      "INSERT INTO owner_sessions (id, token_hash, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      session.row.id,
      digest(session.token),
      session.row.created_at,
      session.row.last_seen_at,
      session.row.expires_at,
      session.row.user_agent,
    );
  };
  const checkPassword = (password: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (verifying || now < retryAt) return yield* Effect.fail(throttled());
      verifying = true;
      return yield* Effect.gen(function* () {
        const owner = yield* account();
        const matches = yield* verifyPassword(password, owner?.password_hash ?? dummyHash);
        if (!matches || owner === undefined) {
          failures = Math.min(failures + 1, 7);
          retryAt = (yield* Clock.currentTimeMillis) + Math.min(60_000, 1000 * 2 ** (failures - 1));
          return yield* Effect.fail(unauthorized());
        }
        failures = 0;
        retryAt = 0;
        return owner.password_hash;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            verifying = false;
          }),
        ),
      );
    });
  return {
    setupRequired: () => account().pipe(Effect.map((owner) => owner === undefined)),
    setup: (password: string, code: string, userAgent: string) =>
      Effect.gen(function* () {
        if (!(yield* account()) && timingSafeEqual(digest(code), setupDigest)) {
          const passwordHash = yield* hashPassword(password);
          const session = sessionData(userAgent, yield* Clock.currentTimeMillis);
          const created = yield* store.use((db) =>
            db
              .transaction(() => {
                const result = db
                  .prepare(
                    "INSERT OR IGNORE INTO owner_account (id, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?)",
                  )
                  .run(passwordHash, session.row.created_at, session.row.created_at);
                if (result.changes !== 1) return false;
                insertSession(db, session);
                return true;
              })
              .immediate(),
          );
          if (!created)
            return yield* Effect.fail(
              wireError(
                "already_exists",
                "The owner account is already configured.",
                "Sign in with the existing password.",
              ),
            );
          setupDigest.fill(0);
          return session;
        }
        if (yield* account())
          return yield* Effect.fail(
            wireError(
              "already_exists",
              "The owner account is already configured.",
              "Sign in with the existing password.",
            ),
          );
        return yield* Effect.fail(unauthorized());
      }),
    login: (password: string, userAgent: string) =>
      Effect.gen(function* () {
        const checkedHash = yield* checkPassword(password);
        const session = sessionData(userAgent, yield* Clock.currentTimeMillis);
        const created = yield* store.use((db) =>
          db
            .transaction(() => {
              const owner = Schema.decodeUnknownSync(Account)(
                db.prepare("SELECT password_hash FROM owner_account WHERE id = 1").get(),
              );
              if (owner.password_hash !== checkedHash) return false;
              insertSession(db, session);
              return true;
            })
            .immediate(),
        );
        if (!created) return yield* Effect.fail(unauthorized());
        return session;
      }),
    authenticate: (token: string) =>
      Effect.gen(function* () {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
        const now = yield* Clock.currentTimeMillis;
        return yield* store.use((db) => {
          const row = Schema.decodeUnknownSync(Schema.optional(SessionRow))(
            db
              .prepare(
                "SELECT id, created_at, last_seen_at, expires_at, user_agent, revoked FROM owner_sessions WHERE token_hash = ?",
              )
              .get(digest(token)),
          );
          if (
            row === undefined ||
            row.revoked !== 0 ||
            Date.parse(row.expires_at) <= now ||
            Date.parse(row.created_at) + absoluteLifetime <= now
          )
            return undefined;
          const expires_at = new Date(
            Math.min(now + slidingLifetime, Date.parse(row.created_at) + absoluteLifetime),
          ).toISOString();
          db.prepare("UPDATE owner_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(
            new Date(now).toISOString(),
            expires_at,
            row.id,
          );
          return { id: row.id, csrf_token: csrf(token), expires_at, token };
        });
      }),
    list: (currentId?: string) =>
      store.use((db) => ({
        sessions: Schema.decodeUnknownSync(Schema.Array(SessionRow))(
          db
            .prepare(
              "SELECT id, created_at, last_seen_at, expires_at, user_agent, revoked FROM owner_sessions ORDER BY created_at DESC",
            )
            .all(),
        ).map((row) => ({ ...row, revoked: row.revoked !== 0, current: row.id === currentId })),
      })),
    revoke: (id: string) =>
      store
        .use((db) => db.prepare("UPDATE owner_sessions SET revoked = 1 WHERE id = ?").run(id))
        .pipe(Effect.asVoid),
    changePassword: (current: string, password: string, sessionId?: string) =>
      Effect.gen(function* () {
        const checkedHash = yield* checkPassword(current);
        const nextHash = yield* hashPassword(password);
        const now = new Date(yield* Clock.currentTimeMillis).toISOString();
        const changed = yield* store.use((db) =>
          db
            .transaction(() => {
              const result = db
                .prepare(
                  "UPDATE owner_account SET password_hash = ?, updated_at = ? WHERE id = 1 AND password_hash = ?",
                )
                .run(nextHash, now, checkedHash);
              if (result.changes !== 1) return false;
              db.prepare("UPDATE owner_sessions SET revoked = 1 WHERE id != ?").run(
                sessionId ?? "",
              );
              return true;
            })
            .immediate(),
        );
        if (!changed) return yield* Effect.fail(unauthorized());
        links.clear();
      }),
    createLink: (origin: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        for (const [token, expires] of links) if (expires <= now) links.delete(token);
        if (links.size >= 64) return yield* Effect.fail(throttled());
        const token = randomBytes(32).toString("base64url");
        links.set(digest(token).toString("hex"), now + 120_000);
        return { url: `${origin}/login?token=${token}` };
      }),
    redeem: (token: string, userAgent: string) =>
      Effect.gen(function* () {
        const key = digest(token).toString("hex");
        const expires = links.get(key);
        links.delete(key);
        if (expires === undefined || expires <= (yield* Clock.currentTimeMillis))
          return yield* Effect.fail(unauthorized());
        const session = sessionData(userAgent, yield* Clock.currentTimeMillis);
        yield* store.use((db) => insertSession(db, session));
        return session;
      }),
  };
}

export class OwnerSessions extends Context.Service<
  OwnerSessions,
  ReturnType<typeof makeSessions>
>()("inbot/OwnerSessions") {
  static layer(setupRequired?: (code: string) => void) {
    return Layer.effect(
      OwnerSessions,
      Effect.gen(function* () {
        const store = yield* Store;
        const dummyHash = yield* hashPassword(randomBytes(32).toString("hex"));
        const code = randomBytes(24).toString("base64url");
        const setupDigest = digest(code);
        yield* Effect.addFinalizer(() => Effect.sync(() => setupDigest.fill(0)));
        const sessions = makeSessions(store, dummyHash, setupDigest);
        if (yield* sessions.setupRequired()) yield* Effect.sync(() => setupRequired?.(code));
        return sessions;
      }),
    );
  }
}
