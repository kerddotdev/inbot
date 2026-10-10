import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { OwnerLoginLink } from "../../../../packages/contracts/src/owner.js";
import { expect, test } from "vitest";
import { ApiClient } from "../../../web/src/api.js";
import { fixture } from "./test-fixture.js";

const signal = () => new AbortController().signal;

test("browser client uses real owner sessions for mail, keys, approvals, transport, and scheduled results", async () => {
  const home = await mkdtemp(join(tmpdir(), "inbot-web-client-"));
  let server: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    server = await fixture(home);
    const api = server;
    let cookie = "";
    const browserFetch: typeof fetch = async (path, options) => {
      const headers = new Headers(options?.headers);
      headers.set("Origin", api.url);
      if (cookie) headers.set("Cookie", cookie);
      const response = await fetch(`${api.url}${String(path)}`, { ...options, headers });
      const next = response.headers.get("set-cookie");
      if (next !== null) cookie = next.split(";")[0] ?? "";
      return response;
    };
    const client = new ApiClient(browserFetch);
    expect(await client.status()).toEqual({
      setup_required: true,
      authenticated: false,
      locked: false,
    });
    if (!api.setupCode) throw new Error("Expected a setup code");
    await client.authenticate({ code: api.setupCode, password: "synthetic web password" });
    expect((await client.inboxes(signal())).map((inbox) => inbox.inbox_id)).toContain(
      "agent@example.test",
    );
    const reloaded = new ApiClient(browserFetch);
    expect((await reloaded.status()).authenticated).toBe(true);
    expect((await reloaded.transport(signal())).verification_status).toBe("not_configured");
    const transport = await reloaded.configureTransport({
      account_id: "a".repeat(32),
      api_token: "synthetic-web-token",
    });
    expect(transport).toMatchObject({ token_set: true, verification_status: "verified" });
    expect(transport).not.toHaveProperty("api_token");
    expect(await reloaded.transport(signal())).toEqual(transport);
    await reloaded.clearTransport();
    expect((await reloaded.transport(signal())).token_set).toBe(false);
    const selection = {
      direction: "receive",
      type: "block",
      inboxId: "agent@example.test",
    } as const;
    const entry = await reloaded.createListEntry(selection, {
      entry: "EXAMPLE.TEST",
      reason: "Synthetic browser rule",
    });
    expect(entry.entry).toBe("example.test");
    expect((await reloaded.listEntries(selection, null, signal())).entries).toEqual([entry]);
    expect(
      (await reloaded.listEntries({ direction: "receive", type: "block" }, null, signal())).entries,
    ).toEqual([]);
    await reloaded.deleteListEntry(selection, entry.entry);
    expect((await reloaded.listEntries(selection, null, signal())).entries).toEqual([]);
    const threads = await reloaded.threads("agent@example.test", null, signal());
    const thread = await reloaded.thread("agent@example.test", api.threadId, null, signal());
    expect(threads.threads.map((item) => item.thread_id)).toContain(thread.thread_id);
    expect(thread.messages[0]?.text).toContain("searchable project message");
    await reloaded.updateThread(thread.inbox_id, thread.thread_id, {
      remove_labels: ["unread"],
      add_labels: ["reviewed"],
    });
    expect(
      (await reloaded.thread(thread.inbox_id, thread.thread_id, null, signal())).labels,
    ).toContain("reviewed");
    const unknown = await api.run(
      api.outbox.enqueue("agent@example.test", {
        kind: "send",
        request: { to: "recipient@example.test", text: "Synthetic uncertainty" },
      }),
    );
    await api.run(
      api.store.use((db) =>
        db
          .prepare(
            "UPDATE outbox SET state = 'sending', updated_at = updated_at - ? WHERE message_id = ?",
          )
          .run(5 * 60_000, unknown.message_id),
      ),
    );
    await api.run(api.outbox.processDue());
    const uncertain = await reloaded.thread(
      "agent@example.test",
      unknown.thread_id,
      null,
      signal(),
    );
    expect(uncertain.messages[0]?.send_status).toBe("send_unknown");
    expect(
      await reloaded.resolveMessage("agent@example.test", unknown.message_id, {
        decision: "failed",
      }),
    ).toMatchObject({ send_status: "failed", send_reason: "owner_confirmed_not_sent" });
    expect(api.sent).toHaveLength(0);
    const created = await reloaded.createKey({
      name: "Synthetic web key",
      inbox_ids: ["agent@example.test"],
      permissions: { message_read: true, draft_read: true, draft_create: true, draft_send: true },
      send_policy: "approval",
    });
    expect(created.api_key).toMatch(/^inbot_/);
    expect((await reloaded.keys(signal()))[0]).not.toHaveProperty("api_key");
    const response = await api.request("/v0/inboxes/agent@example.test/drafts", {
      token: created.api_key,
      method: "POST",
      body: { to: ["recipient@example.test"], text: "Synthetic review", subject: "Review" },
    });
    expect(response.ok).toBe(true);
    const pending = await reloaded.pendingDrafts(signal());
    expect(pending).toHaveLength(1);
    const first = pending[0];
    if (!first) throw new Error("Expected a pending draft");
    expect((await reloaded.draft(first.draft_id, signal())).text).toBe("Synthetic review");
    await reloaded.reject(first, "Synthetic rejection");
    expect(await reloaded.pendingDrafts(signal())).toHaveLength(0);
    await api.run(api.transport.set({ account_id: "fake", api_token: "fake" }));
    const registered = await reloaded.createDomain({ domain: "agents.example.test" });
    expect(registered.status).toBe("NOT_STARTED");
    expect((await reloaded.domains(signal()))[0]?.domain_id).toBe(registered.domain_id);
    expect(await reloaded.domain(registered.domain_id, signal())).toEqual(registered);
    expect(await (await reloaded.domainZoneFile(registered.domain_id)).text()).toContain(" IN MX ");
    expect(
      await reloaded.updateDomain(registered.domain_id, { inbound_enabled: true }),
    ).toMatchObject({ inbound_enabled: true });
    await expect(
      reloaded.updateDomain(registered.domain_id, { tracking_enabled: true }),
    ).rejects.toMatchObject({ code: "validation_error" });
    expect((await reloaded.applyDomain(registered.domain_id)).status).toBe("VERIFYING");
    expect((await reloaded.verifyDomain(registered.domain_id)).status).toBe("VERIFYING");
    await expect(reloaded.deleteDomain(registered.domain_id)).rejects.toMatchObject({
      code: "validation_error",
    });
    expect((await reloaded.teardownDomain(registered.domain_id)).status).toBe("NOT_STARTED");
    await reloaded.deleteDomain(registered.domain_id);
    expect(await reloaded.domains(signal())).toEqual([]);
    const scheduled = await api.request("/v0/inboxes/agent@example.test/drafts", {
      token: created.api_key,
      method: "POST",
      body: {
        to: ["recipient@example.test"],
        text: "Synthetic scheduled review",
        send_at: "2026-10-11T12:00:00Z",
      },
    });
    expect(scheduled.ok).toBe(true);
    const next = (await reloaded.pendingDrafts(signal()))[0];
    if (!next) throw new Error("Expected a scheduled pending draft");
    expect(await reloaded.approve(next, "scheduled-approval")).toMatchObject({
      draft_id: next.draft_id,
      send_status: "scheduled",
    });
    const sent = await reloaded.send(
      "agent@example.test",
      { to: ["recipient@example.test"], text: "Synthetic send" },
      "web-send",
    );
    const replay = await reloaded.send(
      "agent@example.test",
      { to: ["recipient@example.test"], text: "Synthetic send" },
      "web-send",
    );
    expect(replay).toEqual(sent);
    const incoming = thread.messages[0];
    if (!incoming) throw new Error("Expected an incoming message");
    const reply = await reloaded.reply(
      "agent@example.test",
      incoming.message_id,
      { text: "Synthetic reply" },
      "web-reply",
    );
    expect(reply.thread_id).toBe(thread.thread_id);
    expect(api.sent).toHaveLength(0);
    await reloaded.revokeKey(created.api_key_id);
    expect(await reloaded.keys(signal())).toHaveLength(0);
    await reloaded.logout();
    expect((await reloaded.status()).authenticated).toBe(false);
    await reloaded.authenticate({ password: "synthetic web password" });
    expect((await reloaded.status()).authenticated).toBe(true);
    const link = Schema.decodeUnknownSync(OwnerLoginLink)(
      await (await api.request("/v0/owner/login-links", { method: "POST" })).json(),
    );
    const linkToken = new URL(link.url).searchParams.get("token");
    if (!linkToken) throw new Error("Expected a single-use login token");
    await reloaded.logout();
    await reloaded.redeem(linkToken);
    expect((await reloaded.status()).authenticated).toBe(true);
    await expect(reloaded.redeem(linkToken)).rejects.toMatchObject({ code: "unauthorized" });
  } finally {
    await server?.close();
    await rm(home, { recursive: true, force: true });
  }
});
