import { queryOptions } from "@tanstack/react-query";
import { api, type ListSelection } from "./api";

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
