import { Schema } from "effect";
import {
  Domain,
  VerificationRecord,
  VerificationStatus,
} from "../../../../packages/contracts/src/domains.js";
import type { StoreService } from "../store.js";
import { DnsRecord } from "./cloudflare-api.js";

export const ResourceKind = Schema.Literals([
  "sending",
  "routing",
  "dns",
  "bucket",
  "inbound_queue",
  "inbound_consumer",
  "events_queue",
  "events_consumer",
  "worker",
  "subscription",
  "selftest_rule",
]);
export type ResourceKind = typeof ResourceKind.Type;
export const Resource = Schema.Struct({
  sequence: Schema.Int,
  domain_id: Schema.String,
  kind: ResourceKind,
  name: Schema.String,
  cloudflare_id: Schema.NullOr(Schema.String),
  parent_id: Schema.NullOr(Schema.String),
  owned: Schema.Int,
});
export type Resource = typeof Resource.Type;
export const DomainRow = Schema.Struct({
  domain_id: Schema.String,
  domain: Schema.String,
  account_id: Schema.String,
  zone_id: Schema.String,
  zone_name: Schema.String,
  feedback_enabled: Schema.Int,
  inbound_enabled: Schema.Int,
  subdomains_enabled: Schema.Int,
  tracking_enabled: Schema.Int,
  status: VerificationStatus,
  phase: Schema.Literals(["registered", "applying", "ready", "tearing_down", "action_required"]),
  reason: Schema.NullOr(Schema.String),
  records: Schema.fromJsonString(Schema.Array(VerificationRecord)),
  apex_snapshot: Schema.NullOr(Schema.String),
  dns_before: Schema.NullOr(Schema.String),
  dns_step: Schema.NullOr(Schema.String),
  selftest_token: Schema.NullOr(Schema.String),
  selftest_sent_at: Schema.NullOr(Schema.Int),
  selftest_confirmed_at: Schema.NullOr(Schema.Int),
  selftest_received_at: Schema.NullOr(Schema.String),
  verified_event_pending: Schema.Int,
  created_at: Schema.String,
  updated_at: Schema.String,
});
export type DomainRow = typeof DomainRow.Type;

export function domainWire(row: DomainRow): Domain {
  return {
    domain_id: row.domain_id,
    domain: row.domain,
    feedback_enabled: row.feedback_enabled === 1,
    inbound_enabled: row.inbound_enabled === 1,
    subdomains_enabled: row.subdomains_enabled === 1,
    tracking_enabled: row.tracking_enabled === 1,
    status: row.status,
    records: row.records,
    ...(row.reason === null ? {} : { reason: row.reason }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function repository(store: StoreService) {
  return {
    get: (id: string) =>
      store.use((db) => {
        const row = db.prepare("SELECT * FROM domains WHERE domain_id = ?").get(id);
        return row === undefined ? undefined : Schema.decodeUnknownSync(DomainRow)(row);
      }),
    all: () =>
      store.use((db) =>
        Schema.decodeUnknownSync(Schema.Array(DomainRow))(
          db.prepare("SELECT * FROM domains ORDER BY created_at, domain_id").all(),
        ),
      ),
    resources: (id: string) =>
      store.use((db) =>
        Schema.decodeUnknownSync(Schema.Array(Resource))(
          db
            .prepare("SELECT * FROM provisioned_resources WHERE domain_id = ? ORDER BY sequence")
            .all(id),
        ),
      ),
    record: (
      id: string,
      kind: ResourceKind,
      name: string,
      cloudflareId: string | null,
      owned: boolean,
      parentId: string | null = null,
    ) =>
      store.use((db) => {
        db.prepare(
          "INSERT INTO provisioned_resources (domain_id, kind, name, resource_key, cloudflare_id, parent_id, owned) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(domain_id, kind, resource_key) DO UPDATE SET cloudflare_id = excluded.cloudflare_id, parent_id = excluded.parent_id, owned = excluded.owned",
        ).run(
          id,
          kind,
          name,
          kind === "dns" ? cloudflareId : name,
          cloudflareId,
          parentId,
          Number(owned),
        );
      }),
    forget: (sequence: number) =>
      store.use((db) => {
        db.prepare("DELETE FROM provisioned_resources WHERE sequence = ?").run(sequence);
      }),
    status: (
      id: string,
      status: VerificationStatus,
      phase: DomainRow["phase"],
      now: string,
      reason: string | null = null,
    ) =>
      store.use((db) => {
        db.prepare(
          "UPDATE domains SET status = ?, phase = ?, reason = ?, updated_at = ? WHERE domain_id = ?",
        ).run(status, phase, reason, now, id);
      }),
    records: (id: string, records: readonly VerificationRecord[]) =>
      store.use((db) => {
        db.prepare("UPDATE domains SET records = ? WHERE domain_id = ?").run(
          JSON.stringify(records),
          id,
        );
      }),
  };
}

export const decodeDns = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(DnsRecord)));
