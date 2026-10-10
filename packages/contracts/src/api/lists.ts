import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import * as Common from "../common.js";
import * as Errors from "../errors.js";
import * as Lists from "../lists.js";
import { BearerAuth, RequiredPermission } from "../security.js";

export const ListsApi = HttpApiGroup.make("lists")
  .add(
    HttpApiEndpoint.get("inboxes_lists_list", "/v0/inboxes/:inbox_id/lists/:direction/:type", {
      params: { inbox_id: Common.InboxId, direction: Lists.Direction, type: Lists.ListType },
      query: Common.CursorQuery,
      success: Lists.PodListListEntriesResponse,
      error: Errors.ListErrors,
    }).annotate(RequiredPermission, "list_entry_read"),
    HttpApiEndpoint.post("inboxes_lists_create", "/v0/inboxes/:inbox_id/lists/:direction/:type", {
      params: { inbox_id: Common.InboxId, direction: Lists.Direction, type: Lists.ListType },
      payload: Lists.CreateListEntryRequest,
      success: Lists.PodListEntry,
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "list_entry_create"),
    HttpApiEndpoint.get(
      "inboxes_lists_get",
      "/v0/inboxes/:inbox_id/lists/:direction/:type/:entry",
      {
        params: {
          inbox_id: Common.InboxId,
          direction: Lists.Direction,
          type: Lists.ListType,
          entry: Schema.String,
        },
        success: Lists.PodListEntry,
        error: Errors.ReadErrors,
      },
    ).annotate(RequiredPermission, "list_entry_read"),
    HttpApiEndpoint.delete(
      "inboxes_lists_delete",
      "/v0/inboxes/:inbox_id/lists/:direction/:type/:entry",
      {
        params: {
          inbox_id: Common.InboxId,
          direction: Lists.Direction,
          type: Lists.ListType,
          entry: Schema.String,
        },
        success: HttpApiSchema.Empty(200),
        error: Errors.WriteErrors,
      },
    ).annotate(RequiredPermission, "list_entry_delete"),
    HttpApiEndpoint.get("lists_list", "/v0/lists/:direction/:type", {
      params: { direction: Lists.Direction, type: Lists.ListType },
      query: Common.CursorQuery,
      success: Lists.ListListEntriesResponse,
      error: Errors.ListErrors,
    }).annotate(RequiredPermission, "list_entry_read"),
    HttpApiEndpoint.post("lists_create", "/v0/lists/:direction/:type", {
      params: { direction: Lists.Direction, type: Lists.ListType },
      payload: Lists.CreateListEntryRequest,
      success: Lists.ListEntry,
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "list_entry_create"),
    HttpApiEndpoint.get("lists_get", "/v0/lists/:direction/:type/:entry", {
      params: { direction: Lists.Direction, type: Lists.ListType, entry: Schema.String },
      success: Lists.ListEntry,
      error: Errors.ReadErrors,
    }).annotate(RequiredPermission, "list_entry_read"),
    HttpApiEndpoint.delete("lists_delete", "/v0/lists/:direction/:type/:entry", {
      params: { direction: Lists.Direction, type: Lists.ListType, entry: Schema.String },
      success: HttpApiSchema.Empty(200),
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "list_entry_delete"),
  )
  .middleware(BearerAuth);
