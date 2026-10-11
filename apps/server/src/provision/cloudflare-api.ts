import { Context, Effect, Layer, Redacted, Schema } from "effect";
import {
  cloudflareTokenPermissions,
  cloudflareTunnelPermission,
} from "../../../../packages/contracts/src/cloudflare-permissions.js";
import { TransportConfig } from "../outbound/transport-config.js";
import type { DatabaseError } from "../store.js";
import { invalid, missingPermission, ProvisionError, unavailable } from "./errors.js";

export const DnsRecord = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  name: Schema.String,
  type: Schema.String,
  content: Schema.String,
  priority: Schema.optionalKey(Schema.Int),
  ttl: Schema.optionalKey(Schema.Int),
  proxied: Schema.optionalKey(Schema.Boolean),
  comment: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type DnsRecord = typeof DnsRecord.Type;
export const Account = Schema.Struct({ id: Schema.String, name: Schema.String });
export const Zone = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  account: Schema.Struct({ id: Schema.String }),
});
export type Zone = typeof Zone.Type;
export const SendingDomain = Schema.Struct({
  tag: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  preview_enabled: Schema.optionalKey(Schema.Boolean),
});
export type SendingDomain = typeof SendingDomain.Type;
export const Rule = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  enabled: Schema.Boolean,
  matchers: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      field: Schema.optionalKey(Schema.String),
      value: Schema.optionalKey(Schema.String),
    }),
  ),
  actions: Schema.Array(
    Schema.Struct({ type: Schema.String, value: Schema.optionalKey(Schema.Array(Schema.String)) }),
  ),
});
export type Rule = typeof Rule.Type;
export const Queue = Schema.Struct({ queue_id: Schema.String, queue_name: Schema.String });
export type Queue = typeof Queue.Type;
export const Consumer = Schema.Struct({ consumer_id: Schema.String, type: Schema.String });
export type Consumer = typeof Consumer.Type;
export const Subscription = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  source: Schema.Struct({
    type: Schema.String,
    zone_id: Schema.optionalKey(Schema.String),
    domain: Schema.optionalKey(Schema.String),
  }),
  destination: Schema.Struct({ type: Schema.String, queue_id: Schema.String }),
  events: Schema.Array(Schema.String),
});
export type Subscription = typeof Subscription.Type;
export const Tunnel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  config_src: Schema.optionalKey(Schema.String),
  remote_config: Schema.optionalKey(Schema.Boolean),
});
export type Tunnel = typeof Tunnel.Type;
export const remoteTokenPermission = cloudflareTunnelPermission.apiPermission;

export const sendingEvents = [
  "message.delivered",
  "message.deferred",
  "message.bounced",
  "message.failed",
  "message.rejected",
  "message.complained",
];
export const tokenPermissions = cloudflareTokenPermissions
  .filter((permission) => permission.key !== cloudflareTunnelPermission.key)
  .map((permission) => permission.apiPermission);
type ApiEffect<A> = Effect.Effect<A, ProvisionError | DatabaseError>;
export interface WorkerInput {
  readonly name: string;
  readonly source: string;
  readonly bucket: string;
  readonly queue: string;
  readonly recipient: string;
}
export interface CloudflareApiService {
  readonly accountId: () => ApiEffect<string>;
  readonly tunnels: () => ApiEffect<readonly Tunnel[]>;
  readonly createTunnel: (name: string) => ApiEffect<Tunnel>;
  readonly configureTunnel: (id: string, hostname: string, origin: string) => ApiEffect<void>;
  readonly tunnelToken: (id: string) => ApiEffect<Redacted.Redacted<string>>;
  readonly deleteTunnel: (id: string) => ApiEffect<void>;
  readonly createTunnelDns: (
    zone: Zone,
    hostname: string,
    tunnelId: string,
    marker: string,
  ) => ApiEffect<DnsRecord>;
  readonly verifyToken: () => ApiEffect<void>;
  readonly accounts: () => ApiEffect<readonly (typeof Account.Type)[]>;
  readonly verifyUserToken: () => ApiEffect<void>;
  readonly zones: (name: string) => ApiEffect<readonly Zone[]>;
  readonly dns: (zoneId: string) => ApiEffect<readonly DnsRecord[]>;
  readonly exportDns: (zoneId: string) => ApiEffect<string>;
  readonly deleteDns: (zoneId: string, id: string) => ApiEffect<void>;
  readonly sendingDomains: (zoneId: string) => ApiEffect<readonly SendingDomain[]>;
  readonly getSending: (zoneId: string, id: string) => ApiEffect<SendingDomain>;
  readonly createSending: (zone: Zone, domain: string) => ApiEffect<SendingDomain>;
  readonly disablePreview: (zoneId: string, id: string) => ApiEffect<void>;
  readonly deleteSending: (zoneId: string, id: string) => ApiEffect<void>;
  readonly sendingDns: (zoneId: string, id: string) => ApiEffect<readonly DnsRecord[]>;
  readonly routingDns: (zone: Zone, domain: string) => ApiEffect<readonly DnsRecord[]>;
  readonly enableRouting: (zone: Zone, domain: string) => ApiEffect<void>;
  readonly unlockRoutingDns: (zone: Zone, domain: string) => ApiEffect<void>;
  readonly disableRouting: (zone: Zone, domain: string) => ApiEffect<void>;
  readonly rules: (zoneId: string) => ApiEffect<readonly Rule[]>;
  readonly createRule: (
    zone: Zone,
    address: string,
    worker: string,
    name: string,
  ) => ApiEffect<Rule>;
  readonly deleteRule: (zoneId: string, id: string) => ApiEffect<void>;
  readonly buckets: () => ApiEffect<readonly string[]>;
  readonly createBucket: (name: string) => ApiEffect<string>;
  readonly deleteBucket: (name: string) => ApiEffect<void>;
  readonly queues: () => ApiEffect<readonly Queue[]>;
  readonly createQueue: (name: string) => ApiEffect<Queue>;
  readonly deleteQueue: (id: string) => ApiEffect<void>;
  readonly configureEventsQueue: (id: string, name: string) => ApiEffect<void>;
  readonly consumers: (queueId: string) => ApiEffect<readonly Consumer[]>;
  readonly createConsumer: (queueId: string) => ApiEffect<Consumer>;
  readonly deleteConsumer: (queueId: string, id: string) => ApiEffect<void>;
  readonly workers: () => ApiEffect<readonly string[]>;
  readonly uploadWorker: (input: WorkerInput) => ApiEffect<void>;
  readonly disableWorkerPublicUrls: (name: string) => ApiEffect<void>;
  readonly deleteWorker: (name: string) => ApiEffect<void>;
  readonly subscriptions: () => ApiEffect<readonly Subscription[]>;
  readonly createSubscription: (
    zoneId: string,
    domain: string,
    queueId: string,
    name: string,
  ) => ApiEffect<Subscription>;
  readonly deleteSubscription: (id: string) => ApiEffect<void>;
  readonly sendSelfTest: (domain: string, token: string) => ApiEffect<void>;
}

export function assertSubdomain(zone: Zone, domain: string) {
  if (
    domain === zone.name ||
    !domain.endsWith(`.${zone.name}`) ||
    domain.includes("*") ||
    domain.includes("@")
  )
    throw invalid("Email provisioning requires a literal subdomain, never the zone apex.");
}

const ApiEnvelope = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.optionalKey(Schema.Unknown),
  result_info: Schema.optionalKey(
    Schema.Struct({
      total_pages: Schema.optionalKey(Schema.Int),
      cursor: Schema.optionalKey(Schema.String),
      is_truncated: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
function operationName(path: string, method = "GET") {
  const resources: ReadonlyArray<readonly [string, string]> = [
    ["/tokens/verify", "token verification"],
    ["/cfd_tunnel", "tunnel"],
    ["/dns_records/export", "DNS export"],
    ["/dns_records", "DNS records"],
    ["/email/sending/subdomains", "sending subdomain"],
    ["/email/routing/dns", "routing DNS"],
    ["/email/routing/rules", "routing rule"],
    ["/r2/buckets", "R2 bucket"],
    ["/consumers", "queue consumer"],
    ["/queues", "queue"],
    ["/workers/scripts", "Worker"],
    ["/event_subscriptions/subscriptions", "event subscription"],
    ["/email/sending/send", "self-test send"],
    ["/zones", "zone"],
  ];
  const kind = resources.find(([part]) => path.includes(part))?.[1];
  return `${method} ${kind ?? "Cloudflare resource"}`;
}
const Token = Schema.Struct({ status: Schema.Literal("active") });
const Id = Schema.Struct({ id: Schema.String });
const Name = Schema.Struct({ name: Schema.String });
const BucketList = Schema.Struct({ buckets: Schema.optionalKey(Schema.Array(Name)) });

export class CloudflareApi extends Context.Service<CloudflareApi, CloudflareApiService>()(
  "inbot/CloudflareApi",
) {
  static live(options: { readonly fetch?: typeof globalThis.fetch } = {}) {
    return Layer.effect(
      CloudflareApi,
      Effect.gen(function* () {
        const config = yield* TransportConfig;
        const fetch = options.fetch ?? globalThis.fetch;
        const settings = () =>
          Effect.gen(function* () {
            const value = yield* config.get();
            if (value === undefined)
              return yield* invalid(
                "Configure a Cloudflare transport token first.",
                "Configure the Cloudflare mail transport in Settings, then register the domain again.",
              );
            return value;
          });
        const accountId = () => Effect.map(settings(), (value) => value.account_id);
        const account = (suffix: string) =>
          Effect.map(accountId(), (id) => `/accounts/${encodeURIComponent(id)}${suffix}`);
        function request(path: string, permission: string, method = "GET", body?: unknown) {
          const operation = operationName(path, method);
          return Effect.gen(function* () {
            const value = yield* settings();
            return yield* Effect.tryPromise({
              try: async (signal) => {
                const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
                  method,
                  redirect: "error",
                  signal,
                  headers: {
                    Authorization: `Bearer ${Redacted.value(value.api_token)}`,
                    ...(body === undefined || body instanceof FormData
                      ? {}
                      : { "Content-Type": "application/json" }),
                  },
                  ...(body === undefined
                    ? {}
                    : { body: body instanceof FormData ? body : JSON.stringify(body) }),
                });
                if (
                  response.status === 401 ||
                  response.status === 403 ||
                  (response.status === 404 && path.endsWith("/tokens/verify"))
                )
                  throw missingPermission(permission, operation);
                if (response.status === 404 && method === "DELETE") return { success: true };
                if (!response.ok) throw unavailable(operation);
                return Schema.decodeUnknownSync(ApiEnvelope)(await response.json());
              },
              catch: (error) => (error instanceof ProvisionError ? error : unavailable(operation)),
            }).pipe(
              Effect.timeoutOrElse({
                duration: "30 seconds",
                orElse: () => Effect.fail(unavailable(operation)),
              }),
              Effect.flatMap((value) =>
                value.success ? Effect.succeed(value) : Effect.fail(unavailable(operation)),
              ),
            );
          });
        }
        function decode<S extends Schema.Top & { readonly DecodingServices: never }>(
          schema: S,
          value: unknown,
          operation: string,
        ) {
          return Schema.decodeUnknownEffect(schema)(value).pipe(
            Effect.mapError(() => unavailable(operation)),
          );
        }
        const get = <S extends Schema.Top & { readonly DecodingServices: never }>(
          path: string,
          permission: string,
          schema: S,
        ) =>
          Effect.flatMap(request(path, permission), (value) =>
            decode(schema, value.result, operationName(path)),
          );
        const mutate = (path: string, permission: string, method: string, body?: unknown) =>
          Effect.asVoid(request(path, permission, method, body));
        function list<S extends Schema.Top & { readonly DecodingServices: never }>(
          path: string,
          permission: string,
          schema: S,
          perPage = 100,
        ) {
          return Effect.gen(function* () {
            const items: S["Type"][] = [];
            let page = 1;
            while (true) {
              const response = yield* request(
                `${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=${perPage}`,
                permission,
              );
              items.push(
                ...(yield* decode(Schema.Array(schema), response.result, operationName(path))),
              );
              if (page >= (response.result_info?.total_pages ?? 1)) return items;
              page++;
            }
          });
        }
        const z = (id: string, path: string) => `/zones/${encodeURIComponent(id)}${path}`;
        const aList = <S extends Schema.Top & { readonly DecodingServices: never }>(
          path: string,
          permission: string,
          schema: S,
        ) => Effect.flatMap(account(path), (p) => list(p, permission, schema));
        const aMutate = (path: string, permission: string, method: string, body?: unknown) =>
          Effect.flatMap(account(path), (p) => mutate(p, permission, method, body));
        const aCreate = <S extends Schema.Top & { readonly DecodingServices: never }>(
          path: string,
          permission: string,
          schema: S,
          body: unknown,
        ) =>
          Effect.flatMap(account(path), (p) =>
            Effect.flatMap(request(p, permission, "POST", body), (r) =>
              decode(schema, r.result, operationName(p, "POST")),
            ),
          );
        return {
          accountId,
          tunnels: () => aList("/cfd_tunnel?is_deleted=false", remoteTokenPermission, Tunnel),
          createTunnel: (name) =>
            aCreate("/cfd_tunnel", remoteTokenPermission, Tunnel, {
              name,
              config_src: "cloudflare",
            }),
          configureTunnel: (id, hostname, origin) =>
            aMutate(
              `/cfd_tunnel/${encodeURIComponent(id)}/configurations`,
              remoteTokenPermission,
              "PUT",
              {
                config: {
                  ingress: [{ hostname, service: origin }, { service: "http_status:404" }],
                },
              },
            ),
          tunnelToken: (id) =>
            Effect.flatMap(account(`/cfd_tunnel/${encodeURIComponent(id)}/token`), (path) =>
              Effect.map(
                get(path, remoteTokenPermission, Schema.String.check(Schema.isMinLength(1))),
                Redacted.make,
              ),
            ),
          deleteTunnel: (id) =>
            aMutate(`/cfd_tunnel/${encodeURIComponent(id)}`, remoteTokenPermission, "DELETE"),
          createTunnelDns: (zone, hostname, tunnelId, marker) =>
            Effect.gen(function* () {
              yield* Effect.try({
                try: () => assertSubdomain(zone, hostname),
                catch: () => invalid("A literal tunnel subdomain is required."),
              });
              const response = yield* request(z(zone.id, "/dns_records"), "DNS Write", "POST", {
                type: "CNAME",
                name: hostname,
                content: `${tunnelId}.cfargotunnel.com`,
                proxied: true,
                ttl: 1,
                comment: marker,
              });
              return yield* decode(DnsRecord, response.result, "POST tunnel DNS");
            }),
          accounts: () => list("/accounts", "access to the intended account", Account, 50),
          verifyUserToken: () =>
            Effect.asVoid(get("/user/tokens/verify", "an active API token", Token)),
          verifyToken: () =>
            Effect.gen(function* () {
              const path = yield* account("/tokens/verify");
              yield* get(path, "an active API token", Token).pipe(
                Effect.catchTag("ProvisionError", (error) =>
                  error.code === "missing_permission"
                    ? get("/user/tokens/verify", "an active API token", Token)
                    : Effect.fail(error),
                ),
              );
            }),
          zones: (name) =>
            Effect.flatMap(accountId(), (id) =>
              list(
                `/zones?name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(id)}`,
                "Zone Zone Read",
                Zone,
              ),
            ),
          dns: (id) => list(z(id, "/dns_records"), "DNS Write", DnsRecord),
          exportDns: (id) =>
            Effect.gen(function* () {
              const value = yield* settings();
              return yield* Effect.tryPromise({
                try: async (signal) => {
                  const response = await fetch(
                    `https://api.cloudflare.com/client/v4${z(id, "/dns_records/export")}`,
                    {
                      signal,
                      redirect: "error",
                      headers: { Authorization: `Bearer ${Redacted.value(value.api_token)}` },
                    },
                  );
                  if (response.status === 401 || response.status === 403)
                    throw missingPermission("DNS Write", "GET DNS export");
                  if (!response.ok) throw unavailable("GET DNS export");
                  return response.text();
                },
                catch: (error) =>
                  error instanceof ProvisionError ? error : unavailable("GET DNS export"),
              }).pipe(
                Effect.timeoutOrElse({
                  duration: "30 seconds",
                  orElse: () => Effect.fail(unavailable("GET DNS export")),
                }),
              );
            }),
          deleteDns: (zone, id) =>
            mutate(z(zone, `/dns_records/${encodeURIComponent(id)}`), "DNS Write", "DELETE"),
          sendingDomains: (id) =>
            list(z(id, "/email/sending/subdomains"), "Email Sending: Edit", SendingDomain),
          getSending: (zone, id) =>
            get(
              z(zone, `/email/sending/subdomains/${encodeURIComponent(id)}`),
              "Email Sending: Edit",
              SendingDomain,
            ),
          createSending: (zone, domain) =>
            Effect.gen(function* () {
              yield* Effect.try({
                try: () => assertSubdomain(zone, domain),
                catch: (error) =>
                  error instanceof ProvisionError ? error : invalid("Invalid subdomain."),
              });
              const response = yield* request(
                z(zone.id, "/email/sending/subdomains"),
                "Email Sending: Edit",
                "POST",
                { name: domain },
              );
              return yield* decode(SendingDomain, response.result, "POST sending subdomain");
            }),
          disablePreview: (zone, id) =>
            mutate(
              z(zone, `/email/sending/subdomains/${encodeURIComponent(id)}`),
              "Email Sending: Edit",
              "PATCH",
              { preview_enabled: false },
            ),
          deleteSending: (zone, id) =>
            mutate(
              z(zone, `/email/sending/subdomains/${encodeURIComponent(id)}`),
              "Email Sending: Edit",
              "DELETE",
            ),
          sendingDns: (zone, id) =>
            list(
              z(zone, `/email/sending/subdomains/${encodeURIComponent(id)}/dns`),
              "Email Sending: Edit",
              DnsRecord,
            ),
          routingDns: (zone, domain) =>
            Effect.gen(function* () {
              const records = yield* get(
                z(zone.id, "/email/routing/dns"),
                "Zone Settings Write",
                Schema.Array(DnsRecord),
              );
              return records.map((record) => ({
                ...record,
                name: record.name === "@" || record.name === zone.name ? domain : record.name,
              }));
            }),
          enableRouting: (zone, domain) =>
            Effect.gen(function* () {
              yield* Effect.try({
                try: () => assertSubdomain(zone, domain),
                catch: (error) =>
                  error instanceof ProvisionError ? error : invalid("Invalid subdomain."),
              });
              yield* mutate(z(zone.id, "/email/routing/dns"), "Zone Settings Write", "POST", {
                name: domain,
              });
            }),
          unlockRoutingDns: (zone, domain) =>
            Effect.gen(function* () {
              yield* Effect.try({
                try: () => assertSubdomain(zone, domain),
                catch: (error) =>
                  error instanceof ProvisionError ? error : invalid("Invalid subdomain."),
              });
              yield* mutate(z(zone.id, "/email/routing/dns"), "Zone Settings Write", "PATCH", {
                name: domain,
              });
            }),
          disableRouting: (_zone, _domain) =>
            Effect.fail(
              new ProvisionError({
                code: "not_supported",
                message: "Cloudflare does not document a subdomain-scoped routing disable call.",
                fix: "Remove only the recorded routing DNS records; never disable zone routing.",
              }),
            ),
          rules: (id) => list(z(id, "/email/routing/rules"), "Email Routing Rules Write", Rule),
          createRule: (zone, address, worker, name) =>
            Effect.gen(function* () {
              const domain = address.split("@")[1] ?? "";
              yield* Effect.try({
                try: () => assertSubdomain(zone, domain),
                catch: (error) =>
                  error instanceof ProvisionError ? error : invalid("Invalid rule address."),
              });
              const response = yield* request(
                z(zone.id, "/email/routing/rules"),
                "Email Routing Rules Write",
                "POST",
                {
                  name,
                  enabled: true,
                  matchers: [{ type: "literal", field: "to", value: address }],
                  actions: [{ type: "worker", value: [worker] }],
                },
              );
              return yield* decode(Rule, response.result, "POST routing rule");
            }),
          deleteRule: (zone, id) =>
            mutate(
              z(zone, `/email/routing/rules/${encodeURIComponent(id)}`),
              "Email Routing Rules Write",
              "DELETE",
            ),
          buckets: () =>
            Effect.gen(function* () {
              const names: string[] = [];
              let cursor: string | undefined;
              const seen = new Set<string>();
              do {
                const path = yield* account(
                  `/r2/buckets?per_page=100${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
                );
                const response = yield* request(path, "Workers R2 Storage Write");
                names.push(
                  ...(
                    (yield* decode(BucketList, response.result, "GET R2 bucket")).buckets ?? []
                  ).map((bucket) => bucket.name),
                );
                cursor = response.result_info?.cursor || undefined;
                if (cursor !== undefined && seen.has(cursor))
                  return yield* unavailable("GET R2 bucket");
                if (cursor !== undefined) seen.add(cursor);
              } while (cursor !== undefined);
              return names;
            }),
          createBucket: (name) =>
            Effect.map(
              aCreate("/r2/buckets", "Workers R2 Storage Write", Name, { name }),
              (value) => value.name,
            ),
          deleteBucket: (name) =>
            aMutate(
              `/r2/buckets/${encodeURIComponent(name)}`,
              "Workers R2 Storage Write",
              "DELETE",
            ),
          queues: () => aList("/queues", "Queues Write", Queue),
          createQueue: (name) => aCreate("/queues", "Queues Write", Queue, { queue_name: name }),
          deleteQueue: (id) =>
            aMutate(`/queues/${encodeURIComponent(id)}`, "Queues Write", "DELETE"),
          configureEventsQueue: (id, name) =>
            aMutate(`/queues/${encodeURIComponent(id)}`, "Queues Write", "PUT", {
              queue_name: name,
              settings: {
                delivery_delay: 0,
                delivery_paused: false,
                message_retention_period: 300,
              },
            }),
          consumers: (id) =>
            aList(`/queues/${encodeURIComponent(id)}/consumers`, "Queues Write", Consumer),
          createConsumer: (id) =>
            aCreate(`/queues/${encodeURIComponent(id)}/consumers`, "Queues Write", Consumer, {
              type: "http_pull",
            }),
          deleteConsumer: (queue, id) =>
            aMutate(
              `/queues/${encodeURIComponent(queue)}/consumers/${encodeURIComponent(id)}`,
              "Queues Write",
              "DELETE",
            ),
          workers: () =>
            Effect.map(aList("/workers/scripts", "Workers Scripts Write", Id), (items) =>
              items.map((item) => item.id),
            ),
          uploadWorker: (input) =>
            Effect.gen(function* () {
              const body = new FormData();
              body.set(
                "metadata",
                new Blob(
                  [
                    JSON.stringify({
                      main_module: "inbound.js",
                      compatibility_date: "2026-10-10",
                      bindings: [
                        { type: "r2_bucket", name: "INBOUND_BUCKET", bucket_name: input.bucket },
                        { type: "queue", name: "INBOUND_QUEUE", queue_name: input.queue },
                        { type: "plain_text", name: "RECIPIENT", text: input.recipient },
                      ],
                    }),
                  ],
                  { type: "application/json" },
                ),
              );
              body.set(
                "inbound.js",
                new Blob([input.source], { type: "application/javascript+module" }),
                "inbound.js",
              );
              yield* aMutate(
                `/workers/scripts/${encodeURIComponent(input.name)}`,
                "Workers Scripts Write",
                "PUT",
                body,
              );
            }),
          disableWorkerPublicUrls: (name) =>
            aMutate(
              `/workers/scripts/${encodeURIComponent(name)}/subdomain`,
              "Workers Scripts Write",
              "POST",
              { enabled: false, previews_enabled: false },
            ),
          deleteWorker: (name) =>
            aMutate(
              `/workers/scripts/${encodeURIComponent(name)}`,
              "Workers Scripts Write",
              "DELETE",
            ),
          subscriptions: () =>
            aList("/event_subscriptions/subscriptions", "Queues Write", Subscription),
          createSubscription: (zone_id, domain, queue_id, name) =>
            aCreate("/event_subscriptions/subscriptions", "Queues Write", Subscription, {
              name,
              enabled: true,
              source: { type: "email.sending", zone_id, domain },
              destination: { type: "queues.queue", queue_id },
              events: sendingEvents,
            }),
          deleteSubscription: (id) =>
            aMutate(
              `/event_subscriptions/subscriptions/${encodeURIComponent(id)}`,
              "Queues Write",
              "DELETE",
            ),
          sendSelfTest: (domain, token) =>
            aMutate("/email/sending/send", "Email Sending: Edit", "POST", {
              from: `inbot-selftest@${domain}`,
              to: [`inbot-selftest@${domain}`],
              subject: "Inbot domain verification",
              text: "Synthetic Inbot verification message.",
              headers: { "X-Inbot-Selftest": token },
            }),
        } satisfies CloudflareApiService;
      }),
    );
  }
}
