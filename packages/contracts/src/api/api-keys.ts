import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import * as Common from "../common.js";
import * as Errors from "../errors.js";
import * as ApiKeys from "../api-keys.js";
import { BearerAuth, OwnerOnly } from "../security.js";

export const ApiKeysApi = HttpApiGroup.make("api-keys")
  .add(
    HttpApiEndpoint.get("inboxes_apiKeys_list", "/v0/inboxes/:inbox_id/api-keys", {
      params: { inbox_id: Common.InboxId },
      query: Common.CursorQuery,
      success: ApiKeys.ListApiKeysResponse,
      error: Errors.ListErrors,
    }),
    HttpApiEndpoint.post("inboxes_apiKeys_create", "/v0/inboxes/:inbox_id/api-keys", {
      params: { inbox_id: Common.InboxId },
      payload: ApiKeys.CreateApiKeyRequest,
      success: ApiKeys.CreateApiKeyResponse,
      error: Errors.WriteErrors,
    }),
    HttpApiEndpoint.patch("inboxes_apiKeys_update", "/v0/inboxes/:inbox_id/api-keys/:api_key_id", {
      params: { inbox_id: Common.InboxId, api_key_id: Common.ApiKeyId },
      payload: ApiKeys.UpdateApiKeyRequest,
      success: ApiKeys.ApiKey,
      error: Errors.WriteErrors,
    }),
    HttpApiEndpoint.delete("inboxes_apiKeys_delete", "/v0/inboxes/:inbox_id/api-keys/:api_key_id", {
      params: { inbox_id: Common.InboxId, api_key_id: Common.ApiKeyId },
      success: HttpApiSchema.Empty(200),
      error: Errors.WriteErrors,
    }),
    HttpApiEndpoint.get("apiKeys_list", "/v0/api-keys", {
      query: Schema.Struct({
        ...Common.PaginationQuery.fields,
        type: Schema.optionalKey(Schema.Literal("bearer")),
      }),
      success: ApiKeys.ListApiKeysResponse,
      error: Errors.ListErrors,
    }),
    HttpApiEndpoint.post("apiKeys_create", "/v0/api-keys", {
      payload: ApiKeys.CreateApiKeyRequest,
      success: ApiKeys.CreateApiKeyResponse,
      error: Errors.WriteErrors,
    }),
    HttpApiEndpoint.get("apiKeys_get", "/v0/api-keys/:api_key_id", {
      params: { api_key_id: Common.ApiKeyId },
      success: ApiKeys.ApiKey,
      error: Errors.ReadErrors,
    }),
    HttpApiEndpoint.patch("apiKeys_update", "/v0/api-keys/:api_key_id", {
      params: { api_key_id: Common.ApiKeyId },
      payload: ApiKeys.UpdateApiKeyRequest,
      success: ApiKeys.ApiKey,
      error: Errors.WriteErrors,
    }),
    HttpApiEndpoint.delete("apiKeys_delete", "/v0/api-keys/:api_key_id", {
      params: { api_key_id: Common.ApiKeyId },
      success: HttpApiSchema.Empty(200),
      error: Errors.WriteErrors,
    }),
  )
  .middleware(OwnerOnly)
  .middleware(BearerAuth);
