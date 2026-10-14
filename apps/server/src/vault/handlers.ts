import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { ServerApi } from "../http/api.js";
import { respond } from "../http/errors.js";
import { Vault } from "./vault.js";

export const CredentialsLive = HttpApiBuilder.group(ServerApi, "credentials", (handlers) =>
  Effect.gen(function* () {
    const vault = yield* Vault;
    return handlers
      .handle("inboxes_credentials_list", ({ params, query }) =>
        respond(vault.list(query, params.inbox_id)),
      )
      .handle("inboxes_credentials_create", ({ params, payload }) =>
        respond(vault.create(payload, params.inbox_id)),
      )
      .handle("inboxes_credentials_get", ({ params }) =>
        respond(vault.get(params.credential_id, params.inbox_id)),
      )
      .handle("inboxes_credentials_update", ({ params, payload }) =>
        respond(vault.update(params.credential_id, payload, params.inbox_id)),
      )
      .handle("inboxes_credentials_delete", ({ params }) =>
        respond(vault.delete(params.credential_id, params.inbox_id)),
      )
      .handle("inboxes_credentials_generate", ({ params, payload }) =>
        respond(vault.generate(params.credential_id, payload, params.inbox_id)),
      )
      .handle("inboxes_credentials_fill", ({ params, payload }) =>
        respond(vault.fill(params.credential_id, payload, params.inbox_id)),
      )
      .handle("inboxes_credentials_capture", ({ params, payload }) =>
        respond(vault.capture(params.credential_id, payload, params.inbox_id)),
      )
      .handle("owner_vault_settings", () => respond(vault.settings()))
      .handle("owner_vault_setSettings", ({ payload }) => respond(vault.setSettings(payload)))
      .handle("inboxes_credentials_totp", ({ params }) =>
        respond(vault.totp(params.credential_id, params.inbox_id)),
      )
      .handle("inboxes_credentials_reveal", ({ params }) =>
        respond(vault.reveal(params.credential_id, params.inbox_id)),
      )
      .handle("credentials_resolve", ({ payload }) => respond(vault.resolve(payload)))
      .handle("credentials_list", ({ query: { inbox_id, ...query } }) =>
        respond(vault.list(query, inbox_id)),
      );
  }),
);
