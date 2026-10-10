import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import * as Common from "../common.js";
import * as Errors from "../errors.js";
import * as Webhooks from "../webhooks.js";
import { BearerAuth, RequiredPermission } from "../security.js";

export const WebhooksApi = HttpApiGroup.make("webhooks")
  .add(
    HttpApiEndpoint.get("inboxes_webhooks_list", "/v0/inboxes/:inbox_id/webhooks", {
      params: { inbox_id: Common.InboxId },
      query: Common.PaginationQuery,
      success: Webhooks.ListWebhooksResponse,
      error: Errors.ListErrors,
    }).annotate(RequiredPermission, "webhook_read"),
    HttpApiEndpoint.post("inboxes_webhooks_create", "/v0/inboxes/:inbox_id/webhooks", {
      params: { inbox_id: Common.InboxId },
      payload: Webhooks.CreateInboxWebhookRequest,
      success: Webhooks.Webhook,
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "webhook_create"),
    HttpApiEndpoint.get("inboxes_webhooks_get", "/v0/inboxes/:inbox_id/webhooks/:webhook_id", {
      params: { inbox_id: Common.InboxId, webhook_id: Common.WebhookId },
      success: Webhooks.Webhook,
      error: Errors.ReadErrors,
    }).annotate(RequiredPermission, "webhook_read"),
    HttpApiEndpoint.patch("inboxes_webhooks_update", "/v0/inboxes/:inbox_id/webhooks/:webhook_id", {
      params: { inbox_id: Common.InboxId, webhook_id: Common.WebhookId },
      payload: Webhooks.UpdateInboxWebhookRequest,
      success: Webhooks.Webhook,
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "webhook_update"),
    HttpApiEndpoint.delete(
      "inboxes_webhooks_delete",
      "/v0/inboxes/:inbox_id/webhooks/:webhook_id",
      {
        params: { inbox_id: Common.InboxId, webhook_id: Common.WebhookId },
        success: HttpApiSchema.Empty(200),
        error: Errors.WriteErrors,
      },
    ).annotate(RequiredPermission, "webhook_delete"),
    HttpApiEndpoint.get(
      "inboxes_webhooks_getHeaders",
      "/v0/inboxes/:inbox_id/webhooks/:webhook_id/headers",
      {
        params: { inbox_id: Common.InboxId, webhook_id: Common.WebhookId },
        success: Webhooks.WebhookHeaderNamesResponse,
        error: Errors.ReadErrors,
      },
    ).annotate(RequiredPermission, "webhook_read"),
    HttpApiEndpoint.patch(
      "inboxes_webhooks_updateHeaders",
      "/v0/inboxes/:inbox_id/webhooks/:webhook_id/headers",
      {
        params: { inbox_id: Common.InboxId, webhook_id: Common.WebhookId },
        payload: Webhooks.UpdateWebhookHeadersRequest,
        success: HttpApiSchema.NoContent,
        error: Errors.WriteErrors,
      },
    ).annotate(RequiredPermission, "webhook_update"),
    HttpApiEndpoint.get("webhooks_list", "/v0/webhooks", {
      query: Common.PaginationQuery,
      success: Webhooks.ListWebhooksResponse,
      error: Errors.ListErrors,
    }).annotate(RequiredPermission, "webhook_read"),
    HttpApiEndpoint.post("webhooks_create", "/v0/webhooks", {
      payload: Webhooks.CreateWebhookRequest,
      success: Webhooks.Webhook,
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "webhook_create"),
    HttpApiEndpoint.get("webhooks_get", "/v0/webhooks/:webhook_id", {
      params: { webhook_id: Common.WebhookId },
      success: Webhooks.Webhook,
      error: Errors.ReadErrors,
    }).annotate(RequiredPermission, "webhook_read"),
    HttpApiEndpoint.patch("webhooks_update", "/v0/webhooks/:webhook_id", {
      params: { webhook_id: Common.WebhookId },
      payload: Webhooks.UpdateWebhookRequest,
      success: Webhooks.Webhook,
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "webhook_update"),
    HttpApiEndpoint.delete("webhooks_delete", "/v0/webhooks/:webhook_id", {
      params: { webhook_id: Common.WebhookId },
      success: HttpApiSchema.Empty(200),
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "webhook_delete"),
    HttpApiEndpoint.get("webhooks_getHeaders", "/v0/webhooks/:webhook_id/headers", {
      params: { webhook_id: Common.WebhookId },
      success: Webhooks.WebhookHeaderNamesResponse,
      error: Errors.ReadErrors,
    }).annotate(RequiredPermission, "webhook_read"),
    HttpApiEndpoint.patch("webhooks_updateHeaders", "/v0/webhooks/:webhook_id/headers", {
      params: { webhook_id: Common.WebhookId },
      payload: Webhooks.UpdateWebhookHeadersRequest,
      success: HttpApiSchema.NoContent,
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "webhook_update"),
  )
  .middleware(BearerAuth);
