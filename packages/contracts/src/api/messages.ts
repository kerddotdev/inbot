import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import * as Common from "../common.js";
import * as Errors from "../errors.js";
import * as Messages from "../messages.js";
import * as Attachments from "../attachments.js";
import { BearerAuth, OwnerOnly, RequiredPermission } from "../security.js";

export const MessagesApi = HttpApiGroup.make("messages")
  .add(
    HttpApiEndpoint.get("inboxes_messages_list", "/v0/inboxes/:inbox_id/messages", {
      params: { inbox_id: Common.InboxId },
      query: Messages.ListMessagesQuery,
      success: Messages.ListMessagesResponse,
      error: Errors.ListErrors,
    }).annotate(RequiredPermission, "message_read"),
    HttpApiEndpoint.get("inboxes_messages_search", "/v0/inboxes/:inbox_id/messages/search", {
      params: { inbox_id: Common.InboxId },
      query: Common.SearchMailQuery,
      success: Messages.SearchMessagesResponse,
      error: Errors.ListErrors,
    }).annotate(RequiredPermission, "message_read"),
    HttpApiEndpoint.get("inboxes_messages_get", "/v0/inboxes/:inbox_id/messages/:message_id", {
      params: { inbox_id: Common.InboxId, message_id: Common.MessageId },
      success: Messages.Message,
      error: Errors.ReadErrors,
    }).annotate(RequiredPermission, "message_read"),
    HttpApiEndpoint.patch("inboxes_messages_update", "/v0/inboxes/:inbox_id/messages/:message_id", {
      params: { inbox_id: Common.InboxId, message_id: Common.MessageId },
      payload: Messages.UpdateMessageRequest,
      success: Messages.UpdateMessageResponse,
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "message_update"),
    HttpApiEndpoint.delete(
      "inboxes_messages_delete",
      "/v0/inboxes/:inbox_id/messages/:message_id",
      {
        params: { inbox_id: Common.InboxId, message_id: Common.MessageId },
        success: HttpApiSchema.Empty(200),
        error: Errors.WriteErrors,
      },
    ).annotate(RequiredPermission, "message_delete"),
    HttpApiEndpoint.post("inboxes_messages_batchGet", "/v0/inboxes/:inbox_id/messages/batch-get", {
      params: { inbox_id: Common.InboxId },
      payload: Messages.BatchGetMessagesRequest,
      success: Messages.BatchGetMessagesResponse,
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "message_read"),
    HttpApiEndpoint.post(
      "inboxes_messages_batchUpdate",
      "/v0/inboxes/:inbox_id/messages/batch-update",
      {
        params: { inbox_id: Common.InboxId },
        payload: Messages.BatchUpdateMessagesRequest,
        success: Messages.BatchUpdateMessagesResponse,
        error: Errors.WriteErrors,
      },
    ).annotate(RequiredPermission, "message_update"),
    HttpApiEndpoint.get(
      "inboxes_messages_getAttachment",
      "/v0/inboxes/:inbox_id/messages/:message_id/attachments/:attachment_id",
      {
        params: {
          inbox_id: Common.InboxId,
          message_id: Common.MessageId,
          attachment_id: Common.AttachmentId,
        },
        success: Attachments.AttachmentResponse,
        error: Errors.ReadErrors,
      },
    ).annotate(RequiredPermission, "message_read"),
    HttpApiEndpoint.get(
      "inboxes_messages_getRaw",
      "/v0/inboxes/:inbox_id/messages/:message_id/raw",
      {
        params: { inbox_id: Common.InboxId, message_id: Common.MessageId },
        success: Messages.RawMessageResponse,
        error: Errors.ReadErrors,
      },
    ).annotate(RequiredPermission, "message_read"),
    HttpApiEndpoint.post(
      "inboxes_messages_resolve",
      "/v0/inboxes/:inbox_id/messages/:message_id/resolve",
      {
        params: { inbox_id: Common.InboxId, message_id: Common.MessageId },
        payload: Messages.ResolveMessageRequest,
        success: Messages.Message,
        error: Errors.WriteErrors,
      },
    ).middleware(OwnerOnly),
    HttpApiEndpoint.post("inboxes_messages_send", "/v0/inboxes/:inbox_id/messages/send", {
      params: { inbox_id: Common.InboxId },
      payload: Messages.SendMessageRequest,
      headers: Common.SendHeaders,
      success: Messages.SendMessageResponse,
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "message_send"),
    HttpApiEndpoint.post(
      "inboxes_messages_reply",
      "/v0/inboxes/:inbox_id/messages/:message_id/reply",
      {
        params: { inbox_id: Common.InboxId, message_id: Common.MessageId },
        payload: Messages.ReplyToMessageRequest,
        headers: Common.SendHeaders,
        success: Messages.SendMessageResponse,
        error: Errors.WriteErrors,
      },
    ).annotate(RequiredPermission, "message_reply"),
    HttpApiEndpoint.post(
      "inboxes_messages_replyAll",
      "/v0/inboxes/:inbox_id/messages/:message_id/reply-all",
      {
        params: { inbox_id: Common.InboxId, message_id: Common.MessageId },
        payload: Messages.ReplyAllMessageRequest,
        headers: Common.SendHeaders,
        success: Messages.SendMessageResponse,
        error: Errors.WriteErrors,
      },
    ).annotate(RequiredPermission, "message_reply"),
    HttpApiEndpoint.post(
      "inboxes_messages_forward",
      "/v0/inboxes/:inbox_id/messages/:message_id/forward",
      {
        params: { inbox_id: Common.InboxId, message_id: Common.MessageId },
        payload: Messages.ForwardMessageRequest,
        headers: Common.SendHeaders,
        success: Messages.SendMessageResponse,
        error: Errors.WriteErrors,
      },
    ).annotate(RequiredPermission, "message_send"),
  )
  .middleware(BearerAuth);
