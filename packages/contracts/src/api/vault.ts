import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import * as Common from "../common.js";
import * as Errors from "../errors.js";
import * as Vault from "../vault.js";
import { BearerAuth, OwnerOnly, RequiredPermission } from "../security.js";

const params = { inbox_id: Common.InboxId, credential_id: Common.CredentialId };
export const CredentialsApi = HttpApiGroup.make("credentials")
  .add(
    HttpApiEndpoint.get("inboxes_credentials_list", "/v0/inboxes/:inbox_id/credentials", {
      params: { inbox_id: Common.InboxId },
      query: Vault.ListCredentialsQuery,
      success: Vault.ListCredentialsResponse,
      error: Errors.ListErrors,
    }).annotate(RequiredPermission, "credential_read"),
    HttpApiEndpoint.post("inboxes_credentials_create", "/v0/inboxes/:inbox_id/credentials", {
      params: { inbox_id: Common.InboxId },
      payload: Vault.CreateCredentialRequest,
      success: Vault.Credential,
      error: Errors.WriteErrors,
    }).annotate(RequiredPermission, "credential_create"),
    HttpApiEndpoint.get(
      "inboxes_credentials_get",
      "/v0/inboxes/:inbox_id/credentials/:credential_id",
      {
        params,
        success: Vault.Credential,
        error: Errors.ReadErrors,
      },
    ).annotate(RequiredPermission, "credential_read"),
    HttpApiEndpoint.patch(
      "inboxes_credentials_update",
      "/v0/inboxes/:inbox_id/credentials/:credential_id",
      {
        params,
        payload: Vault.UpdateCredentialRequest,
        success: Vault.Credential,
        error: Errors.WriteErrors,
      },
    ).annotate(RequiredPermission, "credential_update"),
    HttpApiEndpoint.delete(
      "inboxes_credentials_delete",
      "/v0/inboxes/:inbox_id/credentials/:credential_id",
      {
        params,
        success: HttpApiSchema.Empty(200),
        error: Errors.WriteErrors,
      },
    ).annotate(RequiredPermission, "credential_delete"),
    HttpApiEndpoint.post(
      "inboxes_credentials_generate",
      "/v0/inboxes/:inbox_id/credentials/:credential_id/generate",
      {
        params,
        payload: Vault.GenerateFieldRequest,
        success: Vault.Credential,
        error: Errors.WriteErrors,
      },
    ).annotate(RequiredPermission, "credential_update"),
    HttpApiEndpoint.get(
      "inboxes_credentials_totp",
      "/v0/inboxes/:inbox_id/credentials/:credential_id/totp",
      {
        params,
        success: Vault.TotpCodeResponse,
        error: Errors.ReadErrors,
      },
    ).annotate(RequiredPermission, "credential_totp"),
    HttpApiEndpoint.get(
      "inboxes_credentials_reveal",
      "/v0/inboxes/:inbox_id/credentials/:credential_id/fields",
      {
        params,
        success: Vault.CredentialFieldsResponse,
        error: Errors.ReadErrors,
      },
    ).middleware(OwnerOnly),
    HttpApiEndpoint.get("credentials_list", "/v0/credentials", {
      query: Vault.GlobalCredentialsQuery,
      success: Vault.ListCredentialsResponse,
      error: Errors.ListErrors,
    }).annotate(RequiredPermission, "credential_read"),
  )
  .middleware(BearerAuth);
