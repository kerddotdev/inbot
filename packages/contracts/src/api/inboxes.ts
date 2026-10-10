import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import * as Common from "../common.js";
import * as Errors from "../errors.js";
import * as Inboxes from "../inboxes.js";
import { BearerAuth, RequiredPermission } from "../security.js";

export const InboxesApi = HttpApiGroup.make("inboxes")
  .add(
    HttpApiEndpoint.get("inboxes_list", "/v0/inboxes", {
      query: Common.PaginationQuery,
      success: Inboxes.ListInboxesResponse,
      error: Errors.ListErrors,
    }).annotate(RequiredPermission, "inbox_read"),
    HttpApiEndpoint.post("inboxes_create", "/v0/inboxes", {
      payload: Inboxes.CreateInboxRequest,
      success: Inboxes.Inbox,
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "inbox_create"),
    HttpApiEndpoint.get("inboxes_search", "/v0/inboxes/search", {
      query: Common.SearchInboxesQuery,
      success: Inboxes.SearchInboxesResponse,
      error: Errors.ListErrors,
    }).annotate(RequiredPermission, "inbox_read"),
    HttpApiEndpoint.get("inboxes_get", "/v0/inboxes/:inbox_id", {
      params: { inbox_id: Common.InboxId },
      success: Inboxes.Inbox,
      error: Errors.ReadErrors,
    }).annotate(RequiredPermission, "inbox_read"),
    HttpApiEndpoint.patch("inboxes_update", "/v0/inboxes/:inbox_id", {
      params: { inbox_id: Common.InboxId },
      payload: Inboxes.UpdateInboxRequest,
      success: Inboxes.Inbox,
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "inbox_update"),
    HttpApiEndpoint.delete("inboxes_delete", "/v0/inboxes/:inbox_id", {
      params: { inbox_id: Common.InboxId },
      success: HttpApiSchema.Empty(200),
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "inbox_delete"),
  )
  .middleware(BearerAuth);
