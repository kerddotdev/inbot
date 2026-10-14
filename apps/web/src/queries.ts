import { queryOptions } from "@tanstack/react-query";
import { api, type ListSelection } from "./api";

export const quarantineQuery = (pageToken: string | null) =>
  queryOptions({
    queryKey: ["quarantine", pageToken],
    queryFn: ({ signal }) => api.quarantine(pageToken, signal),
    staleTime: 0,
  });

export const rejectionsQuery = (inboxId: string | undefined, pageToken: string | null) =>
  queryOptions({
    queryKey: ["rejections", inboxId, pageToken],
    queryFn: ({ signal }) => api.rejections(inboxId, pageToken, signal),
    staleTime: 0,
  });

export const listEntriesQuery = (selection: ListSelection, pageToken: string | null) =>
  queryOptions({
    queryKey: ["lists", selection, pageToken],
    queryFn: ({ signal }) => api.listEntries(selection, pageToken, signal),
    staleTime: 0,
  });

export const inboxesQuery = queryOptions({
  queryKey: ["inboxes"],
  queryFn: ({ signal }) => api.inboxes(signal),
});

export const approvalsQuery = queryOptions({
  queryKey: ["approvals"],
  queryFn: ({ signal }) => api.pendingDrafts(signal),
  staleTime: 0,
});

export const keysQuery = queryOptions({
  queryKey: ["keys"],
  queryFn: ({ signal }) => api.keys(signal),
});

export const transportQuery = queryOptions({
  queryKey: ["transport"],
  queryFn: ({ signal }) => api.transport(signal),
  staleTime: 0,
});

export const domainsQuery = queryOptions({
  queryKey: ["domains"],
  queryFn: ({ signal }) => api.domains(signal),
});

export const verifiedDomainsQuery = queryOptions({
  queryKey: ["domains", { status: "VERIFIED" }],
  queryFn: async ({ signal }) => {
    const domains = await api.domains(signal);
    const details = await Promise.all(
      domains.map((domain) => api.domain(domain.domain_id, signal)),
    );
    return details.filter((domain) => domain.status === "VERIFIED");
  },
  staleTime: 0,
});

export const domainQuery = (id: string) =>
  queryOptions({
    queryKey: ["domains", id],
    queryFn: ({ signal }) => api.domain(id, signal),
    staleTime: 0,
  });

export const webhooksQuery = queryOptions({
  queryKey: ["webhooks"],
  queryFn: ({ signal }) => api.webhooks(signal),
  staleTime: 0,
});

export const remoteQuery = queryOptions({
  queryKey: ["remote"],
  queryFn: ({ signal }) => api.remote(signal),
  staleTime: 0,
  refetchInterval: (query) =>
    query.state.error ||
    query.state.data?.state === "disabled" ||
    query.state.data?.state === "action_required"
      ? false
      : 2000,
});

export const updatesQuery = queryOptions({
  queryKey: ["updates"],
  queryFn: ({ signal }) => api.updates(signal),
  staleTime: 0,
  refetchInterval: 30_000,
});
