import { appendEvent } from "../events/log.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { domainToASCII } from "node:url";
import { Clock, Context, Effect, Layer, Schema, Semaphore } from "effect";
import type { PaginationQuery } from "../../../../packages/contracts/src/common.js";
import {
  CreateDomainRequest,
  UpdateDomainRequest,
  type ProvisionPlan,
  type VerificationRecord,
} from "../../../../packages/contracts/src/domains.js";
import type { DomainVerifiedEvent } from "../../../../packages/contracts/src/events.js";
import { InboundConfig } from "../inbound/config.js";
import { processInbound } from "../inbound/puller.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { InboundBuffer, type InboundBufferService } from "../inbound/cloudflare.js";
import { Where, keysetWhere, page, preparePage } from "../mailbox/queries.js";
import { MailboxError } from "../mailbox/errors.js";
import { TransportConfig } from "../outbound/transport-config.js";
import { Store } from "../store.js";
import { assertSubdomain, CloudflareApi, type DnsRecord, type Zone } from "./cloudflare-api.js";
import { apexRecords, PublicDns, verificationRecords, bindRecord } from "./dns.js";
import { actionRequired, invalid, ProvisionError, unavailable } from "./errors.js";
import { decodeDns, DomainRow, domainWire, repository, type ResourceKind } from "./repository.js";
import { makeRoutingSync } from "./routing.js";

const steps = [
  "verify_token",
  "find_zone",
  "snapshot_apex",
  "create_sending",
  "disable_preview",
  "enable_subdomain_routing",
  "create_bucket",
  "create_inbound_queue",
  "create_inbound_consumer",
  "create_events_queue",
  "create_events_consumer",
  "generate_identity",
  "upload_worker",
  "disable_worker_public_urls",
  "subscribe_events",
  "store_buffer_settings",
  "verify_public_dns",
  "verify_buffer_selftest",
];
const previewWarning =
  "Sending DKIM and MX priorities are assigned by Cloudflare at creation. Their exact values are unavailable before apply.";
function normalizeDomain(value: string) {
  const domain = domainToASCII(value).toLowerCase();
  if (
    !domain ||
    domain.length > 253 ||
    !domain
      .split(".")
      .every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  )
    throw invalid("A valid literal mail subdomain is required.");
  return domain;
}

export function makeProvisioner(options: {
  readonly store: Store["Service"];
  readonly api: CloudflareApi["Service"];
  readonly dns: PublicDns["Service"];
  readonly inbound: InboundConfig["Service"];
  readonly transport: TransportConfig["Service"];
  readonly mailbox: Mailbox["Service"];
  readonly readWorker?: () => Promise<string>;
  readonly onVerified?: (event: DomainVerifiedEvent) => Effect.Effect<void, ProvisionError>;
  readonly buffer?: InboundBufferService;
}) {
  const { store, api, dns, inbound, transport, mailbox } = options;
  const repo = repository(store);
  const gate = Semaphore.makeUnsafe(1);
  const routing = makeRoutingSync(store, api, gate);
  const now = () => Effect.map(Clock.currentTimeMillis, (value) => new Date(value).toISOString());
  const getRow = (id: string) =>
    Effect.gen(function* () {
      const row = yield* repo.get(id);
      if (row === undefined)
        return yield* new ProvisionError({
          code: "not_found",
          message: "The domain was not found.",
          fix: "Use a registered domain_id.",
        });
      return row;
    });
  const boundAccount = (row: DomainRow) =>
    Effect.gen(function* () {
      if ((yield* api.accountId()) !== row.account_id)
        return yield* actionRequired(
          "The configured Cloudflare account differs from the recorded provisioning account.",
          "Restore the recorded Cloudflare account and token before retrying.",
        );
    });
  const zoneOf = (row: DomainRow): Zone => ({
    id: row.zone_id,
    name: row.zone_name,
    account: { id: row.account_id },
  });
  const nameFor = (row: DomainRow, suffix: string) => `inbot-${row.domain_id}-${suffix}`;
  const checkedDomain = (value: string) =>
    Effect.try({
      try: () => normalizeDomain(value),
      catch: (error) => (error instanceof ProvisionError ? error : invalid("Invalid subdomain.")),
    });
  const findZone = (domain: string) =>
    Effect.gen(function* () {
      const account = yield* api.accountId();
      const labels = domain.split(".");
      for (let index = 0; index < labels.length - 1; index++) {
        const name = labels.slice(index).join(".");
        const zone = (yield* api.zones(name)).find(
          (value) => value.name === name && value.account.id === account,
        );
        if (zone !== undefined) {
          yield* Effect.try({
            try: () => assertSubdomain(zone, domain),
            catch: (error) =>
              error instanceof ProvisionError ? error : invalid("Invalid subdomain."),
          });
          return zone;
        }
      }
      return yield* invalid("The mail subdomain is outside the configured account's zones.");
    });
  const plan = (value: string) =>
    Effect.gen(function* () {
      const domain = yield* checkedDomain(value);
      yield* api.verifyToken();
      const zone = yield* findZone(domain);
      const sending = (yield* api.sendingDomains(zone.id)).find((item) => item.name === domain);
      const routingRecords = yield* api.routingDns(zone, domain);
      const sendingRecords =
        sending === undefined
          ? [
              {
                type: "TXT",
                name: `cf-bounce._domainkey.${domain}`,
                value: "",
                status: "MISSING",
                reason: "Cloudflare assigns the DKIM key during apply.",
              } satisfies VerificationRecord,
              ...Array.from(
                { length: 3 },
                () =>
                  ({
                    type: "MX",
                    name: `cf-bounce.${domain}`,
                    value: "",
                    status: "MISSING",
                    reason: "Cloudflare assigns the sending MX target and priority during apply.",
                  }) satisfies VerificationRecord,
              ),
              {
                type: "TXT",
                name: `cf-bounce.${domain}`,
                value: "v=spf1 include:_spf.mx.cloudflare.net ~all",
                status: "MISSING",
              } satisfies VerificationRecord,
              {
                type: "TXT",
                name: `_dmarc.${domain}`,
                value: "v=DMARC1; p=reject;",
                status: "MISSING",
              } satisfies VerificationRecord,
            ]
          : verificationRecords(yield* api.sendingDns(zone.id, sending.tag));
      return {
        domain,
        steps,
        records: yield* dns.check([...sendingRecords, ...verificationRecords(routingRecords)]),
        warnings: [
          previewWarning,
          "Cloudflare may add cf2024-1._domainkey at the zone apex; Inbot records its ID for conditional cleanup.",
          "Delivery event subscriptions may miss events during their first few minutes.",
        ],
      } satisfies ProvisionPlan;
    });
  const assertApex = (row: DomainRow, records: readonly DnsRecord[]) =>
    Effect.gen(function* () {
      if (row.apex_snapshot === null) return;
      if (JSON.stringify(apexRecords(records, row.zone_name)) !== row.apex_snapshot)
        return yield* actionRequired(
          "The zone apex MX, SPF, or DMARC records changed. Provisioning stopped before further steps.",
        );
    });
  function finishDns(row: DomainRow, current: readonly DnsRecord[]) {
    return Effect.gen(function* () {
      if (row.dns_before !== null) {
        const before = decodeDns(row.dns_before);
        const previousIds = new Set(before.map((record) => record.id));
        const hadDkim = before.some(
          (record) => record.name === `cf2024-1._domainkey.${row.zone_name}`,
        );
        for (const record of current) {
          const allowed =
            record.name === row.domain ||
            record.name.endsWith(`.${row.domain}`) ||
            (!hadDkim &&
              row.dns_step === "routing" &&
              record.name === `cf2024-1._domainkey.${row.zone_name}`);
          if (record.id !== undefined && !previousIds.has(record.id) && allowed)
            yield* repo.record(row.domain_id, "dns", record.name, record.id, true, row.dns_step);
        }
        yield* assertApex(row, current);
      }
      yield* store.use((db) => {
        db.prepare(
          "UPDATE domains SET apex_snapshot = NULL, dns_before = NULL, dns_step = NULL WHERE domain_id = ?",
        ).run(row.domain_id);
      });
    });
  }
  const recoverDns = (row: DomainRow) =>
    Effect.gen(function* () {
      const records = yield* api.dns(row.zone_id);
      yield* finishDns(row, records);
      return records;
    });
  function withDns<A, E, R>(id: string, step: string, effect: Effect.Effect<A, E, R>) {
    return Effect.gen(function* () {
      const row = yield* getRow(id);
      const before = yield* recoverDns(row);
      yield* store.use((db) => {
        db.prepare(
          "UPDATE domains SET apex_snapshot = ?, dns_before = ?, dns_step = ? WHERE domain_id = ?",
        ).run(JSON.stringify(apexRecords(before, row.zone_name)), JSON.stringify(before), step, id);
      });
      const result = yield* effect.pipe(Effect.result);
      yield* finishDns(yield* getRow(id), yield* api.dns(row.zone_id));
      return yield* Effect.fromResult(result);
    });
  }
  const invalidateVerification = (id: string) =>
    store.use((db) => {
      db.prepare(
        "UPDATE domains SET selftest_token = NULL, selftest_sent_at = NULL, selftest_confirmed_at = NULL, selftest_received_at = NULL, verified_event_pending = 0, status = CASE WHEN status = 'VERIFIED' THEN 'VERIFYING' ELSE status END WHERE domain_id = ?",
      ).run(id);
    });
  function ensureResource(
    id: string,
    kind: ResourceKind,
    name: string,
    find: () => Effect.Effect<
      string | undefined,
      ProvisionError | import("../store.js").DatabaseError
    >,
    create: () => Effect.Effect<string, ProvisionError | import("../store.js").DatabaseError>,
    parentId: string | null = null,
  ) {
    return Effect.gen(function* () {
      const previous = (yield* repo.resources(id)).find(
        (resource) => resource.kind === kind && resource.name === name,
      );
      const existing = yield* find();
      if (existing !== undefined) {
        if (
          previous?.cloudflare_id !== null &&
          previous?.cloudflare_id !== undefined &&
          previous.cloudflare_id !== existing
        )
          yield* invalidateVerification(id);
        yield* repo.record(
          id,
          kind,
          name,
          existing,
          previous?.owned === 1 &&
            (previous.cloudflare_id === null || previous.cloudflare_id === existing),
          parentId,
        );
        return existing;
      }
      yield* invalidateVerification(id);
      yield* repo.record(id, kind, name, null, true, parentId);
      const resourceId = yield* create();
      yield* repo.record(id, kind, name, resourceId, true, parentId);
      return resourceId;
    });
  }
  const recordFailure = (id: string) => (error: ProvisionError) =>
    Effect.gen(function* () {
      if (error.code === "action_required")
        yield* repo.status(id, "FAILED", "action_required", yield* now(), error.message);
      else
        yield* store.use((db) => {
          db.prepare("UPDATE domains SET reason = ? WHERE domain_id = ?").run(error.message, id);
        });
      return yield* error;
    });
  const apply = (id: string) =>
    gate.withPermit(
      Effect.gen(function* () {
        const row = yield* getRow(id);
        if (row.phase === "tearing_down")
          return yield* invalid(
            "Finish teardown before applying this domain.",
            "Retry teardown until it completes, then apply the domain again.",
          );
        yield* api.verifyToken();
        yield* boundAccount(row);
        const zone = yield* findZone(row.domain);
        if (zone.id !== row.zone_id)
          return yield* actionRequired(
            "The Cloudflare zone no longer matches the registered zone.",
            "Restore access to the recorded zone before retrying.",
          );
        yield* Effect.all(
          [
            api.sendingDomains(zone.id),
            api.routingDns(zone, row.domain),
            api.rules(zone.id),
            api.buckets(),
            api.queues(),
            api.workers(),
            api.subscriptions(),
          ],
          { concurrency: 4 },
        );
        const configured = yield* inbound.get();
        const bucketName = nameFor(row, "inbound");
        if (configured !== undefined && configured.bucket !== bucketName)
          return yield* new ProvisionError({
            code: "resource_taken",
            message: "An inbound buffer is already configured for another domain.",
            fix: "Teardown the existing buffer before applying another domain.",
          });
        yield* repo.status(
          id,
          row.status === "VERIFIED" ? "VERIFIED" : "PENDING",
          "applying",
          yield* now(),
        );
        yield* recoverDns(row);
        const sending = yield* ensureResource(
          id,
          "sending",
          row.domain,
          () =>
            Effect.map(
              api.sendingDomains(zone.id),
              (items) => items.find((item) => item.name === row.domain)?.tag,
            ),
          () =>
            withDns(
              id,
              "sending",
              Effect.map(api.createSending(zone, row.domain), (item) => item.tag),
            ),
        );
        yield* withDns(id, "preview", api.disablePreview(zone.id, sending));
        if ((yield* api.getSending(zone.id, sending)).preview_enabled !== false)
          return yield* actionRequired(
            "Cloudflare did not confirm that message preview is disabled.",
            "Disable sending previews for this subdomain and retry apply before routing mail.",
          );
        const routeDns = yield* api.routingDns(zone, row.domain);
        const routingMx = routeDns.filter(
          (record) => record.type === "MX" && record.name === row.domain,
        );
        if (routingMx.length === 0) return yield* unavailable();
        const existingDns = yield* api.dns(zone.id);
        const alreadyRouted = routingMx.every((record) =>
          existingDns.some(
            (existing) =>
              existing.name === record.name &&
              existing.type === record.type &&
              existing.content === record.content &&
              existing.priority === record.priority,
          ),
        );
        const previousRoute = (yield* repo.resources(id)).find(
          (resource) => resource.kind === "routing",
        );
        if (!alreadyRouted) {
          yield* invalidateVerification(id);
          yield* repo.record(id, "routing", row.domain, null, true);
          yield* withDns(id, "routing", api.enableRouting(zone, row.domain));
        }
        yield* repo.record(
          id,
          "routing",
          row.domain,
          row.domain,
          previousRoute?.owned === 1 || !alreadyRouted,
        );
        yield* ensureResource(
          id,
          "bucket",
          bucketName,
          () =>
            Effect.map(api.buckets(), (items) =>
              items.includes(bucketName) ? bucketName : undefined,
            ),
          () => api.createBucket(bucketName),
        );
        const inboundQueue = yield* ensureResource(
          id,
          "inbound_queue",
          bucketName,
          () =>
            Effect.map(
              api.queues(),
              (items) => items.find((item) => item.queue_name === bucketName)?.queue_id,
            ),
          () => Effect.map(api.createQueue(bucketName), (item) => item.queue_id),
        );
        yield* ensureResource(
          id,
          "inbound_consumer",
          bucketName,
          () =>
            Effect.map(
              api.consumers(inboundQueue),
              (items) => items.find((item) => item.type === "http_pull")?.consumer_id,
            ),
          () => Effect.map(api.createConsumer(inboundQueue), (item) => item.consumer_id),
          inboundQueue,
        );
        const eventsName = nameFor(row, "events");
        const eventsQueue = yield* ensureResource(
          id,
          "events_queue",
          eventsName,
          () =>
            Effect.map(
              api.queues(),
              (items) => items.find((item) => item.queue_name === eventsName)?.queue_id,
            ),
          () => Effect.map(api.createQueue(eventsName), (item) => item.queue_id),
        );
        yield* api.configureEventsQueue(eventsQueue, eventsName);
        yield* ensureResource(
          id,
          "events_consumer",
          eventsName,
          () =>
            Effect.map(
              api.consumers(eventsQueue),
              (items) => items.find((item) => item.type === "http_pull")?.consumer_id,
            ),
          () => Effect.map(api.createConsumer(eventsQueue), (item) => item.consumer_id),
          eventsQueue,
        );
        yield* inbound.generateInboundIdentity();
        const recipient = yield* inbound.getRecipient();
        if (recipient === undefined) return yield* unavailable();
        const worker = nameFor(row, "inbound");
        yield* ensureResource(
          id,
          "worker",
          worker,
          () => Effect.map(api.workers(), (items) => (items.includes(worker) ? worker : undefined)),
          () =>
            Effect.gen(function* () {
              const source = yield* Effect.tryPromise({
                try:
                  options.readWorker ??
                  (() =>
                    readFile(new URL("../../../../worker/inbound.js", import.meta.url), "utf8")),
                catch: () =>
                  new ProvisionError({
                    code: "service_unavailable",
                    message: "The bundled inbound Worker is unavailable.",
                    fix: "Run pnpm build:worker and ship dist/worker/inbound.js with the server.",
                  }),
              });
              yield* api.uploadWorker({
                name: worker,
                bucket: bucketName,
                queue: bucketName,
                recipient,
                source,
              });
              return worker;
            }),
        );
        yield* api.disableWorkerPublicUrls(worker);
        yield* ensureResource(
          id,
          "subscription",
          eventsName,
          () =>
            Effect.map(
              api.subscriptions(),
              (items) =>
                items.find(
                  (item) =>
                    item.name === eventsName &&
                    item.source.type === "email.sending" &&
                    item.source.zone_id === zone.id &&
                    item.source.domain === row.domain &&
                    item.destination.queue_id === eventsQueue &&
                    item.enabled,
                )?.id,
            ),
          () =>
            Effect.map(
              api.createSubscription(zone.id, row.domain, eventsQueue, eventsName),
              (item) => item.id,
            ),
        );
        yield* inbound.set({
          account_id: row.account_id,
          bucket: bucketName,
          inbound_queue_id: inboundQueue,
          events_queue_id: eventsQueue,
        });
        let updated = yield* getRow(id);
        const records = [
          ...verificationRecords(yield* api.sendingDns(zone.id, sending)),
          ...verificationRecords(yield* api.routingDns(zone, row.domain)),
        ];
        const specs = (items: readonly VerificationRecord[]) =>
          items
            .map((record) =>
              JSON.stringify([record.type, record.name, record.value, record.priority]),
            )
            .sort()
            .join("\n");
        if (updated.status === "VERIFIED" && specs(records) !== specs(updated.records)) {
          yield* invalidateVerification(id);
          updated = yield* getRow(id);
        }
        yield* repo.records(
          id,
          records.map((record) => ({
            ...record,
            status:
              updated.status === "VERIFIED" &&
              updated.records.some(
                (previous) =>
                  previous.name === record.name &&
                  previous.type === record.type &&
                  previous.value === record.value &&
                  previous.priority === record.priority &&
                  previous.status === "VALID",
              )
                ? "VALID"
                : "MISSING",
          })),
        );
        yield* repo.status(
          id,
          updated.status === "VERIFIED" ? "VERIFIED" : "VERIFYING",
          "ready",
          yield* now(),
        );
        yield* routing.enqueue(id);
        return domainWire(yield* getRow(id));
      }).pipe(Effect.catchTag("ProvisionError", recordFailure(id))),
    );

  const verify = (id: string) =>
    gate.withPermit(
      Effect.gen(function* () {
        let row = yield* getRow(id);
        yield* boundAccount(row);
        if (row.phase !== "ready")
          return yield* invalid(
            "Apply the domain before verifying mail delivery.",
            "Apply the domain resources, then verify the domain again.",
          );
        yield* recoverDns(row);
        const records = yield* dns.check(row.records);
        yield* repo.records(id, records);
        if (records.length === 0 || records.some((record) => record.status !== "VALID")) {
          yield* repo.status(
            id,
            "VERIFYING",
            "ready",
            yield* now(),
            "Waiting for public DNS propagation.",
          );
          return domainWire(yield* getRow(id));
        }
        const zone = zoneOf(row);
        const worker = nameFor(row, "inbound");
        const address = `inbot-selftest@${row.domain}`;
        const ruleName = nameFor(row, "selftest");
        if (row.selftest_received_at === null)
          yield* ensureResource(
            id,
            "selftest_rule",
            ruleName,
            () =>
              Effect.map(
                api.rules(zone.id),
                (items) =>
                  items.find(
                    (rule) =>
                      rule.name === ruleName &&
                      rule.enabled &&
                      rule.matchers.length === 1 &&
                      rule.matchers[0]?.type === "literal" &&
                      rule.matchers[0].value === address &&
                      rule.actions[0]?.type === "worker" &&
                      rule.actions[0].value?.[0] === worker,
                  )?.id,
              ),
            () => Effect.map(api.createRule(zone, address, worker, ruleName), (rule) => rule.id),
          );
        row = yield* getRow(id);
        if (row.selftest_token === null) {
          const token = randomBytes(32).toString("hex");
          yield* store.use((db) => {
            db.prepare("UPDATE domains SET selftest_token = ? WHERE domain_id = ?").run(token, id);
          });
        }
        row = yield* getRow(id);
        const millis = yield* Clock.currentTimeMillis;
        if (
          row.selftest_received_at === null &&
          (row.selftest_sent_at === null || millis - row.selftest_sent_at >= 5 * 60 * 1000)
        ) {
          const token = row.selftest_token;
          if (token === null) return yield* unavailable();
          yield* store.use((db) => {
            db.prepare(
              "UPDATE domains SET selftest_sent_at = ?, selftest_confirmed_at = NULL WHERE domain_id = ?",
            ).run(millis, id);
          });
          yield* api.sendSelfTest(row.domain, token);
          yield* store.use((db) => {
            db.prepare("UPDATE domains SET selftest_confirmed_at = ? WHERE domain_id = ?").run(
              millis,
              id,
            );
          });
        }
        const pull = processInbound().pipe(
          Effect.provideService(Store, store),
          Effect.provideService(Mailbox, mailbox),
          Effect.provideService(InboundConfig, inbound),
          Effect.provideService(TransportConfig, transport),
        );
        yield* options.buffer === undefined
          ? pull
          : pull.pipe(Effect.provideService(InboundBuffer, options.buffer));
        row = yield* getRow(id);
        if (row.selftest_received_at === null) {
          yield* repo.status(
            id,
            "VERIFYING",
            "ready",
            yield* now(),
            row.selftest_confirmed_at === null
              ? "The self-test send was attempted, but its outcome is unconfirmed. Verification will retry after five minutes or accept an observed encrypted arrival."
              : "Waiting for the encrypted self-test message to arrive through the buffer.",
          );
          return domainWire(yield* getRow(id));
        }
        for (const resource of yield* repo.resources(id))
          if (resource.kind === "selftest_rule" && resource.cloudflare_id !== null) {
            if (resource.owned === 1) yield* api.deleteRule(zone.id, resource.cloudflare_id);
            yield* repo.forget(resource.sequence);
          }
        yield* store.use((db) =>
          db
            .transaction(() => {
              db.prepare(
                "UPDATE domains SET verified_event_pending = CASE WHEN status = 'VERIFIED' THEN verified_event_pending ELSE 1 END, status = 'VERIFIED', reason = NULL, updated_at = ? WHERE domain_id = ?",
              ).run(new Date(millis).toISOString(), id);
              const verified = Schema.decodeUnknownSync(DomainRow)(
                db.prepare("SELECT * FROM domains WHERE domain_id = ?").get(id),
              );
              appendEvent(
                db,
                {
                  type: "event",
                  event_type: "domain.verified",
                  event_id: `domain-${id}-${createHash("sha256")
                    .update(verified.selftest_token ?? "")
                    .digest("hex")}`,
                  domain: domainWire(verified),
                },
                millis,
              );
              if (options.onVerified === undefined)
                db.prepare("UPDATE domains SET verified_event_pending = 0 WHERE domain_id = ?").run(
                  id,
                );
            })
            .immediate(),
        );
        row = yield* getRow(id);
        if (row.verified_event_pending === 1 && options.onVerified !== undefined) {
          yield* options.onVerified({
            type: "event",
            event_type: "domain.verified",
            event_id: `domain-${id}-${createHash("sha256")
              .update(row.selftest_token ?? "")
              .digest("hex")}`,
            domain: domainWire(row),
          });
          yield* store.use((db) => {
            db.prepare("UPDATE domains SET verified_event_pending = 0 WHERE domain_id = ?").run(id);
          });
        }
        return domainWire(yield* getRow(id));
      }).pipe(Effect.catchTag("ProvisionError", recordFailure(id))),
    );

  const teardown = (id: string) =>
    gate.withPermit(
      Effect.gen(function* () {
        const row = yield* getRow(id);
        yield* boundAccount(row);
        yield* recoverDns(row);
        yield* store.use((db) => {
          db.prepare(
            "UPDATE inbox_routing_rules SET desired = 0, next_attempt_at = 0 WHERE domain_id = ?",
          ).run(id);
        });
        yield* routing.removeAll(id);
        const bucketName = nameFor(row, "inbound");
        if (
          (yield* repo.resources(id)).some((resource) => resource.kind === "bucket") &&
          (yield* api.buckets()).includes(bucketName)
        ) {
          const settings = yield* transport.get();
          if (settings === undefined)
            return yield* invalid(
              "Configure the recorded Cloudflare transport before teardown.",
              "Configure the recorded Cloudflare account and token in Settings, then retry teardown.",
            );
          const buffer =
            options.buffer ??
            (yield* InboundBuffer.pipe(
              Effect.provide(InboundBuffer.live({ ...settings, bucket: bucketName })),
            ));
          const remaining = yield* buffer.listObjects("");
          if (remaining.objects.length > 0 || remaining.cursor !== undefined)
            return yield* new ProvisionError({
              code: "action_required",
              message:
                "The inbound bucket still contains encrypted mail. Teardown stopped before resource deletion.",
              fix: "Drain the buffer and review quarantined objects before retrying teardown.",
            });
        }
        yield* repo.status(id, "PENDING", "tearing_down", yield* now());
        for (const resource of yield* repo.resources(id)) {
          if (resource.cloudflare_id !== null || resource.owned !== 1) continue;
          let remoteId: string | undefined;
          if (resource.kind === "sending")
            remoteId = (yield* api.sendingDomains(row.zone_id)).find(
              (item) => item.name === resource.name,
            )?.tag;
          else if (resource.kind === "bucket")
            remoteId = (yield* api.buckets()).find((name) => name === resource.name);
          else if (resource.kind === "inbound_queue" || resource.kind === "events_queue")
            remoteId = (yield* api.queues()).find(
              (item) => item.queue_name === resource.name,
            )?.queue_id;
          else if (
            (resource.kind === "inbound_consumer" || resource.kind === "events_consumer") &&
            resource.parent_id !== null
          )
            remoteId = (yield* api.consumers(resource.parent_id)).find(
              (item) => item.type === "http_pull",
            )?.consumer_id;
          else if (resource.kind === "worker")
            remoteId = (yield* api.workers()).find((name) => name === resource.name);
          else if (resource.kind === "subscription")
            remoteId = (yield* api.subscriptions()).find((item) => item.name === resource.name)?.id;
          else if (resource.kind === "selftest_rule")
            remoteId = (yield* api.rules(row.zone_id)).find(
              (item) => item.name === resource.name,
            )?.id;
          if (remoteId !== undefined)
            yield* repo.record(
              id,
              resource.kind,
              resource.name,
              remoteId,
              true,
              resource.parent_id,
            );
        }
        const resources = (yield* repo.resources(id)).toReversed();
        const sendingIndex = resources.findIndex((resource) => resource.kind === "sending");
        const sendingDnsIndex = resources.findIndex(
          (resource) =>
            resource.kind === "dns" &&
            (resource.parent_id === "sending" || resource.parent_id === "preview"),
        );
        if (sendingDnsIndex >= 0 && sendingIndex > sendingDnsIndex) {
          const [sending] = resources.splice(sendingIndex, 1);
          if (sending !== undefined) resources.splice(sendingDnsIndex, 0, sending);
        }
        let routingUnlocked = false;
        for (const resource of resources) {
          const remoteId = resource.cloudflare_id;
          if (resource.owned === 1 && remoteId !== null) {
            if (resource.kind === "dns") {
              if (resource.name === `cf2024-1._domainkey.${row.zone_name}`) {
                const records = yield* api.dns(row.zone_id);
                if (
                  records.some(
                    (record) =>
                      record.type === "MX" &&
                      record.name !== row.domain &&
                      !record.name.startsWith("cf-bounce.") &&
                      /\.mx\.cloudflare\.net\.?$/.test(record.content),
                  )
                )
                  continue;
              }
              if (resource.parent_id === "routing" && !routingUnlocked) {
                yield* withDns(
                  id,
                  "unlock_routing_dns",
                  api.unlockRoutingDns(zoneOf(row), row.domain),
                );
                routingUnlocked = true;
              }
              yield* withDns(id, "delete_dns", api.deleteDns(row.zone_id, remoteId));
            } else if (resource.kind === "sending")
              yield* withDns(id, "delete_sending", api.deleteSending(row.zone_id, remoteId));
            else if (resource.kind === "selftest_rule")
              yield* api.deleteRule(row.zone_id, remoteId);
            else if (resource.kind === "subscription") yield* api.deleteSubscription(remoteId);
            else if (resource.kind === "worker") yield* api.deleteWorker(remoteId);
            else if (resource.kind === "inbound_consumer" || resource.kind === "events_consumer") {
              if (resource.parent_id !== null)
                yield* api.deleteConsumer(resource.parent_id, remoteId);
            } else if (resource.kind === "inbound_queue" || resource.kind === "events_queue")
              yield* api.deleteQueue(remoteId);
            else if (resource.kind === "bucket") yield* api.deleteBucket(remoteId);
          }
          yield* repo.forget(resource.sequence);
        }
        const configured = yield* inbound.get();
        if (configured?.bucket === bucketName) yield* inbound.clear();
        yield* store.use((db) => {
          db.prepare(
            "UPDATE domains SET selftest_token = NULL, selftest_sent_at = NULL, selftest_confirmed_at = NULL, selftest_received_at = NULL, verified_event_pending = 0 WHERE domain_id = ?",
          ).run(id);
        });
        yield* repo.status(id, "NOT_STARTED", "registered", yield* now());
        return domainWire(yield* getRow(id));
      }).pipe(Effect.catchTag("ProvisionError", recordFailure(id))),
    );
  return {
    withConfigurationLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => gate.withPermit(effect),
    plan,
    apply,
    verify,
    teardown,
    routing,
    get: (id: string) => Effect.map(getRow(id), domainWire),
    create: (input: CreateDomainRequest) =>
      gate.withPermit(
        Effect.gen(function* () {
          yield* Schema.decodeUnknownEffect(CreateDomainRequest)(input).pipe(
            Effect.mapError(() =>
              invalid("Invalid domain request.", "Use the declared domain registration fields."),
            ),
          );
          if (input.allow_conflicting_provider === true)
            return yield* invalid(
              "Inbot never allows conflicting apex providers.",
              "Set allow_conflicting_provider to false and use a dedicated mail subdomain.",
            );
          if (
            input.feedback_enabled === true ||
            input.tracking_enabled === true ||
            input.subdomains_enabled === true ||
            input.inbound_enabled === false
          )
            return yield* invalid(
              "Provisioning supports inbound email on one literal subdomain without tracking or feedback.",
              "Enable inbound mail and disable feedback, tracking, and wildcard subdomains.",
            );
          const domain = yield* checkedDomain(input.domain);
          const existing = (yield* repo.all()).find((row) => row.domain === domain);
          if (existing !== undefined) return domainWire(existing);
          if ((yield* repo.all()).length > 0)
            return yield* invalid(
              "This Inbot instance supports one registered mail subdomain.",
              "Use the existing registration, or tear it down and delete it before registering another domain.",
            );
          const planned = yield* plan(domain);
          const zone = yield* findZone(domain);
          const conflicting = yield* store.use(
            (db) =>
              db
                .prepare("SELECT 1 FROM inboxes WHERE inbox_id = ?")
                .get(`inbot-selftest@${domain}`) !== undefined,
          );
          if (conflicting)
            return yield* invalid(
              "The inbot-selftest address is reserved for domain verification.",
              "Remove the inbox using the reserved inbot-selftest address, then register the domain again.",
            );
          const timestamp = yield* now();
          const id = randomUUID();
          yield* store.use((db) => {
            db.prepare(
              "INSERT INTO domains (domain_id, domain, account_id, zone_id, zone_name, status, records, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'NOT_STARTED', ?, ?, ?, ?)",
            ).run(
              id,
              domain,
              zone.account.id,
              zone.id,
              zone.name,
              JSON.stringify(planned.records),
              previewWarning,
              timestamp,
              timestamp,
            );
          });
          return domainWire(yield* getRow(id));
        }),
      ),
    update: (id: string, input: UpdateDomainRequest) =>
      Effect.gen(function* () {
        yield* getRow(id);
        yield* Schema.decodeUnknownEffect(UpdateDomainRequest)(input).pipe(
          Effect.mapError(() =>
            invalid("Invalid domain update.", "Use the declared domain update fields."),
          ),
        );
        if (
          input.feedback_enabled === true ||
          input.tracking_enabled === true ||
          input.subdomains_enabled === true ||
          input.inbound_enabled === false
        )
          return yield* invalid(
            "The requested domain feature is unsupported by subdomain provisioning.",
            "Enable inbound mail and disable feedback, tracking, and wildcard subdomains.",
          );
        return domainWire(yield* getRow(id));
      }),
    delete: (id: string) =>
      gate.withPermit(
        Effect.gen(function* () {
          yield* getRow(id);
          if ((yield* repo.resources(id)).length > 0)
            return yield* invalid(
              "Teardown all recorded resources before deleting the domain.",
              "Complete domain teardown, then delete the registration again.",
            );
          yield* store.use((db) => {
            db.transaction(() => {
              db.prepare("DELETE FROM inbox_routing_rules WHERE domain_id = ?").run(id);
              db.prepare("DELETE FROM domains WHERE domain_id = ?").run(id);
            }).immediate();
          });
        }),
      ),
    list: (query: typeof PaginationQuery.Type = {}) =>
      Effect.gen(function* () {
        const { limit, expected, cursor } = yield* Effect.try({
          try: () =>
            preparePage(query, { resource: "domains", ascending: query.ascending ?? false }),
          catch: (error) =>
            error instanceof MailboxError
              ? error
              : invalid("Invalid domain pagination query.", "Use the declared pagination fields."),
        });
        return yield* store.use((db) => {
          const where = new Where();
          keysetWhere(where, cursor, "created_at", "domain_id", query.ascending ?? false);
          const order = query.ascending ? "ASC" : "DESC";
          const rows = db
            .prepare(
              `SELECT *, created_at AS cursor_key, domain_id AS cursor_id FROM domains WHERE ${where.sql} ORDER BY created_at ${order}, domain_id ${order} LIMIT ?`,
            )
            .all(...where.params, limit + 1);
          const { items, ...fields } = page(rows, limit, expected, (row) =>
            domainWire(Schema.decodeUnknownSync(DomainRow)(row)),
          );
          return { ...fields, domains: items };
        });
      }),
    zoneFile: (id: string) =>
      Effect.map(getRow(id), (row) => row.records.map(bindRecord).join("\n") + "\n"),
    verifyPending: () =>
      Effect.gen(function* () {
        for (const row of yield* repo.all())
          if (
            row.phase === "ready" &&
            (row.status === "VERIFYING" ||
              (row.verified_event_pending === 1 && options.onVerified !== undefined))
          )
            yield* verify(row.domain_id).pipe(
              Effect.catchTag("ProvisionError", () => Effect.void),
              Effect.catchTag("BufferError", () => Effect.void),
            );
      }),
  };
}

export type ProvisionerService = ReturnType<typeof makeProvisioner>;
export class Provisioner extends Context.Service<Provisioner, ProvisionerService>()(
  "inbot/Provisioner",
) {
  static readonly Live = Layer.effect(
    Provisioner,
    Effect.gen(function* () {
      return makeProvisioner({
        store: yield* Store,
        api: yield* CloudflareApi,
        dns: yield* PublicDns,
        inbound: yield* InboundConfig,
        transport: yield* TransportConfig,
        mailbox: yield* Mailbox,
      });
    }),
  );
}
