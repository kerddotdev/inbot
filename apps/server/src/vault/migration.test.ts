import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";
import { migrate, migrations } from "../store.js";

test("migrates v19 vault settings and every use request state without losing rows or indexes", async () => {
  const home = await mkdtemp(join(tmpdir(), "inbot-v19-migration-"));
  const db = new Database(join(home, "inbot.db"));
  try {
    db.pragma(`key = "x'${"12".repeat(32)}'"`);
    db.pragma("foreign_keys = ON");
    Effect.runSync(
      migrate(
        db,
        migrations.filter((migration) => migration.version <= 19),
      ),
    );
    expect(db.pragma("user_version", { simple: true })).toBe(19);
    db.prepare("INSERT INTO vault_settings (id, remote_cdp_hosts) VALUES (1, ?)").run(
      '["browser.test"]',
    );
    const insert = db.prepare(`INSERT INTO credential_use_requests
      (request_id, api_key_id, inbox_id, kind, credential_ids, fields, origin, idempotency_key,
       fingerprint, state, created_at, decided_at, expires_at, consumed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [index, state] of ["pending", "approved", "rejected", "consumed"].entries())
      insert.run(
        String(index).repeat(32),
        "a".repeat(32),
        "agent@example.test",
        index % 2 ? "run" : "fill",
        '["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]',
        '{"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb":["password"]}',
        "https://example.test/login",
        `key-${index}`,
        `fingerprint-${index}`,
        state,
        "2026-10-10T12:00:00Z",
        state === "pending" ? null : "2026-10-10T12:01:00Z",
        "2026-10-11T12:00:00Z",
        state === "consumed" ? "2026-10-10T12:02:00Z" : null,
      );
    db.exec("CREATE INDEX credential_use_state_probe ON credential_use_requests (state)");
    const rows = Schema.decodeUnknownSync(
      Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
    )(db.prepare("SELECT * FROM credential_use_requests ORDER BY request_id").all());
    const indexes = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'credential_use_requests' ORDER BY name",
      )
      .all();
    Effect.runSync(migrate(db));
    expect(db.pragma("user_version", { simple: true })).toBe(20);
    expect(db.prepare("SELECT * FROM credential_use_requests ORDER BY request_id").all()).toEqual(
      rows.map((row) => ({ ...row, browser: null })),
    );
    expect(db.prepare("SELECT * FROM vault_settings").get()).toEqual({
      id: 1,
      remote_cdp_hosts: '["browser.test"]',
      cdp_endpoints: "[]",
    });
    expect(
      db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'credential_use_requests' ORDER BY name",
        )
        .all(),
    ).toEqual(indexes);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(() =>
      db
        .prepare(
          "UPDATE credential_use_requests SET idempotency_key = 'key-0' WHERE request_id = ?",
        )
        .run("1".repeat(32)),
    ).toThrow();
    const browser = JSON.stringify({ endpoint: "http://127.0.0.1:9222", selector: "#password" });
    db.prepare(
      "UPDATE credential_use_requests SET kind = 'capture', browser = ? WHERE request_id = ?",
    ).run(browser, "0".repeat(32));
    db.prepare("UPDATE vault_settings SET cdp_endpoints = ?").run('["http://127.0.0.1:9222"]');
    expect(() => db.prepare("UPDATE credential_use_requests SET kind = 'invalid'").run()).toThrow();
    const migrated = db.prepare("SELECT * FROM credential_use_requests ORDER BY request_id").all();
    Effect.runSync(migrate(db));
    db.pragma("user_version = 19");
    Effect.runSync(migrate(db));
    expect(db.prepare("SELECT * FROM credential_use_requests ORDER BY request_id").all()).toEqual(
      migrated,
    );
    expect(db.prepare("SELECT cdp_endpoints FROM vault_settings").get()).toEqual({
      cdp_endpoints: '["http://127.0.0.1:9222"]',
    });
  } finally {
    db.close();
    await rm(home, { recursive: true, force: true });
  }
});
