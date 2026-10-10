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
