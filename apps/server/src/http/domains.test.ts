import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, test } from "vitest";
import { Domain, ListDomainsResponse } from "../../../../packages/contracts/src/domains.js";
import { ErrorResponse } from "../../../../packages/contracts/src/errors.js";
import { fixture } from "./test-fixture.js";
import { client } from "../mcp/test-client.js";

test("domain APIs are owner-only, expose plans and BIND text, apply and teardown, and never become MCP tools", async () => {
  const home = await mkdtemp(join(tmpdir(), "inbot-domains-http-"));
  const api = await fixture(home);
  try {
    await api.run(api.transport.set({ account_id: "fake-account", api_token: "synthetic-token" }));
    const key = await api.run(
      api.keys.create({
        inbox_id: "agent@example.test",
        send_policy: "direct",
        permissions: { inbox_read: true },
      }),
    );
    for (const [path, method] of [
      ["/v0/domains", "GET"],
      ["/v0/domains", "POST"],
      ["/v0/domains/missing/apply", "POST"],
      ["/v0/domains/missing/teardown", "POST"],
      ["/v0/domains/missing/verify", "POST"],
      ["/v0/domains/missing/zone-file", "GET"],
    ]) {
      if (path === undefined || method === undefined) throw new Error("Expected route and method");
      const response = await api.request(path, {
        method,
        token: key.api_key,
        ...(method === "POST" ? { body: { domain: "agents.example.test" } } : {}),
      });
      expect(response.status).toBe(403);
      expect(Schema.decodeUnknownSync(ErrorResponse)(await response.json()).code).toBe(
        "missing_permission",
      );
    }
    const created = await api.request("/v0/domains", {
      method: "POST",
      body: { domain: "agents.example.test" },
    });
    expect(created.status).toBe(200);
    const domain = Schema.decodeUnknownSync(Domain)(await created.json());
    expect(domain.status).toBe("NOT_STARTED");
    expect(api.cloud.mutations).toEqual([]);
    const listed = await api.request("/v0/domains");
    expect(
      Schema.decodeUnknownSync(ListDomainsResponse)(await listed.json()).domains[0]?.domain_id,
    ).toBe(domain.domain_id);
    const zone = await api.request(`/v0/domains/${domain.domain_id}/zone-file`);
    expect(zone.headers.get("content-type")).toContain("text/plain");
    expect(await zone.text()).toContain("agents.example.test. 300 IN MX");
    const applied = await api.request(`/v0/domains/${domain.domain_id}/apply`, { method: "POST" });
    expect(applied.status).toBe(200);
    expect(Schema.decodeUnknownSync(Domain)(await applied.json()).status).toBe("VERIFYING");
    const teardown = await api.request(`/v0/domains/${domain.domain_id}/teardown`, {
      method: "POST",
    });
    expect(teardown.status).toBe(200);
    expect(Schema.decodeUnknownSync(Domain)(await teardown.json()).status).toBe("NOT_STARTED");
    expect(
      (await api.request(`/v0/domains/${domain.domain_id}`, { method: "DELETE" })).status,
    ).toBe(200);
    const mcp = await client(api, api.token);
    const { tools } = await mcp.list();
    expect(tools.some((tool) => /domain|provision|teardown/i.test(tool.name))).toBe(false);
  } finally {
    await api.close();
    await rm(home, { recursive: true, force: true });
  }
});
