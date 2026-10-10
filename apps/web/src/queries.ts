import { queryOptions } from "@tanstack/react-query";
import { api } from "./api";

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
