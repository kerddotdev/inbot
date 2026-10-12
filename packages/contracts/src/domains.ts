import { Schema } from "effect";
import { DomainId, PageFields, Timestamp } from "./common.js";

export const VerificationStatus = Schema.Literals([
  "NOT_STARTED",
  "PENDING",
  "INVALID",
  "FAILED",
  "VERIFYING",
  "VERIFIED",
]).annotate({ identifier: "VerificationStatus" });
export type VerificationStatus = typeof VerificationStatus.Type;

export const RecordType = Schema.Literals(["TXT", "CNAME", "MX"]).annotate({
  identifier: "RecordType",
});
export type RecordType = typeof RecordType.Type;

export const RecordStatus = Schema.Literals(["MISSING", "INVALID", "VALID"]).annotate({
  identifier: "RecordStatus",
});
export type RecordStatus = typeof RecordStatus.Type;

export const VerificationRecord = Schema.Struct({
  type: RecordType,
  name: Schema.String,
  value: Schema.String,
  status: RecordStatus,
  priority: Schema.optionalKey(Schema.Int),
  reason: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "VerificationRecord" });
export type VerificationRecord = typeof VerificationRecord.Type;

export const DomainItem = Schema.Struct({
  domain_id: DomainId,
  domain: Schema.String,
  feedback_enabled: Schema.Boolean,
  inbound_enabled: Schema.optionalKey(Schema.Boolean),
  subdomains_enabled: Schema.Boolean,
  tracking_enabled: Schema.Boolean,
  client_id: Schema.optionalKey(Schema.String),
  updated_at: Timestamp,
  created_at: Timestamp,
}).annotate({ identifier: "DomainItem" });
export type DomainItem = typeof DomainItem.Type;

export const ListDomainsResponse = Schema.Struct({
  ...PageFields,
  domains: Schema.Array(DomainItem),
}).annotate({ identifier: "ListDomainsResponse" });
export type ListDomainsResponse = typeof ListDomainsResponse.Type;

export const Domain = Schema.Struct({
  ...DomainItem.fields,
  status: VerificationStatus,
  reason: Schema.optionalKey(Schema.String),
  records: Schema.Array(VerificationRecord),
}).annotate({ identifier: "Domain" });
export type Domain = typeof Domain.Type;

export const ProvisionPlan = Schema.Struct({
  domain: Schema.String,
  steps: Schema.Array(Schema.String),
  records: Schema.Array(VerificationRecord),
  warnings: Schema.Array(Schema.String),
}).annotate({ identifier: "ProvisionPlan" });
export type ProvisionPlan = typeof ProvisionPlan.Type;

export const CreateDomainRequest = Schema.Struct({
  domain: Schema.String,
  allow_conflicting_provider: Schema.optionalKey(Schema.Boolean),
  feedback_enabled: Schema.optionalKey(Schema.Boolean),
  inbound_enabled: Schema.optionalKey(Schema.Boolean),
  subdomains_enabled: Schema.optionalKey(Schema.Boolean),
  tracking_enabled: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "CreateDomainRequest" });
export type CreateDomainRequest = typeof CreateDomainRequest.Type;

export const UpdateDomainRequest = Schema.Struct({
  feedback_enabled: Schema.optionalKey(Schema.Boolean),
  inbound_enabled: Schema.optionalKey(Schema.Boolean),
  subdomains_enabled: Schema.optionalKey(Schema.Boolean),
  tracking_enabled: Schema.optionalKey(Schema.Boolean),
})
  .check(Schema.isMinProperties(1))
  .annotate({ identifier: "UpdateDomainRequest" });
export type UpdateDomainRequest = typeof UpdateDomainRequest.Type;
