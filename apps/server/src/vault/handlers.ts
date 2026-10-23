import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { readBitwardenBody } from "./bitwarden-http.js";
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
      .handle("inboxes_credentials_fill", ({ params, payload, headers }) =>
        respond(
          vault.fill(params.credential_id, payload, params.inbox_id, headers["idempotency-key"]),
        ),
      )
      .handle("inboxes_credentials_capture", ({ params, payload, headers }) =>
        respond(
          vault.capture(params.credential_id, payload, params.inbox_id, headers["idempotency-key"]),
        ),
      )
      .handle("owner_vault_settings", () => respond(vault.settings()))
      .handle("owner_vault_setSettings", ({ payload }) => respond(vault.setSettings(payload)))
      .handle("inboxes_credentials_totp", ({ params }) =>
        respond(vault.totp(params.credential_id, params.inbox_id)),
      )
      .handle("inboxes_credentials_reveal", ({ params }) =>
        respond(vault.reveal(params.credential_id, params.inbox_id)),
      )
      .handle("credentials_resolve", ({ payload, headers }) =>
        respond(vault.resolve(payload, headers["idempotency-key"])),
      )
      .handle("credentials_list", ({ query: { inbox_id, ...query } }) =>
        respond(vault.list(query, inbox_id)),
      )
      .handle("credentials_export", ({ query }) =>
        respond(
          vault
            .exportBitwarden(query.inbox_id)
            .pipe(
              Effect.map((body) =>
                HttpServerResponse.jsonUnsafe(body, { headers: { "cache-control": "no-store" } }),
              ),
            ),
        ),
      )
      .handleRaw("credentials_import", ({ request, query }) =>
        respond(
          Effect.gen(function* () {
            const body = yield* readBitwardenBody(request);
            return HttpServerResponse.jsonUnsafe(yield* vault.importBitwarden(body, query), {
              headers: { "cache-control": "no-store" },
            });
          }),
        ).pipe(Effect.map(HttpServerResponse.setHeader("connection", "close"))),
      );
  }),
);
