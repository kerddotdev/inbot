import { Effect, Redacted } from "effect";
import {
  assertSubdomain,
  sendingEvents,
  remoteTokenPermission,
  type Tunnel,
  tokenPermissions,
  type CloudflareApiService,
  type Consumer,
  type DnsRecord,
  type Queue,
  type Rule,
  type SendingDomain,
  type Subscription,
  type WorkerInput,
  type Zone,
} from "./cloudflare-api.js";
import { missingPermission, ProvisionError, unavailable } from "./errors.js";

export function fakeCloudflare() {
  let nextId = 0;
  const id = () => `fake-${++nextId}`;
  const account = { id: "fake-account" };
  const zone: Zone = { id: "fake-zone", name: "example.test", account };
  const zones: Zone[] = [zone];
  type FakeDnsRecord = DnsRecord & {
    readonly meta?: { readonly email_routing?: boolean; readonly read_only: boolean };
  };
  const dns: FakeDnsRecord[] = [
    { id: id(), type: "MX", name: zone.name, content: "mx.other.invalid", priority: 10, ttl: 3600 },
    {
      id: id(),
      type: "TXT",
      name: zone.name,
      content: "v=spf1 include:other.invalid -all",
      ttl: 3600,
    },
    {
      id: id(),
      type: "TXT",
      name: `_dmarc.${zone.name}`,
      content: "v=DMARC1; p=reject",
      ttl: 3600,
    },
  ];
  const tunnels = new Map<string, Tunnel>();
  const tunnelConfigs = new Map<string, { hostname: string; origin: string }>();
  const sending = new Map<string, SendingDomain>();
  const buckets = new Set<string>();
  const queues = new Map<string, Queue>();
  const retention = new Map<string, number>();
  const consumers = new Map<string, { readonly queue: string; readonly consumer: Consumer }>();
  const workers = new Map<string, WorkerInput>();
  const publicWorkers = new Set<string>();
  const subscriptions = new Map<string, Subscription>();
  const rules = new Map<string, Rule>();
  const routed = new Set<string>();
  const permissions = new Set([...tokenPermissions, remoteTokenPermission]);
  const calls: string[] = [];
  const mutations: string[] = [];
  const state: {
    failure?: { readonly operation: string; readonly after: boolean };
    mutateApexOnRouting: boolean;
    onSelfTest?: (domain: string, token: string) => Promise<void>;
  } = { mutateApexOnRouting: false };
  function before(operation: string, mutate: boolean) {
    calls.push(operation);
    const failure = state.failure;
    if (
      failure !== undefined &&
      (failure.operation === operation || operation.startsWith(`${failure.operation}:`)) &&
      !failure.after
    ) {
      delete state.failure;
      throw unavailable(operation.split(":")[0]);
    }
    if (mutate) mutations.push(operation);
  }
  function after(operation: string) {
    const failure = state.failure;
    if (
      failure !== undefined &&
      (failure.operation === operation || operation.startsWith(`${failure.operation}:`)) &&
      failure.after
    ) {
      delete state.failure;
      throw unavailable(operation.split(":")[0]);
    }
  }
  function perform<A>(operation: string, fn: () => A, mutate = false) {
    return Effect.try({
      try: () => {
        before(operation, mutate);
        const result = fn();
        after(operation);
        return result;
      },
      catch: (error) =>
        error instanceof ProvisionError ? error : unavailable(operation.split(":")[0]),
    });
  }
  const sendingDns = (domain: string): FakeDnsRecord[] => [
    ...[1, 2, 3].map((index) => ({
      type: "MX",
      name: `cf-bounce.${domain}`,
      content: `route${index}.mx.cloudflare.net`,
      priority: index * 10,
      ttl: 1,
    })),
    {
      type: "TXT",
      name: `cf-bounce.${domain}`,
      content: "v=spf1 include:_spf.mx.cloudflare.net ~all",
      ttl: 1,
    },
    {
      type: "TXT",
      name: `cf-bounce._domainkey.${domain}`,
      content: "v=DKIM1; p=synthetic-sending-key",
      ttl: 1,
    },
    {
      type: "TXT",
      name: `_dmarc.${domain}`,
      content: "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s;",
      ttl: 1,
    },
  ];
  const routingDns = (domain: string): FakeDnsRecord[] => [
    ...[1, 2, 3].map((index) => ({
      type: "MX",
      name: domain,
      meta: { email_routing: true, read_only: true },
      content: `route${index}.mx.cloudflare.net`,
      priority: index * 10,
      ttl: 1,
    })),
    { type: "TXT", name: domain, content: "v=spf1 include:_spf.mx.cloudflare.net ~all", ttl: 1 },
    {
      type: "TXT",
      name: `cf2024-1._domainkey.${zone.name}`,
      content: "v=DKIM1; p=synthetic-routing-key",
      ttl: 1,
    },
  ];
  function addDns(records: readonly FakeDnsRecord[]) {
    for (const record of records)
      if (
        !dns.some(
          (value) =>
            value.name === record.name &&
            value.type === record.type &&
            value.content === record.content,
        )
      )
        dns.push({ ...record, id: id() });
  }
  const service: CloudflareApiService = {
    accountId: () => perform("accountId", () => account.id),
    tunnels: () =>
      perform("tunnels", () => {
        if (!permissions.has(remoteTokenPermission)) throw missingPermission(remoteTokenPermission);
        return Array.from(tunnels.values());
      }),
    createTunnel: (name) =>
      perform(
        "createTunnel",
        () => {
          if (!permissions.has(remoteTokenPermission))
            throw missingPermission(remoteTokenPermission);
          const tunnel = { id: id(), name, config_src: "cloudflare" };
          tunnels.set(tunnel.id, tunnel);
          return tunnel;
        },
        true,
      ),
    configureTunnel: (tunnelId, hostname, origin) =>
      perform(
        "configureTunnel",
        () => {
          if (!tunnels.has(tunnelId)) throw unavailable();
          tunnelConfigs.set(tunnelId, { hostname, origin });
        },
        true,
      ),
    tunnelToken: (tunnelId) =>
      perform("tunnelToken", () => {
        if (!tunnels.has(tunnelId)) throw unavailable();
        return Redacted.make(`synthetic-tunnel-token-${tunnelId}`);
      }),
    deleteTunnel: (tunnelId) =>
      perform(
        `deleteTunnel:${tunnelId}`,
        () => {
          tunnels.delete(tunnelId);
          tunnelConfigs.delete(tunnelId);
        },
        true,
      ),
    createTunnelDns: (zone, hostname, tunnelId, marker) =>
      perform(
        "createTunnelDns",
        () => {
          assertSubdomain(zone, hostname);
          const record = {
            id: id(),
            type: "CNAME",
            name: hostname,
            content: `${tunnelId}.cfargotunnel.com`,
            proxied: true,
            comment: marker,
            ttl: 1,
          };
          dns.push(record);
          return record;
        },
        true,
      ),
    accounts: () => perform("accounts", () => [{ id: account.id, name: "Synthetic account" }]),
    verifyUserToken: () => perform("verifyUserToken", () => {}),
    verifyToken: () =>
      perform("verifyToken", () => {
        for (const permission of tokenPermissions)
          if (!permissions.has(permission)) throw missingPermission(permission);
      }),
    zones: (name) =>
      perform("zones", () =>
        zones.filter((item) => item.name === name && item.account.id === account.id),
      ),
    dns: () => perform("dns", () => dns.map((record) => ({ ...record }))),
    exportDns: () =>
      perform("exportDns", () =>
        dns.map((record) => `${record.name}. IN ${record.type} ${record.content}`).join("\n"),
      ),
    deleteDns: (_zone, recordId) =>
      perform(
        `deleteDns:${recordId}`,
        () => {
          const index = dns.findIndex((record) => record.id === recordId);
          if (dns[index]?.meta?.read_only)
            throw unavailable("deleteDns: read_only record (HTTP 400)");
          if (index >= 0) dns.splice(index, 1);
        },
        true,
      ),
    sendingDomains: () => perform("sendingDomains", () => Array.from(sending.values())),
    getSending: (_zone, domainId) =>
      perform("getSending", () => {
        const domain = sending.get(domainId);
        if (domain === undefined) throw unavailable();
        return domain;
      }),
    createSending: (zone, domain) =>
      perform(
        "createSending",
        () => {
          assertSubdomain(zone, domain);
          const existing = Array.from(sending.values()).find((item) => item.name === domain);
          if (existing !== undefined) return existing;
          const value = { tag: id(), name: domain, enabled: true, preview_enabled: true };
          sending.set(value.tag, value);
          addDns(sendingDns(domain).map((record) => ({ ...record, meta: { read_only: true } })));
          return value;
        },
        true,
      ),
    disablePreview: (_zone, domainId) =>
      perform(
        "disablePreview",
        () => {
          const value = sending.get(domainId);
          if (value === undefined) throw unavailable();
          sending.set(domainId, { ...value, preview_enabled: false });
        },
        true,
      ),
    deleteSending: (_zone, domainId) =>
      perform(
        `deleteSending:${domainId}`,
        () => {
          const value = sending.get(domainId);
          if (value !== undefined) {
            const records = sendingDns(value.name);
            for (let index = dns.length - 1; index >= 0; index--) {
              const record = dns[index];
              if (
                record !== undefined &&
                records.some(
                  (expected) =>
                    expected.name === record.name &&
                    expected.type === record.type &&
                    expected.content === record.content,
                )
              )
                dns.splice(index, 1);
            }
          }
          sending.delete(domainId);
        },
        true,
      ),
    sendingDns: (_zone, domainId) =>
      perform("sendingDns", () => {
        const value = sending.get(domainId);
        if (value === undefined) throw unavailable();
        return sendingDns(value.name);
      }),
    routingDns: (zone, domain) =>
      perform("routingDns", () => {
        assertSubdomain(zone, domain);
        return routingDns(domain);
      }),
    enableRouting: (zone, domain) =>
      perform(
        "enableRouting",
        () => {
          assertSubdomain(zone, domain);
          routed.add(domain);
          addDns(routingDns(domain));
          if (state.mutateApexOnRouting) {
            const index = dns.findIndex(
              (record) => record.name === zone.name && record.type === "MX",
            );
            const record = dns[index];
            if (record !== undefined) dns[index] = { ...record, content: "changed.invalid" };
          }
        },
        true,
      ),
    unlockRoutingDns: (zone, domain) =>
      perform(
        `unlockRoutingDns:${domain}`,
        () => {
          assertSubdomain(zone, domain);
          for (const [index, record] of dns.entries())
            if (record.name === domain && record.meta?.email_routing)
              dns[index] = { ...record, meta: { ...record.meta, read_only: false } };
        },
        true,
      ),
    disableRouting: (zone, domain) =>
      perform(
        "disableRouting",
        () => {
          assertSubdomain(zone, domain);
          routed.delete(domain);
        },
        true,
      ),
    rules: () => perform("rules", () => Array.from(rules.values())),
    createRule: (zone, address, worker, name) =>
      perform(
        "createRule",
        () => {
          assertSubdomain(zone, address.split("@")[1] ?? "");
          const rule: Rule = {
            id: id(),
            name,
            enabled: true,
            matchers: [{ type: "literal", field: "to", value: address }],
            actions: [{ type: "worker", value: [worker] }],
          };
          rules.set(rule.id, rule);
          return rule;
        },
        true,
      ),
    deleteRule: (_zone, ruleId) =>
      perform(
        `deleteRule:${ruleId}`,
        () => {
          rules.delete(ruleId);
        },
        true,
      ),
    buckets: () => perform("buckets", () => Array.from(buckets)),
    createBucket: (name) =>
      perform(
        "createBucket",
        () => {
          buckets.add(name);
          return name;
        },
        true,
      ),
    deleteBucket: (name) =>
      perform(
        `deleteBucket:${name}`,
        () => {
          buckets.delete(name);
        },
        true,
      ),
    queues: () => perform("queues", () => Array.from(queues.values())),
    createQueue: (name) =>
      perform(
        "createQueue",
        () => {
          const queue = { queue_id: id(), queue_name: name };
          queues.set(queue.queue_id, queue);
          return queue;
        },
        true,
      ),
    deleteQueue: (queueId) =>
      perform(
        `deleteQueue:${queueId}`,
        () => {
          queues.delete(queueId);
        },
        true,
      ),
    configureEventsQueue: (queueId) =>
      perform(
        "configureEventsQueue",
        () => {
          retention.set(queueId, 300);
        },
        true,
      ),
    consumers: (queueId) =>
      perform("consumers", () =>
        Array.from(consumers.values())
          .filter((value) => value.queue === queueId)
          .map((value) => value.consumer),
      ),
    createConsumer: (queueId) =>
      perform(
        "createConsumer",
        () => {
          const consumer = { consumer_id: id(), type: "http_pull" };
          consumers.set(consumer.consumer_id, { queue: queueId, consumer });
          return consumer;
        },
        true,
      ),
    deleteConsumer: (_queue, consumerId) =>
      perform(
        `deleteConsumer:${consumerId}`,
        () => {
          consumers.delete(consumerId);
        },
        true,
      ),
    workers: () => perform("workers", () => Array.from(workers.keys())),
    uploadWorker: (input) =>
      perform(
        "uploadWorker",
        () => {
          workers.set(input.name, input);
          publicWorkers.add(input.name);
        },
        true,
      ),
    disableWorkerPublicUrls: (name) =>
      perform(
        "disableWorkerPublicUrls",
        () => {
          publicWorkers.delete(name);
        },
        true,
      ),
    deleteWorker: (name) =>
      perform(
        `deleteWorker:${name}`,
        () => {
          workers.delete(name);
          publicWorkers.delete(name);
        },
        true,
      ),
    subscriptions: () => perform("subscriptions", () => Array.from(subscriptions.values())),
    createSubscription: (zone_id, domain, queue_id, name) =>
      perform(
        "createSubscription",
        () => {
          const value: Subscription = {
            id: id(),
            name,
            enabled: true,
            source: { type: "email.sending", zone_id, domain },
            destination: { type: "queues.queue", queue_id },
            events: sendingEvents,
          };
          subscriptions.set(value.id, value);
          return value;
        },
        true,
      ),
    deleteSubscription: (subscriptionId) =>
      perform(
        `deleteSubscription:${subscriptionId}`,
        () => {
          subscriptions.delete(subscriptionId);
        },
        true,
      ),
    sendSelfTest: (domain, token) =>
      Effect.tryPromise({
        try: async () => {
          before("sendSelfTest", true);
          await state.onSelfTest?.(domain, token);
          after("sendSelfTest");
        },
        catch: (error) => (error instanceof ProvisionError ? error : unavailable()),
      }),
  };
  return {
    service,
    account,
    zones,
    dns,
    sending,
    tunnels,
    tunnelConfigs,
    buckets,
    queues,
    retention,
    consumers,
    workers,
    publicWorkers,
    subscriptions,
    rules,
    routed,
    permissions,
    calls,
    mutations,
    state,
    addDns,
    failNext: (operation: string, after = false) => {
      state.failure = { operation, after };
    },
  };
}
