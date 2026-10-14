import { ListQuarantineResponse } from "../../../packages/contracts/src/quarantine.js";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, test as base, vi } from "vitest";
import { bufferState } from "../../server/src/inbound/state.js";
import { makeLists } from "../../server/src/lists/lists.js";
import { makeOAuth } from "../../server/src/oauth/service.js";
import {
  OAuthClientsResponse,
  PurgeOAuthClientsResponse,
} from "../../../packages/contracts/src/oauth.js";
import { ListRejectionsResponse } from "../../../packages/contracts/src/lists.js";
import { Event } from "../../../packages/contracts/src/events.js";
import { Webhook, ListWebhooksResponse } from "../../../packages/contracts/src/webhooks.js";
import { readEvents } from "../../server/src/events/log.js";
import {
  Credential,
  CredentialFieldsResponse,
  ListCredentialsResponse,
  TotpCodeResponse,
} from "../../../packages/contracts/src/vault.js";
import { Draft } from "../../../packages/contracts/src/drafts.js";
import {
  ListInboxesResponse,
  Inbox,
  SearchInboxesResponse,
} from "../../../packages/contracts/src/inboxes.js";
import {
  Domain,
  ListDomainsResponse,
  ProvisionPlan,
} from "../../../packages/contracts/src/domains.js";
import {
  ListThreadsResponse,
  SearchThreadsResponse,
  UpdateThreadResponse,
} from "../../../packages/contracts/src/threads.js";
import { OwnerTransportStatus } from "../../../packages/contracts/src/owner.js";
import { RawMessageResponse } from "../../../packages/contracts/src/messages.js";
import { download } from "./downloads.js";
import {
  Message,
  SendMessageResponse,
  ListMessagesResponse,
  SearchMessagesResponse,
  BatchGetMessagesResponse,
  BatchUpdateMessagesResponse,
} from "../../../packages/contracts/src/messages.js";
import { ApiKey, CreateApiKeyResponse } from "../../../packages/contracts/src/api-keys.js";
import { fixture } from "../../server/src/http/test-fixture.js";
import { runCli, type CliIO } from "./cli.js";
import { errorExitCode } from "./errors.js";
import { ErrorCode, ErrorStatus } from "../../../packages/contracts/src/errors.js";

const inboxId = "agent@example.test";
const parentId = "<first@example.test>";
const test = base.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-cli-test-"));
    try {
      const api = await fixture(home);
      try {
        await use(api);
      } finally {
        await api.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
});
async function invoke(
  api: Awaited<ReturnType<typeof fixture>>,
  args: string[],
  overrides: Partial<CliIO> = {},
) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    env: { INBOT_HOME: api.home },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    ...overrides,
  });
  return { code, stdout, stderr };
}
const agentEnv = (api: Awaited<ReturnType<typeof fixture>>, token: string) => ({
  INBOT_URL: api.url,
  INBOT_API_KEY: token,
});
const payload = {
  to: ["recipient@example.test"],
  subject: "Synthetic CLI message",
  text: "Synthetic content",
};

test("searches inboxes and updates status and metadata without widening agent permissions", async ({
  api,
}) => {
  const search = await invoke(api, ["inboxes", "search", "--q", "agent", "--limit", "1", "--json"]);
  expect(search.code).toBe(0);
  expect(
    Schema.decodeUnknownSync(SearchInboxesResponse)(JSON.parse(search.stdout)).inboxes.map(
      (row) => row.inbox_id,
    ),
  ).toEqual([inboxId]);
  const updated = await invoke(api, [
    "inboxes",
    "update",
    inboxId,
    "--display-name",
    "Research",
    "--status",
    "paused",
    "--metadata",
    '{"project":"synthetic","keep":true}',
    "--json",
  ]);
  expect(updated.code).toBe(0);
  expect(Schema.decodeUnknownSync(Inbox)(JSON.parse(updated.stdout))).toMatchObject({
    display_name: "Research",
    status: "paused",
    metadata: { project: "synthetic", keep: true },
  });
  const merged = await invoke(api, [
    "inboxes",
    "update",
    inboxId,
    "--data",
    '{"status":"active","metadata":{"project":null}}',
    "--json",
  ]);
  expect(Schema.decodeUnknownSync(Inbox)(JSON.parse(merged.stdout))).toMatchObject({
    status: "active",
    metadata: { keep: true },
  });
  expect(
    (await invoke(api, ["inboxes", "update", inboxId, "--data", '{"metadata":null}'])).code,
  ).toBe(0);
  const key = await agent(api);
  expect(
    (
      await invoke(api, ["inboxes", "update", inboxId, "--status", "paused"], {
        env: agentEnv(api, key.api_key),
      })
    ).code,
  ).toBe(4);
  for (const args of [
    ["inboxes", "update", inboxId],
    ["inboxes", "update", inboxId, "--status", "invalid"],
    ["inboxes", "search", "--q", "agent", "--limit", "101"],
  ]) {
    expect((await invoke(api, args)).code).toBe(2);
  }
});

test("searches global and scoped threads, edits labels, and deletes their messages", async ({
  api,
}) => {
  const key = await agent(api);
  const env = agentEnv(api, key.api_key);
  for (const scope of [[], ["--inbox", inboxId]]) {
    const result = await invoke(api, ["threads", "search", "--q", "project", ...scope, "--json"], {
      env,
    });
    expect(result.code).toBe(0);
    expect(
      Schema.decodeUnknownSync(SearchThreadsResponse)(JSON.parse(result.stdout)).threads.map(
        (row) => row.thread_id,
      ),
    ).toEqual([api.threadId]);
    const edit = await invoke(
      api,
      ["threads", "update", api.threadId, ...scope, "--add-labels", "reviewed", "--json"],
      { env },
    );
    expect(edit.code).toBe(0);
    expect(
      Schema.decodeUnknownSync(UpdateThreadResponse)(JSON.parse(edit.stdout)).labels,
    ).toContain("reviewed");
    expect((await invoke(api, ["threads", "delete", api.threadId, ...scope], { env })).code).toBe(
      4,
    );
  }
  expect(
    (
      await invoke(
        api,
        [
          "threads",
          "update",
          api.threadId,
          "--inbox",
          "other@example.test",
          "--remove-labels",
          "reviewed",
        ],
        { env },
      )
    ).code,
  ).toBe(5);
  expect((await invoke(api, ["threads", "delete", api.threadId, "--inbox", inboxId])).code).toBe(0);
  expect((await invoke(api, ["messages", "get", inboxId, parentId])).code).toBe(5);
  const second = await api.run(
    api.mailbox.insertMessage({
      inbox_id: inboxId,
      message_id: "<second@example.test>",
      direction: "received",
      from: "sender@example.test",
      to: [inboxId],
      timestamp: "2026-10-10T11:00:00Z",
      raw: Buffer.from("Synthetic"),
    }),
  );
  expect((await invoke(api, ["threads", "delete", second.thread_id])).code).toBe(0);
  const remaining = await invoke(api, ["threads", "list", "--json"]);
  expect(Schema.decodeUnknownSync(ListThreadsResponse)(JSON.parse(remaining.stdout)).count).toBe(0);
});

test("lists and searches messages, maps repeated filters, and applies batches and deletion", async ({
  api,
}) => {
  const key = await agent(api);
  const env = agentEnv(api, key.api_key);
  const listed = await invoke(
    api,
    [
      "messages",
      "list",
      inboxId,
      "--from",
      "alice@example.test",
      "--to",
      inboxId,
      "--subject",
      "project",
      "--ascending",
      "--limit",
      "1",
      "--json",
    ],
    { env },
  );
  expect(listed.code).toBe(0);
  expect(
    Schema.decodeUnknownSync(ListMessagesResponse)(JSON.parse(listed.stdout)).messages.map(
      (row) => row.message_id,
    ),
  ).toEqual([parentId]);
  const searched = await invoke(
    api,
    [
      "messages",
      "search",
      inboxId,
      "--q",
      "searchable",
      "--after",
      "2026-10-10T00:00:00Z",
      "--json",
    ],
    { env },
  );
  expect(searched.code).toBe(0);
  expect(Schema.decodeUnknownSync(SearchMessagesResponse)(JSON.parse(searched.stdout)).count).toBe(
    1,
  );
  expect((await invoke(api, ["messages", "search", inboxId])).code).toBe(2);
  const batch = await invoke(
    api,
    ["messages", "batch-get", inboxId, "--message-ids", parentId, "--json"],
    { env },
  );
  expect(batch.code).toBe(0);
  expect(
    Schema.decodeUnknownSync(BatchGetMessagesResponse)(JSON.parse(batch.stdout)).messages[0]?.text,
  ).toContain("searchable");
  expect(
    (
      await invoke(
        api,
        ["messages", "batch-get", inboxId, "--message-ids", parentId, "--message-ids", parentId],
        { env },
      )
    ).code,
  ).toBe(2);
  const edits = await invoke(
    api,
    [
      "messages",
      "batch-update",
      inboxId,
      "--message-ids",
      parentId,
      "--add-labels",
      "reviewed",
      "--remove-labels",
      "unread",
      "--json",
    ],
    { env },
  );
  expect(edits.code).toBe(0);
  const labels = Schema.decodeUnknownSync(BatchUpdateMessagesResponse)(JSON.parse(edits.stdout))
    .updates[0]?.labels;
  expect(labels).toContain("reviewed");
  expect(labels).not.toContain("unread");
  expect((await invoke(api, ["messages", "list", "other@example.test"], { env })).code).toBe(5);
  expect((await invoke(api, ["messages", "delete", inboxId, parentId], { env })).code).toBe(4);
  expect((await invoke(api, ["messages", "delete", inboxId, parentId])).code).toBe(0);
  expect((await invoke(api, ["messages", "get", inboxId, parentId])).code).toBe(5);
});

test("calls reply-all with shared validation and reuses its idempotency key", async ({ api }) => {
  await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
  const key = await agent(api);
  const args = [
    "messages",
    "reply-all",
    inboxId,
    parentId,
    "--text",
    "Synthetic reply",
    "--idempotency-key",
    "reply-all-1",
    "--json",
  ];
  const first = await invoke(api, args, { env: agentEnv(api, key.api_key) });
  expect(first.code).toBe(0);
  expect(
    Schema.decodeUnknownSync(SendMessageResponse)(JSON.parse(first.stdout)).message_id,
  ).toBeTruthy();
  expect(first.stderr).toBe("Idempotency-Key: reply-all-1\n");
  expect((await invoke(api, args, { env: agentEnv(api, key.api_key) })).stdout).toBe(first.stdout);
  expect(
    (
      await invoke(api, [
        "messages",
        "reply-all",
        inboxId,
        parentId,
        "--data",
        '{"to":["unexpected@example.test"]}',
      ])
    ).code,
  ).toBe(2);
});

test("gets API key metadata without its secret and preserves owner and not-found errors", async ({
  api,
}) => {
  const key = await agent(api);
  const result = await invoke(api, ["api-keys", "get", key.api_key_id, "--json"]);
  expect(result.code).toBe(0);
  expect(Schema.decodeUnknownSync(ApiKey)(JSON.parse(result.stdout)).api_key_id).toBe(
    key.api_key_id,
  );
  expect(result.stdout + result.stderr).not.toContain(key.api_key);
  expect(
    (await invoke(api, ["api-keys", "get", key.api_key_id], { env: agentEnv(api, key.api_key) }))
      .code,
  ).toBe(4);
  expect((await invoke(api, ["api-keys", "get", "missing"])).code).toBe(5);
  expect((await invoke(api, ["api-keys", "list", "--type", "bearer", "--ascending"])).code).toBe(0);
});

test("downloads raw bytes to private files or binary stdout and keeps metadata in JSON mode", async ({
  api,
}) => {
  const output = join(api.home, "raw.eml");
  const args = ["messages", "raw", inboxId, parentId];
  const file = await invoke(api, [...args, "-o", output], { stdoutIsTTY: true });
  expect(file.code).toBe(0);
  expect(file.stdout).toBe("");
  expect(await readFile(output)).toEqual(api.raw);
  if (process.platform !== "win32") expect((await stat(output)).mode & 0o777).toBe(0o600);
  const existing = await invoke(api, [...args, "-o", output]);
  expect(existing.code).toBe(1);
  expect(existing.stderr).toContain("never overwritten");
  expect(await readFile(output)).toEqual(api.raw);
  for (const suffix of [[], ["-o", "-"]]) {
    const chunks: Uint8Array[] = [];
    const redirected = await invoke(api, [...args, ...suffix], {
      stdoutIsTTY: false,
      stdoutBinary: async (bytes) => {
        chunks.push(bytes);
      },
    });
    expect(redirected.code).toBe(0);
    expect(redirected.stdout).toBe("");
    expect(Buffer.concat(chunks)).toEqual(api.raw);
    expect(
      (
        await invoke(api, [...args, ...suffix], {
          stdoutIsTTY: true,
          stdoutBinary: async () => {
            throw new Error("Must not write");
          },
        })
      ).code,
    ).toBe(2);
  }
  const metadata = await invoke(api, [...args, "--json"], { stdoutIsTTY: true });
  expect(metadata.code).toBe(0);
  expect(Schema.decodeUnknownSync(RawMessageResponse)(JSON.parse(metadata.stdout)).size).toBe(
    api.raw.length,
  );
  expect((await invoke(api, [...args, "--json", "-o", output])).code).toBe(2);
  expect(
    (
      await invoke(api, [
        "messages",
        "raw",
        inboxId,
        "missing",
        "-o",
        join(api.home, "missing.eml"),
      ])
    ).code,
  ).toBe(5);
});

test("downloads message, thread, and draft attachments through scoped and global routes", async ({
  api,
}) => {
  const bytes = Buffer.from([0, 255, 128, 13, 10, 65]);
  const stored = await api.run(
    api.mailbox.insertMessage({
      inbox_id: inboxId,
      message_id: "<binary@example.test>",
      direction: "received",
      from: "sender@example.test",
      to: [inboxId],
      timestamp: "2026-10-10T11:00:00Z",
      raw: Buffer.from("Synthetic MIME"),
      attachments: [{ attachment_id: "binary-file", filename: "sample.bin", content: bytes }],
    }),
  );
  const created = await invoke(api, [
    "drafts",
    "create",
    inboxId,
    "--data",
    JSON.stringify({ attachments: [{ filename: "draft.bin", content: bytes.toString("base64") }] }),
    "--json",
  ]);
  expect(created.code).toBe(0);
  const draft = Schema.decodeUnknownSync(Draft)(JSON.parse(created.stdout));
  const attachmentId = draft.attachments?.[0]?.attachment_id;
  if (attachmentId === undefined) throw new Error("Missing attachment");
  const key = await agent(api);
  const env = agentEnv(api, key.api_key);
  const commands = [
    ["messages", "attachment", inboxId, "<binary@example.test>", "binary-file"],
    ["threads", "attachment", stored.thread_id, "binary-file"],
    ["threads", "attachment", stored.thread_id, "binary-file", "--inbox", inboxId],
    ["drafts", "attachment", draft.draft_id, attachmentId],
    ["drafts", "attachment", draft.draft_id, attachmentId, "--inbox", inboxId],
  ];
  for (const args of commands) {
    const chunks: Uint8Array[] = [];
    const result = await invoke(api, args, {
      env,
      stdoutIsTTY: false,
      stdoutBinary: async (bytes) => {
        chunks.push(bytes);
      },
    });
    expect(result.code, result.stderr).toBe(0);
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(result.stdout + result.stderr).not.toContain(key.api_key);
  }
  expect(
    (
      await invoke(
        api,
        [
          "threads",
          "attachment",
          stored.thread_id,
          "binary-file",
          "--inbox",
          "other@example.test",
          "--json",
        ],
        { env },
      )
    ).code,
  ).toBe(5);
  await api.run(api.keys.update(key.api_key_id, { permissions: { inbox_read: true } }));
  expect(
    (
      await invoke(
        api,
        ["messages", "attachment", inboxId, "<binary@example.test>", "binary-file", "--json"],
        {
          env,
        },
      )
    ).code,
  ).toBe(4);
});

base(
  "refuses foreign capability URLs and maps download failures without writing bytes",
  async () => {
    const origin = "http://127.0.0.1:43123";
    const fetcher = vi.spyOn(globalThis, "fetch");
    let written = false;
    const io: CliIO = {
      env: {},
      stdout: () => {},
      stderr: () => {},
      stdoutBinary: async () => {
        written = true;
      },
    };
    try {
      for (const url of [
        "https://foreign.example/v0/downloads/a.b",
        `${origin}/other`,
        `${origin}/v0/downloads/a.b?token=secret`,
      ]) {
        await expect(
          download(origin, { download_url: url, size: 1 }, undefined, io),
        ).rejects.toMatchObject({ exitCode: 10 });
      }
      expect(fetcher).not.toHaveBeenCalled();
      fetcher.mockResolvedValue(
        Response.json(
          {
            name: "InbotError",
            code: "unauthorized",
            message: "Issuer revoked.",
            fix: "Request a fresh URL.",
          },
          { status: 401 },
        ),
      );
      await expect(
        download(origin, { download_url: `${origin}/v0/downloads/a.b`, size: 1 }, undefined, io),
      ).rejects.toMatchObject({ exitCode: 3 });
      expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
      expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty("headers");
      fetcher.mockResolvedValue(new Response(new Uint8Array([1, 2])));
      await expect(
        download(origin, { download_url: `${origin}/v0/downloads/a.b`, size: 1 }, undefined, io),
      ).rejects.toMatchObject({ exitCode: 10 });
      expect(written).toBe(false);
    } finally {
      fetcher.mockRestore();
    }
  },
);

test("configures verified transport from env or stdin, hides secrets, and clears it", async ({
  api,
}) => {
  const accountId = "a".repeat(32);
  const token = "synthetic-cloud-token";
  const status = await invoke(api, ["transport", "status", "--json"]);
  expect(
    Schema.decodeUnknownSync(OwnerTransportStatus)(JSON.parse(status.stdout)).verification_status,
  ).toBe("not_configured");
  const configured = await invoke(
    api,
    ["transport", "configure", "--account-id", accountId, "--json"],
    { env: { INBOT_HOME: api.home, INBOT_CLOUDFLARE_API_TOKEN: token } },
  );
  expect(configured.code).toBe(0);
  expect(
    Schema.decodeUnknownSync(OwnerTransportStatus)(JSON.parse(configured.stdout)),
  ).toMatchObject({ account_id: accountId, token_set: true, verification_status: "verified" });
  const stdin = await invoke(
    api,
    ["transport", "configure", "--account-id", accountId, "--token-stdin", "--json"],
    { readStdin: async () => `${token}\r\n` },
  );
  expect(stdin.code).toBe(0);
  expect(configured.stdout + configured.stderr + stdin.stdout + stdin.stderr).not.toContain(token);
  for (const args of [
    ["transport", "configure", "--api-token", token],
    [
      "transport",
      "configure",
      "--data",
      JSON.stringify({ account_id: accountId, api_token: token }),
    ],
    ["transport", "configure"],
  ]) {
    const result = await invoke(api, args);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain(token);
  }
  const ambiguous = await invoke(api, ["transport", "configure", "--token-stdin"], {
    env: { INBOT_HOME: api.home, INBOT_CLOUDFLARE_API_TOKEN: token },
    readStdin: async () => {
      throw new Error("Must not read");
    },
  });
  expect(ambiguous.code).toBe(2);
  const invalid = await invoke(api, ["transport", "configure", "--account-id", "invalid"], {
    env: { INBOT_HOME: api.home, INBOT_CLOUDFLARE_API_TOKEN: token },
  });
  expect(invalid.code).toBe(2);
  expect(invalid.stderr).not.toContain(token);
  const key = await agent(api);
  for (const args of [
    ["transport", "status"],
    ["transport", "clear"],
    ["transport", "configure", "--account-id", accountId],
  ]) {
    const forbidden = await invoke(api, args, {
      env: { ...agentEnv(api, key.api_key), INBOT_CLOUDFLARE_API_TOKEN: token },
    });
    expect(forbidden.code).toBe(4);
    expect(forbidden.stdout + forbidden.stderr).not.toContain(token);
  }
  expect((await invoke(api, ["transport", "clear"])).code).toBe(0);
  const cleared = await invoke(api, ["transport", "status", "--json"]);
  expect(Schema.decodeUnknownSync(OwnerTransportStatus)(JSON.parse(cleared.stdout)).token_set).toBe(
    false,
  );
});

base(
  "preserves the transport verification error and never echoes the candidate token",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "inbot-cli-transport-failure-"));
    const api = await fixture(home, {
      transportFetch: async () => Response.json({ success: false }, { status: 403 }),
    });
    try {
      const token = "synthetic-rejected-cloud-token";
      const result = await invoke(api, ["transport", "configure", "--account-id", "a".repeat(32)], {
        env: { INBOT_HOME: home, INBOT_CLOUDFLARE_API_TOKEN: token },
      });
      expect(result.code).toBe(4);
      expect(JSON.parse(result.stderr)).toMatchObject({
        code: "missing_permission",
        fix: expect.any(String),
      });
      expect(result.stdout + result.stderr).not.toContain(token);
      const inspected = await invoke(api, ["transport", "status", "--json"]);
      expect(
        Schema.decodeUnknownSync(OwnerTransportStatus)(JSON.parse(inspected.stdout)).token_set,
      ).toBe(false);
    } finally {
      await api.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("uses the complete owner domain lifecycle and preserves DNS text and real states", async ({
  api,
}) => {
  await api.run(api.transport.set({ account_id: "fake-account", api_token: "synthetic" }));
  const registered = await invoke(api, [
    "domains",
    "create",
    "--domain",
    "agents.example.test",
    "--inbound-enabled",
    "--no-tracking-enabled",
    "--json",
  ]);
  expect(registered.code, registered.stderr).toBe(0);
  const domain = Schema.decodeUnknownSync(Domain)(JSON.parse(registered.stdout));
  expect(domain.status).toBe("NOT_STARTED");
  const id = domain.domain_id;
  const listed = await invoke(api, ["domains", "list", "--limit", "1", "--ascending", "--json"]);
  expect(
    Schema.decodeUnknownSync(ListDomainsResponse)(JSON.parse(listed.stdout)).domains.map(
      (row) => row.domain_id,
    ),
  ).toEqual([id]);
  expect((await invoke(api, ["domains", "list"])).stdout).toContain("DOMAIN_ID");
  const beforePlan = api.cloud.mutations.length;
  const plan = await invoke(api, ["domains", "plan", id, "--json"]);
  expect(plan.code).toBe(0);
  expect(
    Schema.decodeUnknownSync(ProvisionPlan)(JSON.parse(plan.stdout)).steps.length,
  ).toBeGreaterThan(0);
  expect(api.cloud.mutations.length).toBe(beforePlan);
  const zone = await invoke(api, ["domains", "zone-file", id]);
  expect(zone.code).toBe(0);
  expect(zone.stdout).toBe(await (await api.request(`/v0/domains/${id}/zone-file`)).text());
  expect(zone.stdout).toContain("\n");
  const jsonZone = await invoke(api, ["domains", "zone-file", id, "--json"]);
  expect(JSON.parse(jsonZone.stdout)).toBe(zone.stdout);
  const updated = await invoke(api, [
    "domains",
    "update",
    id,
    "--inbound-enabled",
    "--no-feedback-enabled",
    "--json",
  ]);
  expect(updated.code).toBe(0);
  expect((await invoke(api, ["domains", "update", id, "--tracking-enabled"])).code).toBe(2);
  const key = await agent(api);
  const env = agentEnv(api, key.api_key);
  for (const args of [
    ["domains", "list"],
    ["domains", "get", id],
    ["domains", "plan", id],
    ["domains", "zone-file", id],
    ["domains", "create", "--domain", "other.example.test"],
    ["domains", "update", id, "--inbound-enabled"],
    ["domains", "apply", id],
    ["domains", "verify", id],
    ["domains", "teardown", id],
    ["domains", "delete", id],
  ]) {
    expect((await invoke(api, args, { env })).code).toBe(4);
  }
  const applied = await invoke(api, ["domains", "apply", id, "--json"]);
  expect(applied.code, applied.stderr).toBe(0);
  expect(Schema.decodeUnknownSync(Domain)(JSON.parse(applied.stdout)).status).toBe("VERIFYING");
  const conflict = await invoke(api, ["transport", "clear"]);
  expect(conflict.code).toBe(6);
  expect(conflict.stderr).toContain("action_required");
  expect((await invoke(api, ["domains", "verify", id, "--json"])).stdout).toBe("null\n");
  const inspected = await invoke(api, ["domains", "get", id, "--json"]);
  expect(Schema.decodeUnknownSync(Domain)(JSON.parse(inspected.stdout)).status).toBe("VERIFYING");
  const teardown = await invoke(api, ["domains", "teardown", id, "--json"]);
  expect(teardown.code, teardown.stderr).toBe(0);
  expect(Schema.decodeUnknownSync(Domain)(JSON.parse(teardown.stdout)).status).toBe("NOT_STARTED");
  expect((await invoke(api, ["domains", "delete", id])).code).toBe(0);
  expect((await invoke(api, ["domains", "get", id])).code).toBe(5);
  expect((await invoke(api, ["transport", "clear"])).code).toBe(0);
});

async function agent(
  api: Awaited<ReturnType<typeof fixture>>,
  send_policy: "direct" | "approval" | "read_only" = "direct",
) {
  return api.run(
    api.keys.create({
      inbox_id: inboxId,
      permissions: {
        inbox_read: true,
        message_read: true,
        message_send: true,
        message_reply: true,
        message_update: true,
        draft_read: true,
        draft_create: true,
        draft_update: true,
        draft_send: true,
        draft_delete: true,
      },
      send_policy,
    }),
  );
}

test("reads the owner connection and returns unchanged snake_case wire JSON", async ({ api }) => {
  const response = await api.request("/v0/inboxes");
  const expected = await response.json();
  const result = await invoke(api, ["inboxes", "list", "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(expected);
  expect(Schema.decodeUnknownSync(ListInboxesResponse)(JSON.parse(result.stdout)).count).toBe(2);
  expect(result.stdout + result.stderr).not.toContain(api.token);
  const human = await invoke(api, ["inboxes", "list"]);
  expect(human.stdout).toContain("INBOX_ID");
  expect(human.stdout).toContain(inboxId);
  const flag = await invoke(api, ["--home", api.home, "inboxes", "get", inboxId, "--json"], {
    env: { INBOT_HOME: join(api.home, "missing") },
  });
  expect(flag.code).toBe(0);
});

test("authenticates scoped agent keys and surfaces concealed scope errors and owner-only 403s", async ({
  api,
}) => {
  const key = await agent(api);
  const env = agentEnv(api, key.api_key);
  const list = await invoke(api, ["inboxes", "list", "--json"], { env });
  expect(
    Schema.decodeUnknownSync(ListInboxesResponse)(JSON.parse(list.stdout)).inboxes.map(
      (entry) => entry.inbox_id,
    ),
  ).toEqual([inboxId]);
  const expected = await (
    await api.request("/v0/inboxes/other@example.test", { token: key.api_key })
  ).json();
  const scope = await invoke(api, ["inboxes", "get", "other@example.test"], { env });
  expect(scope.code).toBe(5);
  expect(JSON.parse(scope.stderr)).toEqual(expected);
  const forbidden = await invoke(api, ["api-keys", "list"], { env });
  expect(forbidden.code).toBe(4);
  expect(JSON.parse(forbidden.stderr)).toMatchObject({ code: "missing_permission" });
  const denied = await invoke(api, ["drafts", "approve", inboxId, "absent"], { env });
  expect(denied.code).toBe(4);
  expect(denied.stderr).toContain("missing_permission");
  expect(list.stdout + scope.stderr + forbidden.stderr).not.toContain(key.api_key);
  const invalid = await invoke(api, ["inboxes", "list"], {
    env: agentEnv(api, "invalid-synthetic-token"),
  });
  expect(invalid.code).toBe(3);
  expect(JSON.parse(invalid.stderr)).toMatchObject({ code: "unauthorized" });
});

test("prints generated send keys and replays send and reply without duplicate effects", async ({
  api,
}) => {
  await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
  const key = await agent(api);
  const env = agentEnv(api, key.api_key);
  const args = ["messages", "send", inboxId, "--data", JSON.stringify(payload), "--json"];
  const first = await invoke(api, args, { env });
  expect(first.code).toBe(0);
  const idempotencyKey = first.stderr.match(/^Idempotency-Key: ([A-Za-z0-9._~-]+)\n$/)?.[1];
  expect(idempotencyKey).toBeDefined();
  if (idempotencyKey === undefined) throw new Error("Missing idempotency key");
  const sent = Schema.decodeUnknownSync(SendMessageResponse)(JSON.parse(first.stdout));
  const replay = await invoke(api, [...args, "--idempotency-key", idempotencyKey], { env });
  expect(replay.stdout).toBe(first.stdout);
  const stored = await api.request(
    `/v0/inboxes/${inboxId}/messages/${encodeURIComponent(sent.message_id)}`,
  );
  expect(Schema.decodeUnknownSync(Message)(await stored.json()).labels).toContain("queued");
  expect(api.sent).toHaveLength(0);
  const changed = await invoke(
    api,
    [
      "messages",
      "send",
      inboxId,
      "--to",
      "recipient@example.test",
      "--text",
      "Changed",
      "--idempotency-key",
      idempotencyKey,
    ],
    { env },
  );
  expect(changed.code).toBe(6);
  expect(changed.stderr).toContain("idempotency_conflict");
  const reply = [
    "messages",
    "reply",
    inboxId,
    parentId,
    "--text",
    "Synthetic reply",
    "--reply-all",
    "--idempotency-key",
    "cli-reply",
    "--json",
  ];
  const firstReply = await invoke(api, reply, { env });
  expect(firstReply.code).toBe(0);
  expect((await invoke(api, reply, { env })).stdout).toBe(firstReply.stdout);
  const forwarded = await invoke(
    api,
    [
      "messages",
      "forward",
      inboxId,
      parentId,
      "--to",
      "recipient@example.test",
      "--text",
      "Synthetic forward",
      "--json",
    ],
    { env },
  );
  expect(forwarded.code).toBe(0);
});

test("preserves server-enforced approval and read-only policies", async ({ api }) => {
  await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
  for (const policy of ["approval", "read_only"] as const) {
    const key = await agent(api, policy);
    const args = [
      "messages",
      "send",
      inboxId,
      "--data",
      JSON.stringify(payload),
      "--idempotency-key",
      `cli-${policy}`,
    ];
    const result = await invoke(api, args, { env: agentEnv(api, key.api_key) });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain(
      policy === "approval" ? "approval_required" : "missing_permission",
    );
    expect(result.stdout).toBe("");
    if (policy === "approval")
      expect((await invoke(api, args, { env: agentEnv(api, key.api_key) })).stderr).toBe(
        result.stderr,
      );
  }
  expect(api.sent).toHaveLength(0);
});

test("creates single-use login links and opens a browser only on explicit request", async ({
  api,
}) => {
  await api.request("/v0/owner/setup", {
    token: null,
    method: "POST",
    body: { password: "synthetic owner password", code: api.setupCode },
  });
  const opened: string[] = [];
  const openBrowser = async (url: string) => {
    opened.push(url);
  };
  const result = await invoke(api, ["open", "--json"], { openBrowser });
  expect(result.code).toBe(0);
  const link: unknown = JSON.parse(result.stdout);
  const { OwnerLoginLink } = await import("../../../packages/contracts/src/owner.js");
  const url = Schema.decodeUnknownSync(OwnerLoginLink)(link).url;
  expect(opened).toEqual([]);
  const token = new URL(url).searchParams.get("token");
  const redeem = () =>
    api.request("/v0/owner/login-links/redeem", { token: null, method: "POST", body: { token } });
  expect((await redeem()).status).toBe(200);
  expect((await redeem()).status).toBe(401);
  const browser = await invoke(api, ["open", "--browser"], { openBrowser });
  expect(browser.code).toBe(0);
  expect(opened).toEqual([browser.stdout.trim()]);
});

test("maps resource commands, pagination, label edits, draft reversals, and key revocation", async ({
  api,
}) => {
  const created = await invoke(api, [
    "inboxes",
    "create",
    "--username",
    "cli",
    "--domain",
    "example.test",
    "--json",
  ]);
  expect(created.code).toBe(0);
  const inbox = Schema.decodeUnknownSync(Inbox)(JSON.parse(created.stdout));
  expect(await invoke(api, ["inboxes", "delete", inbox.inbox_id, "--json"])).toMatchObject({
    code: 0,
    stdout: "null\n",
  });
  const threads = await invoke(api, [
    "threads",
    "list",
    "--inbox",
    inboxId,
    "--limit",
    "1",
    "--labels",
    "unread",
    "--json",
  ]);
  expect(threads.code).toBe(0);
  expect(
    (await invoke(api, ["threads", "get", api.threadId, "--inbox", inboxId, "--json"])).code,
  ).toBe(0);
  expect((await invoke(api, ["messages", "get", inboxId, parentId, "--json"])).code).toBe(0);
  expect(
    (
      await invoke(api, [
        "messages",
        "update",
        inboxId,
        parentId,
        "--add-labels",
        "review",
        "--remove-labels",
        "unread",
        "--json",
      ])
    ).code,
  ).toBe(0);
  const file = join(api.home, "synthetic-draft.json");
  await writeFile(file, JSON.stringify(payload));
  const result = await invoke(api, ["drafts", "create", inboxId, "--data-file", file, "--json"]);
  expect(result.code).toBe(0);
  const draft = Schema.decodeUnknownSync(Draft)(JSON.parse(result.stdout));
  expect(
    (
      await invoke(api, [
        "drafts",
        "update",
        inboxId,
        draft.draft_id,
        "--data",
        '{"subject":null}',
        "--json",
      ])
    ).code,
  ).toBe(0);
  expect(
    (await invoke(api, ["drafts", "get", draft.draft_id, "--inbox", inboxId, "--json"])).code,
  ).toBe(0);
  expect((await invoke(api, ["drafts", "list", "--inbox", inboxId, "--json"])).code).toBe(0);
  expect((await invoke(api, ["drafts", "delete", inboxId, draft.draft_id])).code).toBe(0);
  const keyResult = await invoke(api, [
    "api-keys",
    "create",
    "--inbox",
    inboxId,
    "--permissions",
    '{"inbox_read":true}',
    "--send-policy",
    "read_only",
    "--show-secret",
    "--json",
  ]);
  expect(keyResult.code).toBe(0);
  const key = Schema.decodeUnknownSync(CreateApiKeyResponse)(JSON.parse(keyResult.stdout));
  expect((await invoke(api, ["api-keys", "revoke", key.api_key_id, "--inbox", inboxId])).code).toBe(
    0,
  );
  expect((await invoke(api, ["inboxes", "list"], { env: agentEnv(api, key.api_key) })).code).toBe(
    3,
  );
  const hidden = await invoke(api, [
    "api-keys",
    "create",
    "--permissions",
    "{}",
    "--send-policy",
    "read_only",
    "--json",
  ]);
  expect(hidden.code).toBe(0);
  expect(JSON.parse(hidden.stdout)).not.toHaveProperty("api_key");
});

test("updates global and inbox API keys and enforces changed grants on the next request", async ({
  api,
}) => {
  for (const scoped of [false, true]) {
    const key = await agent(api);
    const env = agentEnv(api, key.api_key);
    const scope = scoped ? ["--inbox", inboxId] : [];
    const update = await invoke(api, [
      "api-keys",
      "update",
      key.api_key_id,
      ...scope,
      "--name",
      "Updated key",
      "--permissions",
      '{"inbox_read":true,"message_send":true}',
      "--send-policy",
      "approval",
      "--json",
    ]);
    expect(update.code).toBe(0);
    expect(Schema.decodeUnknownSync(ApiKey)(JSON.parse(update.stdout))).toMatchObject({
      name: "Updated key",
      permissions: { inbox_read: true, message_send: true },
      send_policy: "approval",
    });
    expect(update.stdout + update.stderr).not.toContain(key.api_key);
    const send = [
      "messages",
      "send",
      inboxId,
      "--data",
      JSON.stringify(payload),
      "--idempotency-key",
      `updated-${key.api_key_id}`,
    ];
    const approval = await invoke(api, send, { env });
    expect(approval.code).toBe(4);
    expect(approval.stderr).toContain("approval_required");
    const restricted = await invoke(api, [
      "api-keys",
      "update",
      key.api_key_id,
      ...scope,
      "--data",
      '{"send_policy":"read_only"}',
      "--json",
    ]);
    expect(restricted.code).toBe(0);
    expect(Schema.decodeUnknownSync(ApiKey)(JSON.parse(restricted.stdout)).name).toBe(
      "Updated key",
    );
    const denied = await invoke(api, send, { env });
    expect(denied.code).toBe(4);
    expect(denied.stderr).toContain("missing_permission");
    expect((await invoke(api, ["inboxes", "list"], { env })).code).toBe(0);
    expect(
      (await invoke(api, ["api-keys", "update", key.api_key_id, ...scope, "--permissions", "{}"]))
        .code,
    ).toBe(0);
    const removed = await invoke(api, ["inboxes", "list"], { env });
    expect(removed.code).toBe(4);
    expect(removed.stderr).toContain("missing_permission");
    expect((await invoke(api, ["api-keys", "update", key.api_key_id, ...scope])).code).toBe(2);
    expect(
      (
        await invoke(
          api,
          ["api-keys", "update", key.api_key_id, ...scope, "--name", "Agent edit"],
          { env },
        )
      ).code,
    ).toBe(4);
  }
  expect(api.sent).toHaveLength(0);
  const help = await invoke(api, ["api-keys", "update", "--help"]);
  expect(help.code).toBe(0);
  for (const flag of ["--name", "--permissions", "--send-policy", "--inbox"])
    expect(help.stdout).toContain(flag);
});

test("returns stable usage and availability exits without exposing malformed credentials", async ({
  api,
}) => {
  for (const args of [
    ["unknown"],
    ["--home"],
    ["inboxes", "get"],
    ["inboxes", "list", "--oops"],
    ["drafts", "create", inboxId, "--data", '{"unknown":true}'],
    ["messages", "send", inboxId, "--idempotency-key", "bad key"],
    ["inboxes", "list", "--flavor", "unknown"],
  ]) {
    expect((await invoke(api, args)).code).toBe(2);
  }
  const missing = await invoke(api, ["inboxes", "list"], {
    env: { INBOT_HOME: join(api.home, "missing") },
  });
  expect(missing.code).toBe(10);
  const incomplete = await invoke(api, ["inboxes", "list"], { env: { INBOT_URL: api.url } });
  expect(incomplete.code).toBe(2);
  const malformed = await invoke(api, ["inboxes", "list"], {
    env: { INBOT_URL: "http://synthetic-secret@example.test", INBOT_API_KEY: "synthetic-api-key" },
  });
  expect(malformed.code).toBe(2);
  expect(malformed.stderr).not.toContain("synthetic-secret");
  expect(malformed.stderr).not.toContain("synthetic-api-key");
  const unavailable = await invoke(api, [
    "messages",
    "send",
    inboxId,
    "--data",
    JSON.stringify(payload),
  ]);
  expect(unavailable.code).toBe(10);
  expect(unavailable.stderr).toContain("service_unavailable");
});

test("covers every shared server error category with stable exits", () => {
  const categories: Record<number, number> = {
    400: 2,
    413: 2,
    401: 3,
    403: 4,
    404: 5,
    409: 6,
    423: 7,
    429: 8,
    501: 9,
    503: 10,
  };
  for (const code of ErrorCode.literals)
    expect(
      errorExitCode({ name: "Synthetic", code, message: "Synthetic error", fix: "Synthetic fix" }),
    ).toBe(categories[ErrorStatus[code]]);
});

test("sends drafts and preserves owner approval and rejection responses", async ({ api }) => {
  await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
  const key = await agent(api, "approval");
  const create = async (extra: Record<string, unknown> = {}) => {
    const result = await invoke(
      api,
      ["drafts", "create", inboxId, "--data", JSON.stringify({ ...payload, ...extra }), "--json"],
      { env: agentEnv(api, key.api_key) },
    );
    expect(result.code).toBe(0);
    return Schema.decodeUnknownSync(Draft)(JSON.parse(result.stdout));
  };
  const scheduled = await create({ send_at: "2026-10-10T13:00:00Z" });
  const approve = await invoke(api, [
    "drafts",
    "approve",
    inboxId,
    scheduled.draft_id,
    "--idempotency-key",
    "cli-approve",
    "--json",
  ]);
  expect(approve.code).toBe(0);
  expect(Schema.decodeUnknownSync(Draft)(JSON.parse(approve.stdout))).toMatchObject({
    approval_state: "approved",
    send_status: "scheduled",
  });
  const sent = await invoke(api, [
    "drafts",
    "send",
    inboxId,
    scheduled.draft_id,
    "--idempotency-key",
    "cli-draft-send",
    "--json",
  ]);
  expect(sent.code).toBe(0);
  Schema.decodeUnknownSync(SendMessageResponse)(JSON.parse(sent.stdout));
  const rejected = await create();
  const decision = await invoke(api, [
    "drafts",
    "reject",
    inboxId,
    rejected.draft_id,
    "--reason",
    "Synthetic rejection",
    "--json",
  ]);
  expect(decision.code).toBe(0);
  expect(Schema.decodeUnknownSync(Draft)(JSON.parse(decision.stdout))).toMatchObject({
    approval_state: "rejected",
    rejection_reason: "Synthetic rejection",
  });
  const forbidden = await invoke(api, ["drafts", "reject", inboxId, rejected.draft_id], {
    env: agentEnv(api, key.api_key),
  });
  expect(forbidden.code).toBe(4);
  const immediate = await create();
  const approved = await invoke(api, ["drafts", "approve", inboxId, immediate.draft_id, "--json"]);
  expect(approved.code).toBe(0);
  Schema.decodeUnknownSync(SendMessageResponse)(JSON.parse(approved.stdout));
  expect(api.sent).toHaveLength(0);
});

test("list commands use global and inbox endpoints, decode entries, paginate and preserve errors", async ({
  api,
}) => {
  const create = await invoke(api, [
    "lists",
    "create",
    "receive",
    "block",
    "--entry",
    "EXAMPLE.TEST",
    "--reason",
    "Synthetic rule",
    "--json",
  ]);
  expect(create.code).toBe(0);
  expect(JSON.parse(create.stdout)).toMatchObject({
    entry: "example.test",
    entry_type: "domain",
    direction: "receive",
    list_type: "block",
  });
  const get = await invoke(api, ["lists", "get", "receive", "block", "EXAMPLE.TEST", "--json"]);
  expect(get.code).toBe(0);
  expect(JSON.parse(get.stdout)).toEqual(JSON.parse(create.stdout));
  const key = await api.run(
    api.keys.create({
      inbox_id: inboxId,
      permissions: { list_entry_read: true, list_entry_create: true, list_entry_delete: true },
      send_policy: "read_only",
    }),
  );
  const options = { env: agentEnv(api, key.api_key) };
  for (const entry of ["b.test", "a.test"])
    expect(
      (
        await invoke(
          api,
          ["lists", "create", "send", "allow", "--inbox", inboxId, "--entry", entry],
          options,
        )
      ).code,
    ).toBe(0);
  const list = await invoke(
    api,
    ["lists", "list", "send", "allow", "--inbox", inboxId, "--limit", "1", "--json"],
    options,
  );
  const page = JSON.parse(list.stdout);
  expect(list.code).toBe(0);
  expect(page.entries).toHaveLength(1);
  expect(page.entries[0].entry).toBe("a.test");
  const next = await invoke(
    api,
    [
      "lists",
      "list",
      "send",
      "allow",
      "--inbox",
      inboxId,
      "--page-token",
      page.next_page_token,
      "--json",
    ],
    options,
  );
  expect(JSON.parse(next.stdout).entries[0].entry).toBe("b.test");
  const human = await invoke(api, ["lists", "list", "send", "allow", "--inbox", inboxId], options);
  expect(human.stdout).toContain("ENTRY_TYPE");
  expect(human.stdout).toContain("a.test");
  expect(
    (await invoke(api, ["lists", "delete", "send", "allow", "a.test", "--inbox", inboxId], options))
      .code,
  ).toBe(0);
  expect(
    (await invoke(api, ["lists", "get", "send", "allow", "a.test", "--inbox", inboxId], options))
      .code,
  ).toBe(5);
  expect((await invoke(api, ["lists", "list", "receive", "block"], options)).code).toBe(4);
  expect(
    (
      await invoke(
        api,
        ["lists", "list", "send", "allow", "--inbox", "other@example.test"],
        options,
      )
    ).code,
  ).toBe(5);
  expect((await invoke(api, ["lists", "delete", "receive", "block", "example.test"])).code).toBe(0);
  const help = await invoke(api, ["lists", "create", "--help"]);
  expect(help.stdout).toContain("<direction> <type>");
  expect(help.stdout).toContain("--entry");
});

test("webhook commands use shared REST contracts, inbox scope, custom headers and explicit secret output", async ({
  api,
}) => {
  const args = [
    "webhooks",
    "create",
    "--inbox",
    inboxId,
    "--url",
    "http://localhost:1234/",
    "--event-types",
    "message.received",
    "--json",
  ];
  const omitted = await invoke(api, args);
  expect(omitted.code).toBe(0);
  expect(Schema.decodeUnknownSync(Webhook)(JSON.parse(omitted.stdout)).secret).toBeUndefined();
  expect(omitted.stderr).toContain("Secret omitted");
  const result = await invoke(api, [...args, "--show-secret"]);
  const created = Schema.decodeUnknownSync(Webhook)(JSON.parse(result.stdout));
  expect(created.secret).toMatch(/^whsec_/);
  const listed = await invoke(api, ["webhooks", "list", "--inbox", inboxId, "--json"]);
  expect(
    Schema.decodeUnknownSync(ListWebhooksResponse)(JSON.parse(listed.stdout)).webhooks,
  ).toHaveLength(2);
  const update = await invoke(api, [
    "webhooks",
    "update",
    created.webhook_id,
    "--inbox",
    inboxId,
    "--no-enabled",
    "--json",
  ]);
  expect(Schema.decodeUnknownSync(Webhook)(JSON.parse(update.stdout)).enabled).toBe(false);
  expect(
    (
      await invoke(api, [
        "webhooks",
        "update-headers",
        created.webhook_id,
        "--headers",
        '{"X-Trace":"synthetic"}',
      ])
    ).code,
  ).toBe(0);
  const headers = await invoke(api, ["webhooks", "headers", created.webhook_id, "--json"]);
  expect(JSON.parse(headers.stdout)).toEqual({ header_names: ["x-trace"] });
  expect((await invoke(api, ["webhooks", "delete", created.webhook_id])).code).toBe(0);
  expect((await invoke(api, ["webhooks", "get", created.webhook_id])).code).toBe(5);
});

test("events --follow replays typed JSON events through bearer WebSocket and stops on cancellation", async ({
  api,
}) => {
  const previous = await api.run(api.store.use((db) => readEvents(db, 0)));
  const cursor = previous.at(-1)?.event_id;
  if (!cursor) throw new Error("Expected fixture event");
  await api.run(
    api.mailbox.insertMessage({
      inbox_id: inboxId,
      message_id: "<cli-event@example.test>",
      direction: "received",
      from: "sender@example.test",
      to: [inboxId],
      timestamp: "2026-10-10T12:00:00Z",
      text: "Synthetic CLI event",
      raw: Buffer.from("Synthetic raw"),
    }),
  );
  const controller = new AbortController();
  let stdout = "";
  const code = await runCli(
    ["events", "--follow", "--json", "--last-event-id", cursor, "--inbox", inboxId],
    {
      env: { INBOT_HOME: api.home },
      signal: controller.signal,
      stdout: (text) => {
        stdout += text;
        controller.abort();
      },
      stderr: () => {},
    },
  );
  expect(code).toBe(0);
  const event = Schema.decodeUnknownSync(Event)(JSON.parse(stdout));
  expect(event).toMatchObject({
    event_type: "message.received",
    message: { message_id: "<cli-event@example.test>" },
  });
});

test("remote commands use owner REST, validate hostname and preserve agent rejection", async ({
  api,
}) => {
  const initial = await invoke(api, ["remote", "status", "--json"]);
  expect(initial.code).toBe(0);
  expect(JSON.parse(initial.stdout)).toMatchObject({ state: "disabled", hostname: null });
  expect((await invoke(api, ["remote", "enable", "--json"])).code).toBe(2);
  const enabled = await invoke(api, [
    "remote",
    "enable",
    "--hostname",
    "inbot.example.test",
    "--json",
  ]);
  expect(enabled.code).toBe(0);
  expect(JSON.parse(enabled.stdout)).toMatchObject({
    state: "connecting",
    hostname: "inbot.example.test",
  });
  expect(enabled.stdout).not.toContain("token");
  const key = await agent(api);
  const denied = await invoke(api, ["remote", "status"], { env: agentEnv(api, key.api_key) });
  expect(denied.code).toBe(4);
  expect(JSON.parse(denied.stderr)).toMatchObject({ code: "missing_permission" });
  const disabled = await invoke(api, ["remote", "disable", "--json"]);
  expect(disabled.code).toBe(0);
  expect(JSON.parse(disabled.stdout)).toMatchObject({ state: "disabled", hostname: null });
});

test("shows historical unknown sends and resolves only with owner credentials", async ({ api }) => {
  const sent = await api.run(api.outbox.enqueue(inboxId, { kind: "send", request: payload }));
  await api.run(
    api.store.use((db) => {
      db.prepare("UPDATE outbox SET state = 'sending' WHERE message_id = ?").run(sent.message_id);
    }),
  );
  api.advance(5 * 60_000);
  await api.run(api.outbox.processDue());
  const visible = await invoke(api, ["messages", "get", inboxId, sent.message_id]);
  expect(visible.stdout).toContain("send_unknown");
  expect(visible.stdout).toContain("unknown_outcome");
  const key = await agent(api);
  const command = ["messages", "resolve", inboxId, sent.message_id, "--decision", "failed"];
  expect((await invoke(api, command, { env: agentEnv(api, key.api_key) })).code).toBe(4);
  const resolved = await invoke(api, [...command, "--json"]);
  expect(resolved.code).toBe(0);
  expect(Schema.decodeUnknownSync(Message)(JSON.parse(resolved.stdout))).toMatchObject({
    send_status: "failed",
    send_reason: "owner_confirmed_not_sent",
  });
  expect(api.sent).toHaveLength(0);
});

test("owner OAuth CLI lists, purges unused registrations and revokes grants while excluding agent credentials", async ({
  api,
}) => {
  const oauth = makeOAuth(api.store);
  const registered = await api.run(
    oauth.register({
      client_name: "Synthetic CLI client",
      redirect_uris: ["http://127.0.0.1:8765/callback"],
    }),
  );
  await api.run(
    oauth.consent(
      {
        response_type: "code",
        client_id: registered.client_id,
        redirect_uri: registered.redirect_uris[0],
        resource: `${api.url}/mcp`,
        code_challenge_method: "S256",
        code_challenge: "a".repeat(43),
        approved: true,
        grant: {
          inbox_ids: [inboxId],
          permissions: { inbox_read: true },
          send_policy: "read_only",
        },
      },
      api.url,
    ),
  );
  const listed = await invoke(api, ["oauth", "clients", "--json"]);
  expect(listed.code).toBe(0);
  const clients = Schema.decodeUnknownSync(Schema.fromJsonString(OAuthClientsResponse))(
    listed.stdout,
  );
  const approved = clients.grants[0];
  if (!approved) throw new Error("Missing authorized client");
  expect(approved.client_name).toBe("Synthetic CLI client");
  await api.run(oauth.register({ redirect_uris: ["com.example.unused:/callback"] }));
  const purged = await invoke(api, ["oauth", "purge", "--json"]);
  expect(purged.code).toBe(0);
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(PurgeOAuthClientsResponse))(purged.stdout),
  ).toEqual({ deleted_clients: 1 });
  expect((await api.run(oauth.clients())).grants.map((item) => item.grant_id)).toEqual([
    approved.grant_id,
  ]);
  const key = await api.run(
    api.keys.create({ permissions: { inbox_read: true }, send_policy: "read_only" }),
  );
  const agent = await invoke(api, ["oauth", "clients", "--json"], {
    env: { INBOT_URL: api.url, INBOT_API_KEY: key.api_key },
  });
  expect(agent.code).toBe(4);
  expect(JSON.parse(agent.stderr)).toMatchObject({ code: "missing_permission" });
  const agentPurge = await invoke(api, ["oauth", "purge", "--json"], {
    env: { INBOT_URL: api.url, INBOT_API_KEY: key.api_key },
  });
  expect(agentPurge.code).toBe(4);
  expect(JSON.parse(agentPurge.stderr)).toMatchObject({ code: "missing_permission" });
  expect((await invoke(api, ["oauth", "revoke", approved.grant_id])).code).toBe(0);
  const after = await invoke(api, ["oauth", "clients", "--json"]);
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(OAuthClientsResponse))(after.stdout).grants,
  ).toEqual([]);
  expect((await invoke(api, ["inboxes", "list", "--json"])).code).toBe(0);
});

test("lists and deletes owner rejection metadata and denies scoped agents", async ({ api }) => {
  const lists = makeLists(api.store);
  await api.run(lists.create(undefined, "receive", "block", { entry: "blocked.test" }));
  await api.run(
    api.mailbox.acceptInbound(
      inboxId,
      ["sender@blocked.test"],
      Buffer.from("Synthetic rejected mail"),
      "2026-10-11T12:00:00Z",
    ),
  );
  const result = await invoke(api, [
    "lists",
    "rejections",
    "--inbox-id",
    inboxId,
    "--limit",
    "1",
    "--json",
  ]);
  expect(result.code).toBe(0);
  const page = Schema.decodeUnknownSync(ListRejectionsResponse)(JSON.parse(result.stdout));
  expect(page.count).toBe(1);
  expect(page.rejections[0]?.sender_address).toBe("sender@blocked.test");
  expect((await invoke(api, ["lists", "rejections"])).stdout).toContain("SENDER_ADDRESS");
  const key = await api.run(
    api.keys.create({
      inbox_id: inboxId,
      permissions: { list_entry_read: true },
      send_policy: "direct",
    }),
  );
  expect(
    (await invoke(api, ["lists", "rejections"], { env: agentEnv(api, key.api_key) })).code,
  ).toBe(4);
  const removed = await invoke(api, [
    "lists",
    "delete-rejection",
    page.rejections[0]?.rejection_id ?? "",
  ]);
  expect(removed.code).toBe(0);
  expect((await api.run(lists.rejections())).count).toBe(0);
});

base("prints the package version without connecting to a home", async () => {
  const manifest: unknown = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  if (manifest === null || typeof manifest !== "object" || !("version" in manifest))
    throw new Error("Missing version");
  for (const args of [["--version"], ["version"], ["--version", "--flavor", "production"]]) {
    let stdout = "";
    let stderr = "";
    expect(
      await runCli(args, {
        env: {},
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      }),
    ).toBe(0);
    expect(stdout).toBe(`${String(manifest.version)}\n`);
    expect(stderr).toBe("");
  }
  let help = "";
  await runCli(["--help"], {
    env: {},
    stdout: (text) => {
      help += text;
    },
    stderr: () => {},
  });
  expect(help.split("\n")[0]).toContain("inbot --version");
  expect(help).not.toMatch(/^  .*version/m);
});

base("groups overview help logically and keeps group help focused", async () => {
  const readHelp = async (args: string[]) => {
    let text = "";
    expect(
      await runCli(args, {
        env: {},
        stdout: (value) => {
          text += value;
        },
        stderr: () => {},
      }),
    ).toBe(0);
    return text
      .split("\n")
      .filter((line) => line.startsWith("  "))
      .map((line) => line.trim().split(/\s+/).slice(0, 2).join(" "));
  };
  const overview = await readHelp(["--help"]);
  expect(overview[0]).toBe("serve Run");
  expect(overview[1]).toBe("open Print");
  const groups = overview.map((line) => line.split(" ")[0]);
  expect(groups.filter((group, index) => index === 0 || group !== groups[index - 1])).toEqual([
    "serve",
    "open",
    "inboxes",
    "threads",
    "messages",
    "drafts",
    "api-keys",
    "lists",
    "webhooks",
    "credentials",
    "domains",
    "transport",
    "oauth",
    "remote",
    "quarantine",
    "service",
    "update",
    "events",
  ]);
  const lists = await readHelp(["lists", "--help"]);
  expect(lists[0]).toBe("lists list");
  expect(lists).toContain("lists delete-rejection");
  expect(lists.every((line) => line.startsWith("lists "))).toBe(true);
});

test("uses the shared owner-only quarantine endpoints with JSON, table output and stable errors", async ({
  api,
}) => {
  const state = bufferState(api.store, "fake-account", "fake-bucket");
  await api.run(state.quarantineMessage("fake-queue", "invalid", "invalid_pointer"));
  const listed = await invoke(api, ["quarantine", "list", "--json", "--limit", "1"]);
  expect(listed.code).toBe(0);
  const page = Schema.decodeUnknownSync(Schema.fromJsonString(ListQuarantineResponse))(
    listed.stdout,
  );
  const item = page.items[0];
  if (!item) throw new Error("Expected a quarantine item");
  const table = await invoke(api, ["quarantine", "list"]);
  expect(table.stdout).toContain("SOURCE_KIND");
  expect(table.stdout).toContain("invalid_pointer");
  const retry = await invoke(api, ["quarantine", "retry", item.quarantine_id, "--json"]);
  expect(retry.code).toBe(9);
  expect(JSON.parse(retry.stderr)).toMatchObject({ code: "not_supported" });
  const key = await agent(api);
  expect(
    (await invoke(api, ["quarantine", "list", "--json"], { env: agentEnv(api, key.api_key) })).code,
  ).toBe(4);
  for (let index = 0; index < 2; index++) {
    const removed = await invoke(api, ["quarantine", "delete", item.quarantine_id, "--json"]);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toBe("null\n");
  }
});

test("parses credential commands with server generation, metadata output and local owner reveal", async ({
  api,
}) => {
  const key = await api.run(
    api.keys.create({
      inbox_id: inboxId,
      send_policy: "read_only",
      permissions: {
        credential_read: true,
        credential_create: true,
        credential_update: true,
        credential_delete: true,
        credential_totp: true,
      },
    }),
  );
  const overrides = { env: agentEnv(api, key.api_key) };
  const help = await invoke(api, ["credentials", "create", "--help"]);
  expect(help.stdout).toContain("--generate");
  expect(help.stdout).toContain("--rules");
  expect(help.stdout).toContain("shell history");
  const createdResult = await invoke(
    api,
    [
      "credentials",
      "create",
      inboxId,
      "--name",
      "CLI account",
      "--url",
      "https://account.test/login",
      "--origins",
      "https://extra.test",
      "--generate",
      "--rules",
      "minlength: 24; required: upper; required: digit;",
      "--json",
    ],
    overrides,
  );
  expect(createdResult.code).toBe(0);
  const created = Schema.decodeUnknownSync(Credential)(JSON.parse(createdResult.stdout));
  expect(created.refs.password).toBe(`inbot://credentials/${created.credential_id}/password`);
  const revealed = await invoke(api, [
    "credentials",
    "reveal",
    inboxId,
    created.credential_id,
    "--json",
  ]);
  expect(revealed.code).toBe(0);
  const secret = Schema.decodeUnknownSync(CredentialFieldsResponse)(JSON.parse(revealed.stdout))
    .fields.password;
  if (secret === undefined) throw new Error("Expected generated password");
  expect(secret.length).toBeGreaterThanOrEqual(24);
  expect(createdResult.stdout).not.toContain(secret);
  const denied = await invoke(
    api,
    ["credentials", "reveal", inboxId, created.credential_id, "--json"],
    overrides,
  );
  expect(denied.code).toBe(4);
  expect(denied.stderr).toContain("missing_permission");
  expect(denied.stdout).toBe("");
  const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const updated = await invoke(
    api,
    [
      "credentials",
      "update",
      inboxId,
      created.credential_id,
      "--fields",
      JSON.stringify({ totp: seed, recovery_codes: "cli-distinctive-secret" }),
      "--name",
      "Renamed",
      "--json",
    ],
    overrides,
  );
  expect(updated.code).toBe(0);
  expect(updated.stdout).not.toContain(seed);
  expect(updated.stdout).not.toContain("cli-distinctive-secret");
  const totp = await invoke(
    api,
    ["credentials", "totp", inboxId, created.credential_id, "--json"],
    overrides,
  );
  expect(totp.code).toBe(0);
  expect(Schema.decodeUnknownSync(TotpCodeResponse)(JSON.parse(totp.stdout)).code).toMatch(
    /^\d{6}$/,
  );
  const generated = await invoke(
    api,
    [
      "credentials",
      "generate",
      inboxId,
      created.credential_id,
      "--mode",
      "random",
      "--length",
      "32",
      "--json",
    ],
    overrides,
  );
  expect(generated.code).toBe(0);
  expect(Schema.decodeUnknownSync(Credential)(JSON.parse(generated.stdout)).refs.password).toBe(
    created.refs.password,
  );
  for (const command of [
    ["credentials", "get", inboxId, created.credential_id, "--json"],
    ["credentials", "list", "--inbox", inboxId, "--q", "RENAMED", "--json"],
    ["credentials", "list", "--inbox-id", inboxId, "--json"],
    [
      "credentials",
      "update",
      inboxId,
      created.credential_id,
      "--remove-fields",
      "recovery_codes",
      "--json",
    ],
  ]) {
    const result = await invoke(api, command, overrides);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).not.toContain(seed);
    expect(result.stdout).not.toContain("cli-distinctive-secret");
    if (command[1] === "list")
      expect(
        Schema.decodeUnknownSync(ListCredentialsResponse)(JSON.parse(result.stdout)).credentials,
      ).toHaveLength(1);
  }
  expect(
    (
      await invoke(
        api,
        ["credentials", "create", inboxId, "--name", "Invalid", "--rules", "minlength: 20;"],
        overrides,
      )
    ).code,
  ).toBe(2);
  expect(
    (
      await invoke(
        api,
        ["credentials", "create", inboxId, "--generate", "--data", '{"name":"Mixed"}'],
        overrides,
      )
    ).code,
  ).toBe(2);
  const stdin = await invoke(
    api,
    ["credentials", "create", inboxId, "--data-file", "-", "--json"],
    {
      ...overrides,
      readStdin: async () =>
        JSON.stringify({ name: "Stdin account", fields: { api_key: "stdin-distinctive-secret" } }),
    },
  );
  expect(stdin.code).toBe(0);
  expect(stdin.stdout).not.toContain("stdin-distinctive-secret");
  expect(
    (await invoke(api, ["credentials", "delete", inboxId, created.credential_id], overrides)).code,
  ).toBe(0);
  expect(
    (await invoke(api, ["credentials", "get", inboxId, created.credential_id], overrides)).code,
  ).toBe(5);
});
