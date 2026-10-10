import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { api } from "./api";
import { approvalsQuery } from "./queries";

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
