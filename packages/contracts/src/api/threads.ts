import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import * as Common from "../common.js";
import * as Errors from "../errors.js";
import * as Threads from "../threads.js";
import * as Attachments from "../attachments.js";
import { BearerAuth, RequiredPermission } from "../security.js";

export const ThreadsApi = HttpApiGroup.make("threads")
  .add(
    HttpApiEndpoint.get("inboxes_threads_list", "/v0/inboxes/:inbox_id/threads", {
      params: { inbox_id: Common.InboxId },
      query: Threads.ListThreadsQuery,
      success: Threads.ListThreadsResponse,
      error: Errors.ListErrors,
    }).annotate(RequiredPermission, "message_read"),
    HttpApiEndpoint.get("inboxes_threads_search", "/v0/inboxes/:inbox_id/threads/search", {
      params: { inbox_id: Common.InboxId },
      query: Common.SearchMailQuery,
      success: Threads.SearchThreadsResponse,
      error: Errors.ListErrors,
    }).annotate(RequiredPermission, "message_read"),
    HttpApiEndpoint.get("inboxes_threads_get", "/v0/inboxes/:inbox_id/threads/:thread_id", {
      params: { inbox_id: Common.InboxId, thread_id: Common.ThreadId },
      query: Common.CursorQuery,
      success: Threads.Thread,
      error: Errors.ListErrors,
    }).annotate(RequiredPermission, "message_read"),
    HttpApiEndpoint.patch("inboxes_threads_update", "/v0/inboxes/:inbox_id/threads/:thread_id", {
      params: { inbox_id: Common.InboxId, thread_id: Common.ThreadId },
      payload: Threads.UpdateThreadRequest,
      success: Threads.UpdateThreadResponse,
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "message_update"),
    HttpApiEndpoint.delete("inboxes_threads_delete", "/v0/inboxes/:inbox_id/threads/:thread_id", {
      params: { inbox_id: Common.InboxId, thread_id: Common.ThreadId },
      success: HttpApiSchema.Empty(200),
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "message_delete"),
    HttpApiEndpoint.get(
      "inboxes_threads_getAttachment",
      "/v0/inboxes/:inbox_id/threads/:thread_id/attachments/:attachment_id",
      {
        params: {
          inbox_id: Common.InboxId,
          thread_id: Common.ThreadId,
          attachment_id: Common.AttachmentId,
        },
        success: Attachments.AttachmentResponse,
        error: Errors.ReadErrors,
      },
    ).annotate(RequiredPermission, "message_read"),
    HttpApiEndpoint.get("threads_list", "/v0/threads", {
      query: Threads.ListThreadsQuery,
      success: Threads.ListThreadsResponse,
      error: Errors.ListErrors,
    }).annotate(RequiredPermission, "message_read"),
    HttpApiEndpoint.get("threads_search", "/v0/threads/search", {
      query: Common.SearchMailQuery,
      success: Threads.SearchThreadsResponse,
      error: Errors.ListErrors,
    }).annotate(RequiredPermission, "message_read"),
    HttpApiEndpoint.get("threads_get", "/v0/threads/:thread_id", {
      params: { thread_id: Common.ThreadId },
      query: Common.CursorQuery,
      success: Threads.Thread,
      error: Errors.ListErrors,
    }).annotate(RequiredPermission, "message_read"),
    HttpApiEndpoint.patch("threads_update", "/v0/threads/:thread_id", {
      params: { thread_id: Common.ThreadId },
      payload: Threads.UpdateThreadRequest,
      success: Threads.UpdateThreadResponse,
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "message_update"),
    HttpApiEndpoint.delete("threads_delete", "/v0/threads/:thread_id", {
      params: { thread_id: Common.ThreadId },
      success: HttpApiSchema.Empty(200),
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "message_delete"),
    HttpApiEndpoint.get(
      "threads_getAttachment",
      "/v0/threads/:thread_id/attachments/:attachment_id",
      {
        params: { thread_id: Common.ThreadId, attachment_id: Common.AttachmentId },
        success: Attachments.AttachmentResponse,
        error: Errors.ReadErrors,
      },
    ).annotate(RequiredPermission, "message_read"),
  )
  .middleware(BearerAuth);
