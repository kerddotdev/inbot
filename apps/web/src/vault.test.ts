import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { ApiClient, api } from "./api";
import { credentialQuery, credentialsQuery } from "./queries";

const stamp = "2026-10-14T12:00:00Z";
const id = "a".repeat(32);
const credential = {
  credential_id: id,
  inbox_id: "agent+mail@example.test",
  name: "Example",
  origins: [],
  fields: ["password"],
  refs: { password: `inbot://credentials/${id}/password` },
  created_at: stamp,
  updated_at: stamp,
};
const json = (body: unknown) => Response.json(body);

afterEach(() => vi.restoreAllMocks());

test("credential lists read every page and encode inbox and search filters", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      json({ count: 1, limit: 50, credentials: [credential], next_page_token: "next/1" }),
    )
    .mockResolvedValueOnce(json({ count: 1, limit: 50, credentials: [credential] }));
  const client = new ApiClient(fetcher);
  const result = await client.credentials(
    { inboxId: "agent+mail@example.test", q: "a b" },
    new AbortController().signal,
  );
  expect(result).toHaveLength(2);
  const urls = fetcher.mock.calls.map(([path]) => new URL(String(path), "http://x"));
  expect(urls.map((url) => url.pathname)).toEqual(["/v0/credentials", "/v0/credentials"]);
  expect(urls[0]?.searchParams.get("inbox_id")).toBe("agent+mail@example.test");
  expect(urls[0]?.searchParams.get("q")).toBe("a b");
  expect(urls[1]?.searchParams.get("page_token")).toBe("next/1");
});

test("reveal hits the owner fields route and decodes the values", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(json({ credential_id: id, fields: { password: "synthetic" } }));
  const client = new ApiClient(fetcher);
  expect(await client.revealCredential(credential)).toEqual({
    credential_id: id,
    fields: { password: "synthetic" },
  });
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    `/v0/inboxes/agent%2Bmail%40example.test/credentials/${id}/fields`,
  );
});

test("list and detail queries never call the reveal endpoint", async () => {
  vi.spyOn(api, "credentials").mockResolvedValue([credential]);
  vi.spyOn(api, "credential").mockResolvedValue(credential);
  const reveal = vi.spyOn(api, "revealCredential");
  const client = new QueryClient();
  await client.fetchQuery(credentialsQuery({}));
  await client.fetchQuery(credentialQuery(credential));
  expect(reveal).not.toHaveBeenCalled();
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    ),
  ).not.toContain("synthetic");
  client.clear();
});

test("import and export send the Bitwarden payloads to the owner routes", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ encrypted: false, folders: [], items: [] }))
    .mockResolvedValueOnce(
      json({ imported: 1, skipped: 2, reasons: { duplicate: 2 }, credentials: [credential] }),
    );
  const client = new ApiClient(fetcher);
  await client.exportCredentials("agent+mail@example.test");
  const imported = await client.importCredentials("agent+mail@example.test", "create", {
    items: [{ any: "shape" }],
  });
  expect(imported.reasons).toEqual({ duplicate: 2 });
  expect(
    fetcher.mock.calls.map(([path, init]) => [path, init?.method ?? "GET", init?.body]),
  ).toEqual([
    ["/v0/credentials/export?inbox_id=agent%2Bmail%40example.test", "GET", undefined],
    [
      "/v0/credentials/import?inbox_id=agent%2Bmail%40example.test&on_duplicate=create",
      "POST",
      JSON.stringify({ items: [{ any: "shape" }] }),
    ],
  ]);
});
