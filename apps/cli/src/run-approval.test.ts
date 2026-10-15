import { ApiKey } from "../../../packages/contracts/src/api-keys.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, test as base } from "vitest";
import { Credential } from "../../../packages/contracts/src/vault.js";
import { ListCredentialUseRequestsResponse } from "../../../packages/contracts/src/credential-use.js";
import { fixture } from "../../server/src/http/test-fixture.js";
import { runCli, type CliIO } from "./cli.js";

const inboxId = "agent@example.test";
const test = base.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-run-approval-"));
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
async function account(api: Api) {
  const credential = Schema.decodeUnknownSync(Credential)(
    await (
      await api.request(`/v0/inboxes/${inboxId}/credentials`, {
        method: "POST",
        body: { name: "Run approval", fields: { password: "synthetic-child-secret" } },
      })
    ).json(),
  );
  const key = await api.run(
    api.keys.create({
      name: "Run agent",
      inbox_ids: [inboxId],
      permissions: { credential_run: true },
      send_policy: "read_only",
    }),
  );
  const ref = credential.refs.password;
  if (ref === undefined) throw new Error("Expected password ref");
  return { ref, env: { INBOT_URL: api.url, INBOT_API_KEY: key.api_key } };
}
function invoke(args: readonly string[], options: Partial<CliIO>) {
  let stdout = "";
  let stderr = "";
  const result = runCli(args, {
    env: {},
    ...options,
    stdout: (text) => {
      stdout += text;
      options.stdout?.(text);
    },
    stderr: (text) => {
      stderr += text;
      options.stderr?.(text);
    },
  }).then((code) => ({ code, stdout, stderr }));
  return result;
}
function waiting() {
  let notify: ((id: string) => void) | undefined;
  const started = new Promise<string>((resolve) => {
    notify = resolve;
  });
  return {
    started,
    stderr: (text: string) => {
      const id = /Waiting for owner approval \(request ([0-9a-f]{32})\)/.exec(text)?.[1];
      if (id !== undefined) notify?.(id);
    },
  };
}
function args(ref: string, flags: readonly string[] = []) {
  return [
    "run",
    "--env",
    `CREDENTIAL=${ref}`,
    ...flags,
    "--",
    process.execPath,
    "-e",
    "process.stdout.write(process.env.CREDENTIAL ?? 'missing')",
  ];
}

test("run waits with one generated key and succeeds after owner CLI approval", async ({ api }) => {
  const user = await account(api);
  const wait = waiting();
  const running = invoke(args(user.ref), { env: user.env, stderr: wait.stderr });
  const id = await wait.started;
  const owner = { INBOT_URL: api.url, INBOT_API_KEY: api.token };
  const listed = await invoke(
    ["credentials", "use-requests", "list", "--state", "pending", "--json"],
    { env: owner },
  );
  expect(listed.code).toBe(0);
  const page = Schema.decodeUnknownSync(Schema.fromJsonString(ListCredentialUseRequestsResponse))(
    listed.stdout,
  );
  expect(page.requests.map((row) => row.request_id)).toEqual([id]);
  const approved = await invoke(["credentials", "use-requests", "approve", id, "--json"], {
    env: owner,
  });
  expect(approved.code, approved.stderr).toBe(0);
  const result = await running;
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe("<concealed by inbot>");
  expect(result.stderr.match(/Idempotency-Key:/g)).toHaveLength(1);
  expect(result.stderr).toContain(`Waiting for owner approval (request ${id})...`);
  expect(result.stderr).not.toContain("synthetic-child-secret");
  const consumed = await invoke(
    ["credentials", "use-requests", "list", "--state", "consumed", "--json"],
    { env: owner },
  );
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(ListCredentialUseRequestsResponse))(
      consumed.stdout,
    ).count,
  ).toBe(1);
});

test("timeout zero fails immediately with the chosen idempotency key and never starts the child", async ({
  api,
}) => {
  const user = await account(api);
  const result = await invoke(
    args(user.ref, ["--approval-timeout", "0", "--idempotency-key", "run-fast"]),
    { env: user.env },
  );
  expect(result.code).toBe(4);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain('"code":"approval_required"');
  expect(result.stderr).toContain("Idempotency-Key: run-fast");
  expect(result.stderr).not.toContain("Waiting for owner");
  const page = Schema.decodeUnknownSync(ListCredentialUseRequestsResponse)(
    await (await api.request("/v0/credential-use-requests")).json(),
  );
  expect(page.count).toBe(1);
  const id = page.requests[0]?.request_id;
  if (id === undefined) throw new Error("Expected pending request");
  expect(
    (await api.request(`/v0/credential-use-requests/${id}/approve`, { method: "POST" })).status,
  ).toBe(200);
  const retried = await invoke(args(user.ref, ["--idempotency-key", "run-fast"]), {
    env: user.env,
  });
  expect(retried.code, retried.stderr).toBe(0);
  expect(retried.stdout).toBe("<concealed by inbot>");
});

test("run exits with missing_permission after rejection and owner CLI rejects idempotently", async ({
  api,
}) => {
  const user = await account(api);
  const wait = waiting();
  const running = invoke(args(user.ref), { env: user.env, stderr: wait.stderr });
  const id = await wait.started;
  const owner = { INBOT_URL: api.url, INBOT_API_KEY: api.token };
  for (let attempt = 0; attempt < 2; attempt++)
    expect((await invoke(["credentials", "use-requests", "reject", id], { env: owner })).code).toBe(
      0,
    );
  const result = await running;
  expect(result.code).toBe(4);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain('"code":"missing_permission"');
});

test("run deadline and cancellation stop approval waiting without spawning a child", async ({
  api,
}) => {
  const user = await account(api);
  const timed = await invoke(args(user.ref, ["--approval-timeout", "0.05"]), { env: user.env });
  expect(timed.code).toBe(4);
  expect(timed.stdout).toBe("");
  expect(timed.stderr).toContain('"code":"approval_required"');
  const controller = new AbortController();
  const cancelled = await invoke(args(user.ref), {
    env: user.env,
    signal: controller.signal,
    stderr: (text) => {
      if (text.startsWith("Waiting for owner")) controller.abort();
    },
  });
  expect(cancelled.code).toBe(143);
  const interrupted = await invoke(args(user.ref), {
    env: user.env,
    stderr: (text) => {
      if (text.startsWith("Waiting for owner")) process.emit("SIGINT");
    },
  });
  expect(interrupted.code).toBe(130);
  for (const timeout of ["-1", "NaN", "Infinity"])
    expect(
      (await invoke(args(user.ref, ["--approval-timeout", timeout]), { env: user.env })).code,
    ).toBe(2);
});

test("API key CLI persists create/update use policies and keeps the safe default when omitted", async ({
  api,
}) => {
  const env = { INBOT_URL: api.url, INBOT_API_KEY: api.token };
  const created = await invoke(
    [
      "api-keys",
      "create",
      "--name",
      "CLI approval",
      "--permissions",
      "{}",
      "--send-policy",
      "read_only",
      "--use-policy",
      "direct",
      "--json",
    ],
    { env },
  );
  expect(created.code, created.stderr).toBe(0);
  const key = Schema.decodeUnknownSync(Schema.fromJsonString(ApiKey))(created.stdout);
  expect(key.use_policy).toBe("direct");
  const updated = await invoke(
    ["api-keys", "update", key.api_key_id, "--use-policy", "approval", "--json"],
    { env },
  );
  expect(updated.code, updated.stderr).toBe(0);
  expect(Schema.decodeUnknownSync(Schema.fromJsonString(ApiKey))(updated.stdout).use_policy).toBe(
    "approval",
  );
  const defaults = await invoke(
    ["api-keys", "create", "--permissions", "{}", "--send-policy", "direct", "--json"],
    { env },
  );
  expect(defaults.code, defaults.stderr).toBe(0);
  expect(Schema.decodeUnknownSync(Schema.fromJsonString(ApiKey))(defaults.stdout).use_policy).toBe(
    "approval",
  );
  for (const command of [
    ["api-keys", "create"],
    ["api-keys", "update"],
    ["credentials", "fill"],
  ])
    expect((await invoke([...command, "--help"], { env })).stdout).toContain(
      command[0] === "credentials" ? "--idempotency-key" : "--use-policy",
    );
});
