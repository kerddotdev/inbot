import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { api } from "./api";
import { approvalsQuery, verifiedDomainsQuery } from "./queries";
import { ApiError } from "./api";
import type { Domain } from "@inbot/contracts/src/domains.js";

const domain: Domain = {
  domain_id: "verified",
  domain: "agents.example.test",
  feedback_enabled: false,
  subdomains_enabled: false,
  tracking_enabled: false,
  created_at: "2026-10-11T12:00:00Z",
  updated_at: "2026-10-11T12:00:00Z",
  status: "VERIFIED",
  records: [],
};

test("inbox creation offers only domains whose detail response is VERIFIED", async () => {
  const details: readonly Domain[] = [
    domain,
    ...(["NOT_STARTED", "PENDING", "INVALID", "FAILED", "VERIFYING"] as const).map((status) => ({
      ...domain,
      domain_id: status,
      status,
    })),
  ];
  vi.spyOn(api, "domains").mockResolvedValue(
    details.map(({ status: _status, records: _records, ...item }) => item),
  );
  const load = vi.spyOn(api, "domain").mockImplementation(async (id) => {
    const detail = details.find((item) => item.domain_id === id);
    if (!detail) throw new Error("Unknown test domain");
    return detail;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    expect(await client.fetchQuery(verifiedDomainsQuery)).toEqual([domain]);
    expect(load).toHaveBeenCalledTimes(details.length);
    for (const [, signal] of load.mock.calls) expect(signal).toBeInstanceOf(AbortSignal);
  } finally {
    client.clear();
    vi.restoreAllMocks();
  }
});

test("a failed domain verification lookup remains an actionable error instead of an empty list", async () => {
  vi.spyOn(api, "domains").mockResolvedValue([domain]);
  const error = new ApiError(
    "service_unavailable",
    "Verification lookup failed.",
    "Retry domains.",
  );
  vi.spyOn(api, "domain").mockRejectedValue(error);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await expect(client.fetchQuery(verifiedDomainsQuery)).rejects.toBe(error);
    expect(client.getQueryState(verifiedDomainsQuery.queryKey)?.error).toBe(error);
  } finally {
    client.clear();
    vi.restoreAllMocks();
  }
});

test("opening approvals refreshes the sidebar's cached list after an agent creates a draft", async () => {
  const pending = [
    {
      inbox_id: "agent@example.test",
      draft_id: "new-draft",
      labels: [],
      pending_approval: true,
      updated_at: "2026-10-10T12:00:00Z",
    },
  ];
  const load = vi
    .spyOn(api, "pendingDrafts")
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(pending);
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: 15_000, retry: false } },
  });
  const sidebar = new QueryObserver(client, approvalsQuery);
  const screen = new QueryObserver(client, approvalsQuery);
  const unsubscribe = sidebar.subscribe(() => {});
  try {
    await client.fetchQuery(approvalsQuery);
    expect(sidebar.getCurrentResult().data).toEqual([]);
    const fresh = await new Promise((resolve, reject) => {
      screen.subscribe((result) => {
        if (result.error) reject(result.error);
        else if (result.data?.length) resolve(result.data);
      });
    });
    expect(fresh).toEqual(pending);
    expect(sidebar.getCurrentResult().data).toEqual(pending);
    expect(load).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
    sidebar.destroy();
    screen.destroy();
    client.clear();
    vi.restoreAllMocks();
  }
});
