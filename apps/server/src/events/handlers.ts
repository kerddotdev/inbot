import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { ServerApi } from "../http/api.js";
import { respond } from "../http/errors.js";
import { Webhooks } from "./webhooks.js";

export const WebhooksLive = HttpApiBuilder.group(ServerApi, "webhooks", (handlers) =>
  Effect.gen(function* () {
    const hooks = yield* Webhooks;
    return handlers
      .handle("inboxes_webhooks_list", ({ params, query }) =>
        respond(hooks.list(query, params.inbox_id)),
      )
      .handle("inboxes_webhooks_create", ({ params, payload }) =>
        respond(hooks.create(payload, params.inbox_id)),
      )
      .handle("inboxes_webhooks_get", ({ params }) =>
        respond(hooks.get(params.webhook_id, params.inbox_id)),
      )
      .handle("inboxes_webhooks_update", ({ params, payload }) =>
        respond(hooks.update(params.webhook_id, payload, params.inbox_id)),
      )
      .handle("inboxes_webhooks_delete", ({ params }) =>
        respond(hooks.delete(params.webhook_id, params.inbox_id)),
      )
      .handle("inboxes_webhooks_getHeaders", ({ params }) =>
        respond(hooks.headers(params.webhook_id, params.inbox_id)),
      )
      .handle("inboxes_webhooks_updateHeaders", ({ params, payload }) =>
        respond(hooks.updateHeaders(params.webhook_id, payload, params.inbox_id)),
      )
      .handle("webhooks_list", ({ query }) => respond(hooks.list(query)))
      .handle("webhooks_create", ({ payload }) => respond(hooks.create(payload)))
      .handle("webhooks_get", ({ params }) => respond(hooks.get(params.webhook_id)))
      .handle("webhooks_update", ({ params, payload }) =>
        respond(hooks.update(params.webhook_id, payload)),
      )
      .handle("webhooks_delete", ({ params }) => respond(hooks.delete(params.webhook_id)))
      .handle("webhooks_getHeaders", ({ params }) => respond(hooks.headers(params.webhook_id)))
      .handle("webhooks_updateHeaders", ({ params, payload }) =>
        respond(hooks.updateHeaders(params.webhook_id, payload)),
      );
  }),
);
