import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import * as Common from "../common.js";
import * as Errors from "../errors.js";
import * as Messages from "../messages.js";
import * as Drafts from "../drafts.js";
import * as Attachments from "../attachments.js";
import { BearerAuth, OwnerOnly, RequiredPermission } from "../security.js";

export const DraftsApi = HttpApiGroup.make("drafts")
  .add(
    HttpApiEndpoint.post(
      "inboxes_drafts_approve",
      "/v0/inboxes/:inbox_id/drafts/:draft_id/approve",
      {
        params: { inbox_id: Common.InboxId, draft_id: Common.DraftId },
        headers: Common.SendHeaders,
        success: Schema.Union([Messages.SendMessageResponse, Drafts.Draft]),
        error: Errors.WriteErrors,
      },
    ).middleware(OwnerOnly),
    HttpApiEndpoint.post("inboxes_drafts_reject", "/v0/inboxes/:inbox_id/drafts/:draft_id/reject", {
      params: { inbox_id: Common.InboxId, draft_id: Common.DraftId },
      payload: Drafts.RejectDraftRequest,
      success: Drafts.Draft,
      error: Errors.WriteErrors,
    }).middleware(OwnerOnly),
    HttpApiEndpoint.get("inboxes_drafts_list", "/v0/inboxes/:inbox_id/drafts", {
      params: { inbox_id: Common.InboxId },
      query: Drafts.ListDraftsQuery,
      success: Drafts.ListDraftsResponse,
      error: Errors.ListErrors,
    }).annotate(RequiredPermission, "draft_read"),
    HttpApiEndpoint.post("inboxes_drafts_create", "/v0/inboxes/:inbox_id/drafts", {
      params: { inbox_id: Common.InboxId },
      payload: Drafts.CreateDraftRequest,
      success: Drafts.Draft,
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "draft_create"),
    HttpApiEndpoint.get("inboxes_drafts_get", "/v0/inboxes/:inbox_id/drafts/:draft_id", {
      params: { inbox_id: Common.InboxId, draft_id: Common.DraftId },
      success: Drafts.Draft,
      error: Errors.ReadErrors,
    }).annotate(RequiredPermission, "draft_read"),
    HttpApiEndpoint.patch("inboxes_drafts_update", "/v0/inboxes/:inbox_id/drafts/:draft_id", {
      params: { inbox_id: Common.InboxId, draft_id: Common.DraftId },
      payload: Drafts.UpdateDraftRequest,
      success: Drafts.Draft,
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "draft_update"),
    HttpApiEndpoint.delete("inboxes_drafts_delete", "/v0/inboxes/:inbox_id/drafts/:draft_id", {
      params: { inbox_id: Common.InboxId, draft_id: Common.DraftId },
      success: HttpApiSchema.Empty(200),
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "draft_delete"),
    HttpApiEndpoint.get(
      "inboxes_drafts_getAttachment",
      "/v0/inboxes/:inbox_id/drafts/:draft_id/attachments/:attachment_id",
      {
        params: {
          inbox_id: Common.InboxId,
          draft_id: Common.DraftId,
          attachment_id: Common.AttachmentId,
        },
        success: Attachments.AttachmentResponse,
        error: Errors.ReadErrors,
      },
    ).annotate(RequiredPermission, "draft_read"),
    HttpApiEndpoint.post("inboxes_drafts_send", "/v0/inboxes/:inbox_id/drafts/:draft_id/send", {
      params: { inbox_id: Common.InboxId, draft_id: Common.DraftId },
      payload: Drafts.SendDraftRequest,
      headers: Common.SendHeaders,
      success: Messages.SendMessageResponse,
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "draft_send"),
    HttpApiEndpoint.get("drafts_list", "/v0/drafts", {
      query: Drafts.ListDraftsQuery,
      success: Drafts.ListDraftsResponse,
      error: Errors.ListErrors,
    }).annotate(RequiredPermission, "draft_read"),
    HttpApiEndpoint.get("drafts_get", "/v0/drafts/:draft_id", {
      params: { draft_id: Common.DraftId },
      success: Drafts.Draft,
      error: Errors.ReadErrors,
    }).annotate(RequiredPermission, "draft_read"),
    HttpApiEndpoint.get("drafts_getAttachment", "/v0/drafts/:draft_id/attachments/:attachment_id", {
      params: { draft_id: Common.DraftId, attachment_id: Common.AttachmentId },
      success: Attachments.AttachmentResponse,
      error: Errors.ReadErrors,
    }).annotate(RequiredPermission, "draft_read"),
  )
  .middleware(BearerAuth);
