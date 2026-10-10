import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import * as Common from "../common.js";
import * as Errors from "../errors.js";
import * as Domains from "../domains.js";
import { BearerAuth, OwnerOnly } from "../security.js";

export const DomainsApi = HttpApiGroup.make("domains")
  .add(
    HttpApiEndpoint.get("domains_list", "/v0/domains", {
      query: Common.PaginationQuery,
      success: Domains.ListDomainsResponse,
      error: Errors.ListErrors,
    }),
    HttpApiEndpoint.post("domains_create", "/v0/domains", {
      payload: Domains.CreateDomainRequest,
      success: Domains.Domain,
      error: Errors.WriteErrors,
    }),
    HttpApiEndpoint.get("domains_get", "/v0/domains/:domain_id", {
      params: { domain_id: Common.DomainId },
      success: Domains.Domain,
      error: Errors.ReadErrors,
    }),
    HttpApiEndpoint.patch("domains_update", "/v0/domains/:domain_id", {
      params: { domain_id: Common.DomainId },
      payload: Domains.UpdateDomainRequest,
      success: Domains.Domain,
      error: Errors.WriteErrors,
    }),
    HttpApiEndpoint.delete("domains_delete", "/v0/domains/:domain_id", {
      params: { domain_id: Common.DomainId },
      success: HttpApiSchema.Empty(200),
      error: Errors.WriteErrors,
    }),
    HttpApiEndpoint.get("domains_getZoneFile", "/v0/domains/:domain_id/zone-file", {
      params: { domain_id: Common.DomainId },
      success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/plain" })),
      error: Errors.ReadErrors,
    }),
    HttpApiEndpoint.get("domains_plan", "/v0/domains/:domain_id/plan", {
      params: { domain_id: Common.DomainId },
      success: Domains.ProvisionPlan,
      error: Errors.ReadErrors,
    }),
    HttpApiEndpoint.post("domains_verify", "/v0/domains/:domain_id/verify", {
      params: { domain_id: Common.DomainId },
      success: HttpApiSchema.Empty(200),
      error: Errors.WriteErrors,
    }),
    HttpApiEndpoint.post("domains_apply", "/v0/domains/:domain_id/apply", {
      params: { domain_id: Common.DomainId },
      success: Domains.Domain,
      error: Errors.WriteErrors,
    }),
    HttpApiEndpoint.post("domains_teardown", "/v0/domains/:domain_id/teardown", {
      params: { domain_id: Common.DomainId },
      success: Domains.Domain,
      error: Errors.WriteErrors,
    }),
  )
  .middleware(OwnerOnly)
  .middleware(BearerAuth);
