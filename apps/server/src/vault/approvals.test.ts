import { CurrentPrincipal, type Principal } from "../../../../packages/contracts/src/security.js";
import { makeVault } from "./vault.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { expect, test as base } from "vitest";
import { ErrorResponse } from "../../../../packages/contracts/src/errors.js";
import {
  CredentialUseRequest,
  ListCredentialUseRequestsResponse,
} from "../../../../packages/contracts/src/credential-use.js";
import {
  Credential,
  ResolveCredentialsResponse,
} from "../../../../packages/contracts/src/vault.js";
import { decrypt, generateIdentity } from "../../../../packages/envelope/src/crypto.js";
import { readEvents, eventVisible } from "../events/log.js";
import { fixture } from "../http/test-fixture.js";
import { client } from "../mcp/test-client.js";
import { migrate } from "../store.js";
import { fakeCdp } from "./cdp-test-server.js";

const inboxId = "agent@example.test";
const secret = "approval-test-secret";
const test = base.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-use-approval-"));
    const api = await fixture(home);
    try {
      await use(api);
    } finally {
      await api.close();
      await rm(home, { recursive: true, force: true });
    }
  },
});
type Api = Awaited<ReturnType<typeof fixture>>;

async function setup(api: Api, usePolicy?: "approval" | "direct") {
  const credential = Schema.decodeUnknownSync(Credential)(
    await (
      await api.request(`/v0/inboxes/${inboxId}/credentials`, {
        method: "POST",
        body: {
          name: "Approval account",
          url: "https://example.test",
          fields: { password: secret, api_key: "second-test-value" },
        },
      })
    ).json(),
  );
  const key = await api.run(
    api.keys.create({
      name: "Approval agent",
      inbox_ids: [inboxId],
      send_policy: "read_only",
      permissions: { credential_fill: true, credential_run: true },
      ...(usePolicy === undefined ? {} : { use_policy: usePolicy }),
    }),
  );
  const identity = await generateIdentity();
  const ref = credential.refs.password;
  if (ref === undefined) throw new Error("Expected password ref");
  return {
    credential,
    key,
    identity,
    resolve: { refs: [ref], public_key: identity.recipient },
  };
}
async function requests(api: Api, query = "") {
  return Schema.decodeUnknownSync(ListCredentialUseRequestsResponse)(
    await (await api.request(`/v0/credential-use-requests${query}`)).json(),
  );
}
async function first(api: Api) {
  const row = (await requests(api)).requests[0];
  if (row === undefined) throw new Error("Expected use request");
  return row;
}
async function decision(api: Api, id: string, choice: "approve" | "reject") {
  const response = await api.request(`/v0/credential-use-requests/${id}/${choice}`, {
    method: "POST",
  });
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(CredentialUseRequest)(await response.json());
}
async function error(response: Response, code: string) {
  const wire = Schema.decodeUnknownSync(ErrorResponse)(await response.json());
  expect(wire).toMatchObject({ code, fix: expect.any(String) });
  expect(JSON.stringify(wire)).not.toContain(secret);
  return wire;
}

for (const kind of ["fill", "run"] as const) {
  test(`${kind} requests approval before use, deduplicates, binds the intent and consumes exactly once`, async ({
    api,
  }) => {
    const account = await setup(api);
    const browser = await fakeCdp();
    const path =
      kind === "fill"
        ? `/v0/inboxes/${inboxId}/credentials/${account.credential.credential_id}/fill`
        : "/v0/credentials/resolve";
    const body =
      kind === "fill"
        ? {
            cdp_endpoint: browser.endpoint,
            selector: "#password",
            field: "password",
            url: "https://example.test/login",
          }
        : account.resolve;
    const use = (key?: string, input: unknown = body) =>
      api.request(path, {
        token: account.key.api_key,
        method: "POST",
        body: input,
        ...(key === undefined ? {} : { headers: { "idempotency-key": key } }),
      });
    try {
      expect(account.key.use_policy).toBe("approval");
      await error(await use(), "validation_error");
      expect((await requests(api)).count).toBe(0);
      const pending = await error(await use("use-once"), "approval_required");
      const row = await first(api);
      expect(row).toMatchObject({
        kind,
        state: "pending",
        api_key_name: "Approval agent",
        credentials: [{ name: "Approval account", fields: ["password"] }],
      });
      expect(row.url_hint).toBe(kind === "fill" ? "https://example.test/login" : undefined);
      expect(pending.fix).toContain(row.request_id);
      expect(pending.fix).toContain("same idempotency key");
      await error(await use("use-once"), "approval_required");
      expect((await requests(api)).count).toBe(1);
      await error(
        await use(
          "use-once",
          kind === "fill"
            ? { ...body, selector: "#other" }
            : { ...account.resolve, refs: [account.credential.refs.api_key] },
        ),
        "idempotency_conflict",
      );
      expect(browser.requests).toEqual([]);
      expect(browser.connections).toEqual([]);
      expect(
        (await api.run(api.store.use((db) => readEvents(db, 0)))).filter(
          (row) => row.event_type === "credential.used",
        ),
      ).toEqual([]);
      for (const action of ["approve", "reject"])
        await error(
          await api.request(`/v0/credential-use-requests/${row.request_id}/${action}`, {
            method: "POST",
            token: account.key.api_key,
          }),
          "missing_permission",
        );
      await error(
        await api.request("/v0/credential-use-requests", { token: account.key.api_key }),
        "missing_permission",
      );
      const approved = await decision(api, row.request_id, "approve");
      expect(await decision(api, row.request_id, "approve")).toEqual(approved);
      expect(Date.parse(approved.expires_at) - Date.parse(approved.decided_at ?? "")).toBe(
        15 * 60_000,
      );
      await error(
        await api.request(`/v0/credential-use-requests/${row.request_id}/reject`, {
          method: "POST",
        }),
        "validation_error",
      );
      const results = await Promise.all([use("use-once"), use("use-once")]);
      expect(results.map((response) => response.status).sort()).toEqual([200, 403]);
      const success = results.find((response) => response.ok);
      if (success === undefined) throw new Error("Expected approved success");
      if (kind === "run") {
        const wire = Schema.decodeUnknownSync(ResolveCredentialsResponse)(await success.json());
        expect(
          new TextDecoder().decode(
            await decrypt(account.identity.identity, Buffer.from(wire.ciphertext, "base64")),
          ),
        ).toBe(JSON.stringify({ values: { [account.credential.refs.password ?? ""]: secret } }));
      } else
        expect(
          browser.messages.filter((message) => message.method === "Input.insertText"),
        ).toHaveLength(1);
      expect((await first(api)).state).toBe("consumed");
      expect((await error(await use("use-once"), "approval_required")).fix).toContain(
        "new idempotency key",
      );
      await error(
        await api.request(`/v0/credential-use-requests/${row.request_id}/approve`, {
          method: "POST",
        }),
        "validation_error",
      );
      const events = (await api.run(api.store.use((db) => readEvents(db, 0)))).filter(
        (row) => "credential_use" in row.payload,
      );
      expect(events.map((row) => row.event_type)).toEqual([
        "credential.use_requested",
        "credential.use_approved",
      ]);
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(JSON.stringify(events)).not.toContain("use-once");
      const principal = await api.run(api.keys.authenticate(account.key.api_key));
      if (principal === undefined || principal.kind !== "agent") throw new Error("Expected agent");
      for (const event of events) {
        expect(eventVisible(event, principal)).toBe(false);
        expect(
          eventVisible(event, {
            ...principal,
            grant: { ...principal.grant, permissions: { credential_read: true } },
          }),
        ).toBe(true);
        expect(
          eventVisible(event, {
            ...principal,
            grant: {
              ...principal.grant,
              inbox_ids: ["other@example.test"],
              permissions: { credential_read: true },
            },
          }),
        ).toBe(false);
        expect(eventVisible(event, { kind: "owner" })).toBe(true);
        expect(event.payload).toMatchObject({
          credential_use: {
            request_id: row.request_id,
            inbox_id: inboxId,
            kind,
            credential_ids: [account.credential.credential_id],
            fields: ["password"],
          },
        });
      }
    } finally {
      await browser.close();
    }
  });

  test(`${kind} rejection and lazy pending/approved expiry never perform use`, async ({ api }) => {
    const account = await setup(api);
    const browser = await fakeCdp();
    const path =
      kind === "fill"
        ? `/v0/inboxes/${inboxId}/credentials/${account.credential.credential_id}/fill`
        : "/v0/credentials/resolve";
    const body =
      kind === "fill"
        ? { cdp_endpoint: browser.endpoint, selector: "#password", field: "password" }
        : account.resolve;
    const use = (key: string) =>
      api.request(path, {
        token: account.key.api_key,
        method: "POST",
        body,
        headers: { "idempotency-key": key },
      });
    try {
      await error(await use("reject"), "approval_required");
      const row = await first(api);
      const rejected = await decision(api, row.request_id, "reject");
      expect(await decision(api, row.request_id, "reject")).toEqual(rejected);
      expect((await error(await use("reject"), "missing_permission")).message).toBe(
        "The owner rejected this credential use.",
      );
      await error(await use("pending-expiry"), "approval_required");
      const pending = (await requests(api, "?state=pending")).requests[0];
      if (pending === undefined) throw new Error("Expected pending request");
      api.advance(24 * 60 * 60_000);
      expect((await error(await use("pending-expiry"), "approval_required")).fix).toContain(
        "new idempotency key",
      );
      await error(
        await api.request(`/v0/credential-use-requests/${pending.request_id}/approve`, {
          method: "POST",
        }),
        "validation_error",
      );
      await error(await use("approved-expiry"), "approval_required");
      const fresh = await first(api);
      await decision(api, fresh.request_id, "approve");
      api.advance(15 * 60_000);
      expect((await error(await use("approved-expiry"), "approval_required")).fix).toContain(
        "new idempotency key",
      );
      await error(
        await api.request(`/v0/credential-use-requests/${fresh.request_id}/approve`, {
          method: "POST",
        }),
        "validation_error",
      );
      expect(browser.requests).toEqual([]);
      expect((await requests(api, "?limit=1")).next_page_token).toBeDefined();
      const page = await requests(api, "?limit=1&ascending=true");
      const next = await requests(
        api,
        `?limit=1&ascending=true&page_token=${encodeURIComponent(page.next_page_token ?? "")}`,
      );
      expect(next.requests[0]?.request_id).not.toBe(page.requests[0]?.request_id);
      expect((await requests(api, "?state=rejected")).count).toBe(1);
      expect(
        (await api.run(api.store.use((db) => readEvents(db, 0)))).filter(
          (event) => event.event_type === "credential.use_rejected",
        ),
      ).toHaveLength(1);
    } finally {
      await browser.close();
    }
  });
}

test("failed approved fill remains retryable and MCP shares REST approval without owner tools", async ({
  api,
}) => {
  const account = await setup(api);
  const failure = { method: "Input.insertText", message: "synthetic failure" };
  const browser = await fakeCdp({ protocolError: failure });
  const mcp = await client(api, account.key.api_key);
  const args = {
    inboxId,
    credentialId: account.credential.credential_id,
    cdp_endpoint: browser.endpoint,
    selector: "#password",
    field: "password",
    idempotencyKey: "mcp-use",
  };
  try {
    expect(
      (await mcp.list()).tools.some((tool) => /use.requests|approve|reject/.test(tool.name)),
    ).toBe(false);
    expect((await mcp.call("fill_credential", args)).structuredContent).toMatchObject({
      code: "approval_required",
    });
    const row = await first(api);
    await decision(api, row.request_id, "approve");
    expect((await mcp.call("fill_credential", args)).structuredContent).toMatchObject({
      code: "service_unavailable",
    });
    expect((await first(api)).state).toBe("approved");
    failure.method = "never";
    expect((await mcp.call("fill_credential", args)).isError).not.toBe(true);
    expect((await first(api)).state).toBe("consumed");
    expect(
      browser.messages.filter((message) => message.method === "Input.insertText"),
    ).toHaveLength(2);
  } finally {
    await browser.close();
  }
});

test("owner and direct grants bypass approval and migrations preserve effective key policies", async ({
  api,
}) => {
  const account = await setup(api, "direct");
  const browser = await fakeCdp();
  try {
    const path = `/v0/inboxes/${inboxId}/credentials/${account.credential.credential_id}/fill`;
    const body = { cdp_endpoint: browser.endpoint, selector: "#password", field: "password" };
    for (const token of [account.key.api_key, api.token]) {
      expect((await api.request(path, { token, method: "POST", body })).status).toBe(200);
      expect(
        (
          await api.request("/v0/credentials/resolve", {
            token,
            method: "POST",
            body: account.resolve,
          })
        ).status,
      ).toBe(200);
    }
    expect((await requests(api)).count).toBe(0);
    await api.run(
      api.store.use((db) => {
        db.pragma("user_version = 17");
        Effect.runSync(migrate(db));
      }),
    );
    expect((await api.run(api.keys.get(account.key.api_key_id))).use_policy).toBe("direct");
    await api.run(
      api.store.use((db) => {
        db.exec("ALTER TABLE api_keys DROP COLUMN use_policy");
        db.pragma("user_version = 17");
        Effect.runSync(migrate(db));
      }),
    );
    const oldKey = await api.run(api.keys.get(account.key.api_key_id));
    expect(oldKey.use_policy).toBe("approval");
    expect(await (await api.request(`/v0/api-keys/${oldKey.api_key_id}`)).json()).toMatchObject({
      use_policy: "approval",
    });
    expect(
      (await api.run(api.keys.update(oldKey.api_key_id, { use_policy: "direct" }))).use_policy,
    ).toBe("direct");
    const principal = await api.run(api.keys.authenticate(account.key.api_key));
    if (principal?.kind !== "agent") throw new Error("Expected agent");
    expect(principal.grant.use_policy).toBe("direct");
  } finally {
    await browser.close();
  }
});

test("missing principal policy is safe, capture stays ungated and failed event writes roll back requests and decisions", async ({
  api,
}) => {
  const account = await setup(api);
  const vault = makeVault(api.store);
  const authenticated = await api.run(api.keys.authenticate(account.key.api_key));
  if (authenticated?.kind !== "agent") throw new Error("Expected agent");
  const { use_policy: _policy, ...grant } = authenticated.grant;
  const principal = { ...authenticated, grant };
  const browser = await fakeCdp({ value: "captured-without-approval" });
  const input = { cdp_endpoint: browser.endpoint, selector: "#password", field: "password" };
  const run = <A, E>(effect: Effect.Effect<A, E, CurrentPrincipal>) =>
    api.run(effect.pipe(Effect.provideService(CurrentPrincipal, principal)));
  try {
    expect(
      await run(Effect.result(vault.fill(account.credential.credential_id, input, inboxId))),
    ).toMatchObject({ failure: { code: "validation_error" } });
    expect(await run(Effect.result(vault.resolve(account.resolve)))).toMatchObject({
      failure: { code: "validation_error" },
    });
    expect(
      (await run(vault.capture(account.credential.credential_id, input, inboxId))).credential_id,
    ).toBe(account.credential.credential_id);
    expect((await requests(api)).count).toBe(0);
    await api.run(
      api.store.use((db) =>
        db.exec(
          "CREATE TRIGGER fail_use_event BEFORE INSERT ON event_log WHEN NEW.event_type = 'credential.use_requested' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
        ),
      ),
    );
    expect(
      await run(Effect.result(vault.resolve(account.resolve, "atomic-request"))),
    ).toMatchObject({ failure: { code: "database_failed" } });
    expect((await requests(api)).count).toBe(0);
    await api.run(api.store.use((db) => db.exec("DROP TRIGGER fail_use_event")));
    expect(
      await run(Effect.result(vault.resolve(account.resolve, "atomic-request"))),
    ).toMatchObject({ failure: { code: "approval_required" } });
    const row = await first(api);
    await api.run(
      api.store.use((db) =>
        db.exec(
          "CREATE TRIGGER fail_use_decision BEFORE INSERT ON event_log WHEN NEW.event_type = 'credential.use_approved' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
        ),
      ),
    );
    expect(
      (
        await api.request(`/v0/credential-use-requests/${row.request_id}/approve`, {
          method: "POST",
        })
      ).status,
    ).toBe(503);
    expect((await first(api)).state).toBe("pending");
    await api.run(api.store.use((db) => db.exec("DROP TRIGGER fail_use_decision")));
    await decision(api, row.request_id, "approve");
    await api.run(
      api.store.use((db) =>
        db.exec(
          "CREATE TRIGGER fail_use_consumption BEFORE INSERT ON event_log WHEN NEW.event_type = 'credential.used' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
        ),
      ),
    );
    expect(
      await run(Effect.result(vault.resolve(account.resolve, "atomic-request"))),
    ).toMatchObject({ failure: { code: "database_failed" } });
    expect((await first(api)).state).toBe("approved");
    await api.run(api.store.use((db) => db.exec("DROP TRIGGER fail_use_consumption")));
    await run(vault.resolve(account.resolve, "atomic-request"));
    expect((await first(api)).state).toBe("consumed");
  } finally {
    await browser.close();
  }
});

test("multi-inbox approval events keep their original scopes even when a credential is deleted", async ({
  api,
}) => {
  const account = await setup(api);
  const other = Schema.decodeUnknownSync(Credential)(
    await (
      await api.request("/v0/inboxes/other@example.test/credentials", {
        method: "POST",
        body: { name: "Other account", fields: { api_key: "foreign-test-secret" } },
      })
    ).json(),
  );
  const key = await api.run(
    api.keys.create({
      name: "Both inboxes",
      send_policy: "read_only",
      permissions: { credential_run: true, credential_read: true },
    }),
  );
  const response = await api.request("/v0/credentials/resolve", {
    token: key.api_key,
    method: "POST",
    headers: { "idempotency-key": "multi-inbox" },
    body: { ...account.resolve, refs: [account.credential.refs.password, other.refs.api_key] },
  });
  await error(response, "approval_required");
  const row = await first(api);
  expect(row.credentials).toHaveLength(2);
  expect(
    (
      await api.request(`/v0/inboxes/${other.inbox_id}/credentials/${other.credential_id}`, {
        method: "DELETE",
      })
    ).status,
  ).toBe(200);
  await decision(api, row.request_id, "reject");
  const events = (await api.run(api.store.use((db) => readEvents(db, 0)))).filter(
    (row) => "credential_use" in row.payload,
  );
  expect(events).toHaveLength(4);
  for (const event of events) {
    expect(event.payload).toMatchObject({
      credential_use: {
        credential_ids: [
          event.inbox_id === inboxId ? account.credential.credential_id : other.credential_id,
        ],
        fields: [event.inbox_id === inboxId ? "password" : "api_key"],
      },
    });
    const scoped = {
      kind: "agent",
      api_key_id: key.api_key_id,
      grant: {
        inbox_ids: [inboxId],
        permissions: { credential_read: true },
        send_policy: "read_only",
      },
    } satisfies Principal;
    expect(eventVisible(event, scoped)).toBe(event.inbox_id === inboxId);
    expect(JSON.stringify(event.payload)).not.toContain("foreign-test-secret");
  }
});
