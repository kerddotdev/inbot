import { expect, test, vi } from "vitest";
import { ApiClient, ApiError, errorText } from "./api";

const signal = () => new AbortController().signal;
const stamp = "2026-10-10T12:00:00Z";
const key = {
  api_key_id: "key-1",
  name: "Synthetic key",
  prefix: "inbot_prefix",
  permissions: { message_read: true },
  send_policy: "read_only",
  created_at: stamp,
  updated_at: stamp,
};
const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);

test("inbox mutations decode the shared contract, encode addresses, and use restored CSRF", async () => {
  const inbox = {
    pod_id: "local",
    inbox_id: "agent+mail@example.test",
    email: "agent+mail@example.test",
    display_name: "Agent",
    status: "active",
    created_at: stamp,
    updated_at: stamp,
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      json(
        { setup_required: false, authenticated: true, locked: false },
        { headers: { "X-Inbot-CSRF": "inbox-csrf" } },
      ),
    )
    .mockResolvedValueOnce(json(inbox))
    .mockResolvedValueOnce(json({ ...inbox, display_name: "", status: "paused" }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(json({ ...inbox, status: "deleted" }));
  const client = new ApiClient(fetcher);
  await client.status();
  const create = { username: "agent+mail", domain: "example.test", display_name: "Agent" };
  expect(await client.createInbox(create)).toEqual(inbox);
  const update = { display_name: "", status: "paused" } as const;
  expect(await client.updateInbox(inbox.inbox_id, update)).toMatchObject(update);
  await expect(client.deleteInbox(inbox.inbox_id)).resolves.toBeUndefined();
  expect(
    fetcher.mock.calls.slice(1, 4).map(([path, options]) => [path, options?.method, options?.body]),
  ).toEqual([
    ["/v0/inboxes", "POST", JSON.stringify(create)],
    ["/v0/inboxes/agent%2Bmail%40example.test", "PATCH", JSON.stringify(update)],
    ["/v0/inboxes/agent%2Bmail%40example.test", "DELETE", undefined],
  ]);
  for (const [, options] of fetcher.mock.calls.slice(1, 4)) {
    expect(new Headers(options?.headers).get("X-Inbot-CSRF")).toBe("inbox-csrf");
    expect(options?.credentials).toBe("same-origin");
  }
  await expect(client.updateInbox(inbox.inbox_id, update)).rejects.toMatchObject({
    code: "service_unavailable",
  });
});

test.each([
  {
    code: "already_exists",
    message: "This inbox already exists.",
    fix: "Choose another username.",
  },
  {
    code: "validation_error",
    message: "The domain is not verified.",
    fix: "Verify the domain before retrying.",
  },
])("inbox creation preserves $code and its actionable fix", async (wire) => {
  const client = new ApiClient(
    vi.fn<typeof fetch>().mockResolvedValue(json({ name: "InbotError", ...wire }, { status: 400 })),
  );
  await expect(
    client.createInbox({ username: "agent", domain: "example.test" }).catch(errorText),
  ).resolves.toBe(`${wire.message} ${wire.fix}`);
});
test.each(["message", "draft"] as const)(
  "%s attachment downloads use encoded routes, owner cookies, and safe binary responses",
  async (kind) => {
    const metadata = {
      attachment_id: "file/a",
      filename: "sample.html",
      size: 12,
      download_url: "https://inbot.example.test/v0/downloads/signed.ticket",
      expires_at: stamp,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(metadata))
      .mockResolvedValueOnce(
        new Response("<p>file</p>", {
          headers: { "Content-Disposition": "attachment", "Content-Type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(json(metadata))
      .mockResolvedValueOnce(
        json(
          {
            name: "InbotError",
            code: "locked",
            message: "Storage is locked.",
            fix: "Unlock Inbot.",
          },
          { status: 423 },
        ),
      )
      .mockResolvedValueOnce(json(metadata))
      .mockResolvedValueOnce(new Response("<html>Login</html>"));
    const client = new ApiClient(fetcher);
    const load = () =>
      kind === "message"
        ? client.messageAttachment(
            { inbox_id: "agent+test@example.test", message_id: "<message/a>" },
            "file/a",
          )
        : client.draftAttachment(
            { inbox_id: "agent+test@example.test", draft_id: "draft/a" },
            "file/a",
          );
    expect(await (await load()).text()).toBe("<p>file</p>");
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `/v0/inboxes/agent%2Btest%40example.test/${kind === "message" ? "messages/%3Cmessage%2Fa%3E" : "drafts/draft%2Fa"}/attachments/file%2Fa`,
    );
    expect(fetcher.mock.calls[1]).toEqual([
      "/v0/downloads/signed.ticket",
      { method: "GET", credentials: "same-origin", cache: "no-store" },
    ]);
    const listener = vi.fn();
    client.subscribeSession(listener);
    await expect(load()).rejects.toMatchObject({ code: "locked", fix: "Unlock Inbot." });
    expect(listener).toHaveBeenCalledExactlyOnceWith("locked");
    await expect(load()).rejects.toMatchObject({ code: "service_unavailable" });
  },
);

test("restores CSRF from status, attaches it to unsafe requests, and clears it on logout", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      json(
        { setup_required: false, authenticated: true, locked: false },
        { headers: { "X-Inbot-CSRF": "restored-token" } },
      ),
    )
    .mockResolvedValueOnce(json({ count: 1, api_keys: [key] }))
    .mockResolvedValueOnce(json({ ...key, api_key: "one-time-secret" }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  const client = new ApiClient(fetcher);
  await client.status();
  await client.keys(signal());
  await client.createKey({
    name: "Synthetic key",
    inbox_ids: ["agent@example.test"],
    permissions: { message_read: true },
    send_policy: "read_only",
  });
  await client.revokeKey("key-1");
  await client.logout();
  await client.revokeKey("key-2");
  const calls = fetcher.mock.calls.map(([path, options]) => ({
    path,
    method: options?.method,
    csrf: new Headers(options?.headers).get("X-Inbot-CSRF"),
    credentials: options?.credentials,
  }));
  expect(calls).toEqual([
    { path: "/v0/owner/status", method: "GET", csrf: null, credentials: "same-origin" },
    { path: "/v0/api-keys?limit=50", method: "GET", csrf: null, credentials: "same-origin" },
    { path: "/v0/api-keys", method: "POST", csrf: "restored-token", credentials: "same-origin" },
    {
      path: "/v0/api-keys/key-1",
      method: "DELETE",
      csrf: "restored-token",
      credentials: "same-origin",
    },
    {
      path: "/v0/owner/logout",
      method: "POST",
      csrf: "restored-token",
      credentials: "same-origin",
    },
    { path: "/v0/api-keys/key-2", method: "DELETE", csrf: null, credentials: "same-origin" },
  ]);
  expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toMatchObject({
    inbox_ids: ["agent@example.test"],
    send_policy: "read_only",
  });
});

test("preserves actionable wire errors, rejects malformed responses, and only expires protected sessions", async () => {
  const wire = {
    name: "Unauthorized",
    code: "unauthorized",
    message: "This session has expired.",
    fix: "Sign in again.",
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json(wire, { status: 401 }))
    .mockResolvedValueOnce(json(wire, { status: 401 }))
    .mockResolvedValueOnce(json({ setup_required: "no", authenticated: false, locked: false }))
    .mockResolvedValueOnce(new Response("private invalid response", { status: 500 }));
  const client = new ApiClient(fetcher);
  const listener = vi.fn();
  client.subscribeSession(listener);
  await expect(client.authenticate({ password: "synthetic password" })).rejects.toMatchObject({
    code: wire.code,
    message: wire.message,
    fix: wire.fix,
  });
  expect(listener).not.toHaveBeenCalled();
  try {
    await client.keys(signal());
  } catch (error) {
    expect(errorText(error)).toBe(`${wire.message} ${wire.fix}`);
  }
  expect(listener).toHaveBeenCalledExactlyOnceWith("unauthorized");
  await expect(client.status()).rejects.toBeInstanceOf(ApiError);
  await expect(client.status()).rejects.toMatchObject({ code: "service_unavailable" });
});

test("reads every draft page before filtering pending approvals and encodes cursor tokens", async () => {
  const draft = {
    inbox_id: "agent@example.test",
    draft_id: "pending-2",
    labels: [],
    updated_at: stamp,
    pending_approval: true,
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      json({
        count: 1,
        drafts: [{ ...draft, draft_id: "not-pending", pending_approval: false }],
        next_page_token: "cursor +/&",
      }),
    )
    .mockResolvedValueOnce(json({ count: 1, drafts: [draft] }));
  expect(await new ApiClient(fetcher).pendingDrafts(signal())).toEqual([draft]);
  expect(fetcher.mock.calls[1]?.[0]).toBe("/v0/drafts?limit=50&page_token=cursor+%2B%2F%26");
});

test("encoded identifiers and repeated sends retain the supplied idempotency key", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => json({ message_id: "message-1", thread_id: "thread-1" }));
  const client = new ApiClient(fetcher);
  for (let i = 0; i < 2; i++)
    await client.reply(
      "agent+test@example.test",
      "<source/a>",
      { text: "Synthetic reply" },
      "retry-key",
    );
  for (const [path, options] of fetcher.mock.calls) {
    expect(path).toBe("/v0/inboxes/agent%2Btest%40example.test/messages/%3Csource%2Fa%3E/reply");
    expect(new Headers(options?.headers).get("Idempotency-Key")).toBe("retry-key");
  }
});

const domain = {
  domain_id: "domain/a",
  domain: "agents.example.test",
  inbound_enabled: true,
  feedback_enabled: false,
  tracking_enabled: false,
  subdomains_enabled: false,
  created_at: stamp,
  updated_at: stamp,
  status: "NOT_STARTED",
  reason: "DNS preview is incomplete until apply.",
  records: [
    {
      type: "TXT",
      name: "key.agents.example.test",
      value: "",
      status: "MISSING",
      reason: "Assigned during apply.",
    },
    {
      type: "MX",
      name: "agents.example.test",
      value: "mx.example.test",
      priority: 10,
      status: "INVALID",
      reason: "Wrong priority.",
    },
  ],
};

test("decodes domain records, paginates registrations, and rejects unknown verification states", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ count: 1, domains: [domain], next_page_token: "next/+" }))
    .mockResolvedValueOnce(json({ count: 0, domains: [] }))
    .mockResolvedValueOnce(json(domain))
    .mockResolvedValueOnce(json({ ...domain, status: "SENT" }));
  const client = new ApiClient(fetcher);
  expect(await client.domains(signal())).toHaveLength(1);
  expect(fetcher.mock.calls[1]?.[0]).toBe("/v0/domains?limit=50&page_token=next%2F%2B");
  expect(await client.domain(domain.domain_id, signal())).toEqual(domain);
  await expect(client.domain(domain.domain_id)).rejects.toMatchObject({
    code: "service_unavailable",
  });
});

test("verify accepts an empty 200 then retrieves observed state with session CSRF", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      json(
        { setup_required: false, authenticated: true, locked: false },
        { headers: { "X-Inbot-CSRF": "csrf" } },
      ),
    )
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(
      json({
        ...domain,
        status: "VERIFYING",
        reason: "Waiting for the encrypted self-test message.",
      }),
    );
  const client = new ApiClient(fetcher);
  await client.status();
  expect(await client.verifyDomain(domain.domain_id)).toMatchObject({
    status: "VERIFYING",
    reason: "Waiting for the encrypted self-test message.",
  });
  expect(fetcher.mock.calls.slice(1).map(([path, options]) => [path, options?.method])).toEqual([
    ["/v0/domains/domain%2Fa/verify", "POST"],
    ["/v0/domains/domain%2Fa", "GET"],
  ]);
  expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("X-Inbot-CSRF")).toBe("csrf");
});

test("domain actions preserve transport and action-required fixes without claiming success", async () => {
  const wire = {
    name: "ProvisionError",
    code: "action_required",
    message: "Apex DNS changed.",
    fix: "Restore the recorded snapshot.",
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json(wire, { status: 409 }))
    .mockResolvedValueOnce(
      json(
        {
          ...wire,
          code: "service_unavailable",
          message: "Transport is not configured.",
          fix: "Configure Cloudflare transport.",
        },
        { status: 503 },
      ),
    );
  const client = new ApiClient(fetcher);
  await expect(client.applyDomain(domain.domain_id)).rejects.toMatchObject({
    code: wire.code,
    message: wire.message,
    fix: wire.fix,
  });
  await expect(client.createDomain({ domain: domain.domain })).rejects.toMatchObject({
    code: "service_unavailable",
    fix: "Configure Cloudflare transport.",
  });
  expect(fetcher.mock.calls).toHaveLength(2);
});

test.each(["create", "apply", "verify", "teardown"] as const)(
  "%s settles a validation error with the server's message and fix",
  async (action) => {
    const wire = {
      name: "ProvisionError",
      code: "validation_error",
      message: "Configure a Cloudflare transport token first.",
      fix: "Configure the Cloudflare mail transport in Settings, then register the domain again.",
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(wire, { status: 400 }));
    const client = new ApiClient(fetcher);
    const request =
      action === "create"
        ? client.createDomain({ domain: domain.domain })
        : action === "apply"
          ? client.applyDomain(domain.domain_id)
          : action === "verify"
            ? client.verifyDomain(domain.domain_id)
            : client.teardownDomain(domain.domain_id);
    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({
      code: wire.code,
      message: wire.message,
      fix: wire.fix,
    });
    await expect(request.catch(errorText)).resolves.toBe(`${wire.message} ${wire.fix}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

test("zone files are authenticated blobs and use the same error and session-expiry decoding", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response("; BIND export\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } }),
    )
    .mockResolvedValueOnce(
      json(
        {
          name: "Unauthorized",
          code: "unauthorized",
          message: "Session expired.",
          fix: "Sign in again.",
        },
        { status: 401 },
      ),
    )
    .mockResolvedValueOnce(
      new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } }),
    );
  const client = new ApiClient(fetcher);
  const listener = vi.fn();
  client.subscribeSession(listener);
  expect(await (await client.domainZoneFile(domain.domain_id)).text()).toBe("; BIND export\n");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    credentials: "same-origin",
    cache: "no-store",
  });
  await expect(client.domainZoneFile(domain.domain_id)).rejects.toMatchObject({
    code: "unauthorized",
    fix: "Sign in again.",
  });
  expect(listener).toHaveBeenCalledExactlyOnceWith("unauthorized");
  await expect(client.domainZoneFile(domain.domain_id)).rejects.toMatchObject({
    code: "service_unavailable",
  });
});

test("decodes provisioning plans with warnings and unknown records, and preserves missing-route errors", async () => {
  const plan = {
    domain: domain.domain,
    steps: ["Verify token", "Create sending subdomain"],
    warnings: ["DNS preview is incomplete."],
    records: domain.records,
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json(plan))
    .mockResolvedValueOnce(
      json(
        {
          name: "InbotError",
          code: "not_found",
          message: "The requested route was not found.",
          fix: "Use a declared /v0 API route.",
        },
        { status: 404 },
      ),
    );
  const client = new ApiClient(fetcher);
  expect(await client.domainPlan(domain.domain_id)).toEqual(plan);
  expect(fetcher.mock.calls[0]?.[0]).toBe("/v0/domains/domain%2Fa/plan");
  await expect(client.domainPlan(domain.domain_id)).rejects.toMatchObject({
    code: "not_found",
    message: "The requested route was not found.",
  });
});

test("list management encodes entries, decodes scoped responses, paginates and includes CSRF", async () => {
  const entry = {
    entry: "User+tag@example.test",
    organization_id: "local",
    entry_type: "email",
    direction: "send",
    list_type: "block",
    created_at: stamp,
  };
  const scoped = { ...entry, pod_id: "local", inbox_id: "agent@example.test" };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      json(
        { setup_required: false, authenticated: true, locked: false },
        { headers: { "X-Inbot-CSRF": "list-csrf" } },
      ),
    )
    .mockResolvedValueOnce(
      json({ entries: [entry], count: 1, limit: 50, next_page_token: "next-token" }),
    )
    .mockResolvedValueOnce(json({ entries: [scoped], count: 1, limit: 50 }))
    .mockResolvedValueOnce(json(scoped))
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  const client = new ApiClient(fetcher);
  await client.status();
  expect(
    (await client.listEntries({ direction: "send", type: "block" }, null, signal()))
      .next_page_token,
  ).toBe("next-token");
  const selection = { inboxId: "agent@example.test", direction: "send", type: "block" } as const;
  expect((await client.listEntries(selection, "next-token", signal())).entries[0]).toMatchObject(
    scoped,
  );
  expect(await client.createListEntry(selection, { entry: entry.entry })).toEqual(scoped);
  await client.deleteListEntry(selection, entry.entry);
  const paths = fetcher.mock.calls.map(([path]) => path);
  expect(paths).toEqual([
    "/v0/owner/status",
    "/v0/lists/send/block?limit=50",
    "/v0/inboxes/agent%40example.test/lists/send/block?limit=50&page_token=next-token",
    "/v0/inboxes/agent%40example.test/lists/send/block",
    "/v0/inboxes/agent%40example.test/lists/send/block/User%2Btag%40example.test",
  ]);
  for (const call of fetcher.mock.calls.slice(3))
    expect(new Headers(call[1]?.headers).get("X-Inbot-CSRF")).toBe("list-csrf");
});

test("remote actions decode shared status and send hostname with restored CSRF", async () => {
  const remote = { state: "disabled", hostname: null, reason: null, connector_version: "2026.9.1" };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      json(
        { setup_required: false, authenticated: true, locked: false },
        { headers: { "X-Inbot-CSRF": "synthetic-csrf" } },
      ),
    )
    .mockResolvedValueOnce(json(remote))
    .mockResolvedValueOnce(json({ ...remote, state: "connecting", hostname: "inbot.example.test" }))
    .mockResolvedValueOnce(json(remote));
  const client = new ApiClient(fetcher);
  await client.status();
  expect(await client.remote(signal())).toEqual(remote);
  await client.enableRemote("inbot.example.test");
  await client.disableRemote();
  const enable = fetcher.mock.calls[2];
  expect(enable?.[0]).toBe("/v0/owner/remote/enable");
  expect(enable?.[1]?.body).toBe(JSON.stringify({ hostname: "inbot.example.test" }));
  expect(new Headers(enable?.[1]?.headers).get("X-Inbot-CSRF")).toBe("synthetic-csrf");
  expect(fetcher.mock.calls[3]?.[0]).toBe("/v0/owner/remote/disable");
});

test("OAuth consent and management use shared contracts, cookie authentication and session CSRF", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      json(
        { setup_required: false, authenticated: true, locked: false },
        { headers: { "X-Inbot-CSRF": "consent-csrf" } },
      ),
    )
    .mockResolvedValueOnce(json({ grants: [] }))
    .mockResolvedValueOnce(
      json({
        client_name: "<untrusted>",
        redirect_host: "client.example.test",
        resource: "https://inbot.example.test/mcp",
      }),
    )
    .mockResolvedValueOnce(json({ redirect_uri: "https://client.example.test/cb?code=synthetic" }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(json({ deleted_clients: 3 }));
  const client = new ApiClient(fetcher);
  await client.status();
  await client.oauthClients();
  const input = {
    response_type: "code",
    client_id: "a".repeat(32),
    redirect_uri: "https://client.example.test/cb",
    resource: "https://inbot.example.test/mcp",
    code_challenge_method: "S256",
    code_challenge: "z".repeat(43),
  } as const;
  expect((await client.oauthDetails(input)).client_name).toBe("<untrusted>");
  await client.oauthConsent({
    ...input,
    approved: true,
    grant: {
      inbox_ids: ["agent@example.test"],
      permissions: { message_read: true },
      send_policy: "read_only",
    },
  });
  await client.revokeOAuthGrant("b".repeat(32));
  expect(await client.purgeOAuthClients()).toEqual({ deleted_clients: 3 });
  expect(fetcher.mock.calls[5]?.[0]).toBe("/v0/owner/oauth/clients/purge");
  expect(fetcher.mock.calls[5]?.[1]?.method).toBe("POST");
  for (const [path, options] of fetcher.mock.calls.slice(2)) {
    expect(String(path)).toMatch(/oauth/);
    expect(options?.credentials).toBe("same-origin");
    expect(new Headers(options?.headers).get("X-Inbot-CSRF")).toBe("consent-csrf");
    expect(new Headers(options?.headers).has("Authorization")).toBe(false);
  }
});

test("OAuth protocol errors remain actionable in the consent UI", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    json(
      {
        error: "access_denied",
        error_description: "Owner consent requires a browser session and the exact server Origin.",
      },
      { status: 403 },
    ),
  );
  const client = new ApiClient(fetcher);
  const input = {
    response_type: "code",
    client_id: "a".repeat(32),
    redirect_uri: "https://client.example.test/cb",
    resource: "https://inbot.example.test/mcp",
    code_challenge_method: "S256",
    code_challenge: "z".repeat(43),
  } as const;
  await expect(client.oauthDetails(input)).rejects.toMatchObject({
    code: "missing_permission",
    message: "Owner consent requires a browser session and the exact server Origin.",
  });
});
