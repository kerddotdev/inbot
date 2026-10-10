import { mkdtemp, rm } from "node:fs/promises";
import { BufferError } from "../inbound/cloudflare.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, test } from "vitest";
import { encrypt, frameInbound } from "../../../../packages/envelope/src/index.js";
import type { DomainVerifiedEvent } from "../../../../packages/contracts/src/events.js";
import { fixture as inboundFixture, key, receivedAt } from "../inbound/test-fixture.js";
import { PublicDns, apexRecords, bindRecord } from "./dns.js";
import { fakeCloudflare } from "./fake-cloudflare.js";
import { makeProvisioner } from "./provisioner.js";
import { repository } from "./repository.js";
import { observeSelfTest } from "./selftest.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "inbot-provision-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const local = await inboundFixture(home);
  cleanups.push(local.close);
  await local.run(local.inbound.clear());
  const cloud = fakeCloudflare();
  const dnsState = { visible: false };
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://cloudflare-dns.com");
    const name = url.searchParams.get("name");
    const type = url.searchParams.get("type");
    const types: Readonly<Record<string, number>> = { TXT: 16, MX: 15, CNAME: 5 };
    return Response.json({
      Status: 0,
      Answer: dnsState.visible
        ? cloud.dns
            .filter((record) => record.name === name && record.type === type)
            .map((record) => ({
              name: `${record.name}.`,
              type: types[record.type],
              data:
                record.type === "TXT"
                  ? `"${record.content}"`
                  : record.type === "MX"
                    ? `${record.priority} ${record.content}.`
                    : `${record.content}.`,
            }))
        : [],
    });
  };
  const dns = await Effect.runPromise(PublicDns.pipe(Effect.provide(PublicDns.live(fetch))));
  const events: DomainVerifiedEvent[] = [];
  const make = (overrides: Partial<Parameters<typeof makeProvisioner>[0]> = {}) =>
    makeProvisioner({
      store: local.store,
      api: cloud.service,
      dns,
      inbound: local.inbound,
      transport: local.transport,
      mailbox: local.mailbox,
      buffer: local.buffer.service,
      readWorker: async () => "export default { email() {} };",
      onVerified: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ...overrides,
    });
  const provisioner = make();
  const repo = repository(local.store);
  const domain = "agents.example.test";
  let counter = 300;
  cloud.state.onSelfTest = async (domain, token) => {
    const config = await local.run(local.inbound.get());
    const recipient = await local.run(local.inbound.getRecipient());
    if (config === undefined || recipient === undefined)
      throw new Error("Expected configured inbound buffer");
    const address = `inbot-selftest@${domain}`;
    const raw = Buffer.from(
      [
        `Message-ID: <selftest-${counter}@${domain}>`,
        `From: ${address}`,
        `To: ${address}`,
        `X-Inbot-Selftest: ${token}`,
        "Subject: Synthetic verification",
        "Content-Type: text/plain",
        "",
        "Synthetic probe.",
      ].join("\r\n"),
    );
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(raw);
        controller.close();
      },
    });
    const frame = frameInbound(
      { mail_from: `bounces@cf-bounce.${domain}`, rcpt_to: [address] },
      source,
    );
    const bytes = new Uint8Array(
      await new Response(await encrypt(recipient, frame.stream)).arrayBuffer(),
    );
    const objectKey = key(counter++);
    local.buffer.putObject(objectKey, bytes, receivedAt);
    local.buffer.push(config.inbound_queue_id, {
      version: 1,
      key: objectKey,
      size: bytes.byteLength,
      received_at: receivedAt,
    });
  };
  return { ...local, home, cloud, dnsState, provisioner, make, repo, domain, events };
}

test("refuses the apex, foreign zones, wildcard domains, and missing permissions", async () => {
  const f = await fixture();
  for (const domain of [
    "example.test",
    "agents.foreign.test",
    "*.example.test",
    "bad..example.test",
  ]) {
    await expect(f.run(f.provisioner.create({ domain }))).rejects.toMatchObject({
      code: "validation_error",
    });
  }
  f.cloud.permissions.delete("Email Routing Rules Write");
  await expect(f.run(f.provisioner.create({ domain: f.domain }))).rejects.toMatchObject({
    code: "missing_permission",
    message: expect.stringContaining("Email Routing Rules Write"),
  });
  expect(f.cloud.mutations).toEqual([]);
  expect(await f.run(f.repo.all())).toEqual([]);
});

test("planning has no local or cloud effects and exposes incomplete DKIM honestly", async () => {
  const f = await fixture();
  const planned = await f.run(f.provisioner.plan(f.domain));
  expect(planned.steps).toContain("verify_buffer_selftest");
  expect(
    planned.records.find((record) => record.name === `cf-bounce._domainkey.${f.domain}`),
  ).toMatchObject({ value: "", status: "MISSING" });
  expect(f.cloud.mutations).toEqual([]);
  expect(await f.run(f.repo.all())).toEqual([]);
});

test("apply is idempotent and records every created resource ID including each MX", async () => {
  const f = await fixture();
  const registered = await f.run(f.provisioner.create({ domain: f.domain }));
  expect(registered.status).toBe("NOT_STARTED");
  const baseline = apexRecords(f.cloud.dns, "example.test");
  const first = await f.run(f.provisioner.apply(registered.domain_id));
  expect(first.status).toBe("VERIFYING");
  const resources = await f.run(f.repo.resources(first.domain_id));
  expect(resources.every((resource) => resource.cloudflare_id !== null)).toBe(true);
  expect(resources.filter((resource) => resource.kind === "dns")).toHaveLength(11);
  expect(
    resources
      .filter((resource) => resource.kind === "dns")
      .map((resource) => resource.cloudflare_id)
      .sort(),
  ).toEqual(
    f.cloud.dns
      .filter((record) => record.name !== "example.test" && record.name !== "_dmarc.example.test")
      .map((record) => record.id)
      .sort(),
  );
  expect(await f.run(f.provisioner.apply(first.domain_id))).toMatchObject({
    domain_id: first.domain_id,
    status: "VERIFYING",
  });
  expect(await f.run(f.repo.resources(first.domain_id))).toEqual(resources);
  expect(f.cloud.sending.size).toBe(1);
  expect(f.cloud.buckets.size).toBe(1);
  expect(f.cloud.queues.size).toBe(2);
  expect(f.cloud.consumers.size).toBe(2);
  expect(f.cloud.workers.size).toBe(1);
  expect(f.cloud.publicWorkers.size).toBe(0);
  expect(f.cloud.subscriptions.size).toBe(1);
  expect(Array.from(f.cloud.sending.values())[0]?.preview_enabled).toBe(false);
  expect(apexRecords(f.cloud.dns, "example.test")).toEqual(baseline);
});

const failureSteps = [
  "verifyToken",
  "zones",
  "dns",
  "sendingDomains",
  "createSending",
  "disablePreview",
  "getSending",
  "routingDns",
  "enableRouting",
  "buckets",
  "createBucket",
  "queues",
  "createQueue",
  "configureEventsQueue",
  "consumers",
  "createConsumer",
  "workers",
  "uploadWorker",
  "disableWorkerPublicUrls",
  "subscriptions",
  "createSubscription",
  "sendingDns",
];
test.each(failureSteps)(
  "resumes after a failure at %s using durable progress",
  async (operation) => {
    const f = await fixture();
    const domain = await f.run(f.provisioner.create({ domain: f.domain }));
    f.cloud.failNext(operation);
    await expect(f.run(f.provisioner.apply(domain.domain_id))).rejects.toMatchObject({
      code: "service_unavailable",
    });
    const resumed = f.make();
    expect((await f.run(resumed.apply(domain.domain_id))).status).toBe("VERIFYING");
    expect(f.cloud.sending.size).toBe(1);
    expect(f.cloud.queues.size).toBe(2);
    expect(f.cloud.consumers.size).toBe(2);
    expect(f.cloud.workers.size).toBe(1);
    expect(f.cloud.subscriptions.size).toBe(1);
  },
);

test.each([
  "createSending",
  "enableRouting",
  "createBucket",
  "createQueue",
  "createConsumer",
  "uploadWorker",
  "createSubscription",
])("adopts an effect whose response was lost at %s", async (operation) => {
  const f = await fixture();
  const domain = await f.run(f.provisioner.create({ domain: f.domain }));
  f.cloud.failNext(operation, true);
  await expect(f.run(f.provisioner.apply(domain.domain_id))).rejects.toMatchObject({
    code: "service_unavailable",
  });
  const resumed = f.make();
  expect((await f.run(resumed.apply(domain.domain_id))).status).toBe("VERIFYING");
  expect(f.cloud.sending.size).toBe(1);
  expect(f.cloud.queues.size).toBe(2);
  expect(f.cloud.consumers.size).toBe(2);
  expect(f.cloud.subscriptions.size).toBe(1);
});

test("apex drift during routing stops apply before the bucket and remains blocked on retry", async () => {
  const f = await fixture();
  const domain = await f.run(f.provisioner.create({ domain: f.domain }));
  f.cloud.state.mutateApexOnRouting = true;
  await expect(f.run(f.provisioner.apply(domain.domain_id))).rejects.toMatchObject({
    code: "action_required",
  });
  expect(f.cloud.buckets.size).toBe(0);
  expect((await f.run(f.repo.get(domain.domain_id)))?.phase).toBe("action_required");
  const mutations = f.cloud.mutations.length;
  await expect(f.run(f.provisioner.apply(domain.domain_id))).rejects.toMatchObject({
    code: "action_required",
  });
  expect(f.cloud.mutations).toHaveLength(mutations);
  expect(
    (await f.run(f.repo.resources(domain.domain_id))).filter((resource) => resource.kind === "dns"),
  ).toHaveLength(11);
});

test.each(["verify", "apply", "teardown"] as const)(
  "owner apex edits after apply do not block %s",
  async (operation) => {
    const f = await fixture();
    const domain = await f.run(f.provisioner.create({ domain: f.domain }));
    await f.run(f.provisioner.apply(domain.domain_id));
    for (const [index, record] of f.cloud.dns.entries()) {
      if (record.name === "example.test")
        f.cloud.dns[index] = {
          ...record,
          ttl: 7200,
          ...(record.type === "TXT" ? { content: "v=spf1 include:updated.invalid -all" } : {}),
        };
    }
    const edited = apexRecords(f.cloud.dns, "example.test");
    f.dnsState.visible = true;
    const expected =
      operation === "verify" ? "VERIFIED" : operation === "apply" ? "VERIFYING" : "NOT_STARTED";
    expect((await f.run(f.make()[operation](domain.domain_id))).status).toBe(expected);
    expect(apexRecords(f.cloud.dns, "example.test")).toEqual(edited);
  },
);

test("each DNS step protects the latest apex snapshot after an owner edit", async () => {
  const f = await fixture();
  const domain = await f.run(f.provisioner.create({ domain: f.domain }));
  const api = {
    ...f.cloud.service,
    getSending: (zone: string, id: string) =>
      f.cloud.service.getSending(zone, id).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const record = f.cloud.dns[0];
            if (record === undefined) throw new Error("Expected apex MX");
            f.cloud.dns[0] = { ...record, ttl: 7200 };
          }),
        ),
      ),
  };
  f.cloud.state.mutateApexOnRouting = true;
  await expect(f.run(f.make({ api }).apply(domain.domain_id))).rejects.toMatchObject({
    code: "action_required",
  });
  const row = await f.run(f.repo.get(domain.domain_id));
  expect(row).toMatchObject({ status: "FAILED", phase: "action_required", dns_step: "routing" });
  expect(row?.apex_snapshot).toContain("7200");
  expect(row?.apex_snapshot).not.toContain("changed.invalid");
  expect(f.cloud.buckets.size).toBe(0);
});

test("recovers an interrupted DNS step against its persisted pre-step apex snapshot", async () => {
  const f = await fixture();
  const domain = await f.run(f.provisioner.create({ domain: f.domain }));
  const api = {
    ...f.cloud.service,
    enableRouting: (...args: Parameters<typeof f.cloud.service.enableRouting>) =>
      f.cloud.service
        .enableRouting(...args)
        .pipe(Effect.tap(() => Effect.sync(() => f.cloud.failNext("dns")))),
  };
  await expect(f.run(f.make({ api }).apply(domain.domain_id))).rejects.toMatchObject({
    code: "service_unavailable",
  });
  expect((await f.run(f.repo.get(domain.domain_id)))?.dns_step).toBe("routing");
  const record = f.cloud.dns[0];
  if (record === undefined) throw new Error("Expected apex MX");
  f.cloud.dns[0] = { ...record, ttl: 7200 };
  const mutations = f.cloud.mutations.length;
  await expect(f.run(f.make().apply(domain.domain_id))).rejects.toMatchObject({
    code: "action_required",
  });
  expect(f.cloud.mutations).toHaveLength(mutations);
  f.cloud.dns[0] = record;
  expect((await f.run(f.make().apply(domain.domain_id))).status).toBe("VERIFYING");
});

test("verifies public DNS and the encrypted self-test through the real puller without mailbox storage", async () => {
  const f = await fixture();
  const domain = await f.run(f.provisioner.create({ domain: f.domain }));
  await f.run(f.provisioner.apply(domain.domain_id));
  expect((await f.run(f.provisioner.verify(domain.domain_id))).status).toBe("VERIFYING");
  expect(f.cloud.calls).not.toContain("sendSelfTest");
  f.dnsState.visible = true;
  expect((await f.run(f.provisioner.verify(domain.domain_id))).status).toBe("VERIFIED");
  expect(f.events).toHaveLength(1);
  expect(f.events[0]?.event_type).toBe("domain.verified");
  expect(f.cloud.rules.size).toBe(0);
  expect(await f.run(f.store.use((db) => db.prepare("SELECT * FROM messages").all()))).toEqual([]);
  expect(f.buffer.objects.size).toBe(0);
  expect((await f.run(f.provisioner.verify(domain.domain_id))).status).toBe("VERIFIED");
  expect(f.events).toHaveLength(1);
  expect(f.cloud.calls.filter((call) => call === "sendSelfTest")).toHaveLength(1);
});

test("does not report a queued or missing probe as verified, and retries after propagation time", async () => {
  const f = await fixture();
  const domain = await f.run(f.provisioner.create({ domain: f.domain }));
  await f.run(f.provisioner.apply(domain.domain_id));
  f.dnsState.visible = true;
  const arrive = f.cloud.state.onSelfTest;
  delete f.cloud.state.onSelfTest;
  expect((await f.run(f.provisioner.verify(domain.domain_id))).status).toBe("VERIFYING");
  expect(f.events).toEqual([]);
  const wrong = Buffer.from(
    `From: inbot-selftest@${f.domain}\r\nX-Inbot-Selftest: attacker\r\n\r\nFake`,
  );
  expect(
    await f.run(
      observeSelfTest(
        f.store,
        { mail_from: "attacker@foreign.test", rcpt_to: [`inbot-selftest@${f.domain}`] },
        wrong,
        receivedAt,
      ),
    ),
  ).toBe(false);
  if (arrive === undefined) throw new Error("Expected probe callback");
  f.cloud.state.onSelfTest = arrive;
  f.time.now += 300_000;
  expect((await f.run(f.provisioner.verify(domain.domain_id))).status).toBe("VERIFIED");
  await expect(
    f.run(f.mailbox.createInbox({ domain: f.domain, username: "inbot-selftest" })),
  ).rejects.toMatchObject({ code: "validation_error" });
});

test.each([false, true])(
  "reports an unconfirmed self-test send after a failure (lost response: %s)",
  async (after) => {
    const f = await fixture();
    const domain = await f.run(f.provisioner.create({ domain: f.domain }));
    await f.run(f.provisioner.apply(domain.domain_id));
    f.dnsState.visible = true;
    delete f.cloud.state.onSelfTest;
    f.cloud.failNext("sendSelfTest", after);
    await expect(f.run(f.provisioner.verify(domain.domain_id))).rejects.toMatchObject({
      code: "service_unavailable",
    });
    expect((await f.run(f.repo.get(domain.domain_id)))?.selftest_sent_at).toBe(f.time.now);
    const result = await f.run(f.make().verify(domain.domain_id));
    expect(result).toMatchObject({
      status: "VERIFYING",
      reason: expect.stringContaining("send was attempted"),
    });
    expect(result.reason).not.toContain("Waiting for the encrypted self-test");
    expect(f.cloud.calls.filter((call) => call === "sendSelfTest")).toHaveLength(1);
    f.time.now += 300_000;
    expect(await f.run(f.provisioner.verify(domain.domain_id))).toMatchObject({
      status: "VERIFYING",
      reason: expect.stringContaining("Waiting for the encrypted self-test"),
    });
    expect(f.cloud.calls.filter((call) => call === "sendSelfTest")).toHaveLength(2);
  },
);

test("observed encrypted arrival verifies a probe even when the send response was lost", async () => {
  const f = await fixture();
  const domain = await f.run(f.provisioner.create({ domain: f.domain }));
  await f.run(f.provisioner.apply(domain.domain_id));
  f.dnsState.visible = true;
  f.cloud.failNext("sendSelfTest", true);
  await expect(f.run(f.provisioner.verify(domain.domain_id))).rejects.toMatchObject({
    code: "service_unavailable",
  });
  expect((await f.run(f.make().verify(domain.domain_id))).status).toBe("VERIFIED");
  expect(f.cloud.calls.filter((call) => call === "sendSelfTest")).toHaveLength(1);
});

test("teardown deletes only owned resources in reverse order and preserves unrelated infrastructure", async () => {
  const f = await fixture();
  const domain = await f.run(f.provisioner.create({ domain: f.domain }));
  await f.run(f.provisioner.apply(domain.domain_id));
  const resources = await f.run(f.repo.resources(domain.domain_id));
  f.cloud.buckets.add("unrelated-bucket");
  f.cloud.queues.set("unrelated-queue", { queue_id: "unrelated-queue", queue_name: "unrelated" });
  const unrelatedRecord = {
    id: "unrelated-dns",
    name: "external.example.test",
    type: "A",
    content: "192.0.2.1",
  };
  f.cloud.dns.push(unrelatedRecord);
  const start = f.cloud.mutations.length;
  const result = await f.run(f.provisioner.teardown(domain.domain_id));
  expect(result.status).toBe("NOT_STARTED");
  expect(f.cloud.mutations.slice(start)).toEqual(
    resources
      .toReversed()
      .filter((resource) => resource.kind !== "routing")
      .map((resource) => {
        const action =
          resource.kind === "dns"
            ? "deleteDns"
            : resource.kind === "sending"
              ? "deleteSending"
              : resource.kind === "subscription"
                ? "deleteSubscription"
                : resource.kind === "worker"
                  ? "deleteWorker"
                  : resource.kind.includes("consumer")
                    ? "deleteConsumer"
                    : resource.kind.includes("queue")
                      ? "deleteQueue"
                      : "deleteBucket";
        return `${action}:${resource.cloudflare_id}`;
      }),
  );
  expect(f.cloud.buckets).toEqual(new Set(["unrelated-bucket"]));
  expect(f.cloud.queues.size).toBe(1);
  expect(f.cloud.dns).toContainEqual(unrelatedRecord);
  expect(f.cloud.dns).toHaveLength(4);
  expect(f.cloud.calls).not.toContain("disableRouting");
  expect(await f.run(f.repo.resources(domain.domain_id))).toEqual([]);
  expect(await f.run(f.inbound.get())).toBeUndefined();
  await f.run(f.provisioner.teardown(domain.domain_id));
  await f.run(f.provisioner.delete(domain.domain_id));
});

test.each([
  "createSending",
  "createBucket",
  "createQueue",
  "createConsumer",
  "uploadWorker",
  "createSubscription",
])("teardown reconciles a lost create response at %s", async (operation) => {
  const f = await fixture();
  const domain = await f.run(f.provisioner.create({ domain: f.domain }));
  f.cloud.failNext(operation, true);
  await expect(f.run(f.provisioner.apply(domain.domain_id))).rejects.toMatchObject({
    code: "service_unavailable",
  });
  await f.run(f.make().teardown(domain.domain_id));
  expect(
    f.cloud.sending.size +
      f.cloud.buckets.size +
      f.cloud.queues.size +
      f.cloud.consumers.size +
      f.cloud.workers.size +
      f.cloud.subscriptions.size,
  ).toBe(0);
  expect(f.cloud.dns).toHaveLength(3);
});

test("retains the recorded shared routing DKIM while another routed subdomain remains", async () => {
  const f = await fixture();
  const domain = await f.run(f.provisioner.create({ domain: f.domain }));
  await f.run(f.provisioner.apply(domain.domain_id));
  f.cloud.dns.push({
    id: "other-mx",
    name: "other.example.test",
    type: "MX",
    content: "route1.mx.cloudflare.net",
    priority: 10,
  });
  await f.run(f.provisioner.teardown(domain.domain_id));
  expect(
    (await f.run(f.repo.resources(domain.domain_id))).map((resource) => resource.name),
  ).toEqual(["cf2024-1._domainkey.example.test"]);
  f.cloud.dns.splice(
    f.cloud.dns.findIndex((record) => record.id === "other-mx"),
    1,
  );
  await f.run(f.provisioner.teardown(domain.domain_id));
  expect(f.cloud.dns).toHaveLength(3);
});

test("durable inbox jobs survive create/delete, provider failure, and missing-rule drift", async () => {
  const f = await fixture();
  const domain = await f.run(f.provisioner.create({ domain: f.domain }));
  await f.run(f.provisioner.apply(domain.domain_id));
  const inbox = await f.run(f.mailbox.createInbox({ domain: f.domain, username: "bot" }));
  expect(f.cloud.rules.size).toBe(0);
  f.cloud.failNext("createRule");
  expect(await f.run(f.provisioner.routing.run())).toMatchObject({ retried: 1 });
  f.time.now += 5000;
  expect(await f.run(f.make().routing.run())).toMatchObject({ retried: 0 });
  expect(f.cloud.rules.size).toBe(1);
  const rule = Array.from(f.cloud.rules.values())[0];
  expect(rule?.matchers).toEqual([{ type: "literal", field: "to", value: inbox.inbox_id }]);
  f.cloud.rules.clear();
  await f.run(f.provisioner.routing.reconcile());
  await f.run(f.provisioner.routing.run());
  expect(f.cloud.rules.size).toBe(1);
  await f.run(f.mailbox.deleteInbox(inbox.inbox_id));
  await f.run(f.provisioner.routing.run());
  expect(f.cloud.rules.size).toBe(0);
  expect(
    await f.run(f.store.use((db) => db.prepare("SELECT * FROM inbox_routing_rules").all())),
  ).toEqual([]);
});

test("a routing create with a lost response is adopted before inbox deletion", async () => {
  const f = await fixture();
  const domain = await f.run(f.provisioner.create({ domain: f.domain }));
  await f.run(f.provisioner.apply(domain.domain_id));
  const inbox = await f.run(f.mailbox.createInbox({ domain: f.domain, username: "bot" }));
  f.cloud.failNext("createRule", true);
  await f.run(f.provisioner.routing.run());
  await f.run(f.mailbox.deleteInbox(inbox.inbox_id));
  await f.run(f.provisioner.routing.run());
  expect(f.cloud.rules.size).toBe(0);
});

test("DNS verification rejects wrong values, wrong owner names, and wrong MX priorities", async () => {
  const dns = await Effect.runPromise(
    PublicDns.pipe(
      Effect.provide(
        PublicDns.live(async () =>
          Response.json({
            Status: 0,
            Answer: [
              { name: "agents.example.test.", type: 15, data: "20 route1.mx.cloudflare.net." },
              { name: "wrong.example.test.", type: 16, data: '"v=spf1 -all"' },
            ],
          }),
        ),
      ),
    ),
  );
  const result = await Effect.runPromise(
    dns.check([
      {
        type: "MX",
        name: "agents.example.test",
        value: "route1.mx.cloudflare.net",
        priority: 10,
        status: "MISSING",
      },
      { type: "TXT", name: "agents.example.test", value: "v=spf1 -all", status: "MISSING" },
    ]),
  );
  expect(result.map((record) => record.status)).toEqual(["INVALID", "MISSING"]);
});

test("replacing missing infrastructure requires a new encrypted verification probe", async () => {
  const f = await fixture();
  const domain = await f.run(f.provisioner.create({ domain: f.domain }));
  await f.run(f.provisioner.apply(domain.domain_id));
  f.dnsState.visible = true;
  await f.run(f.provisioner.verify(domain.domain_id));
  expect((await f.run(f.provisioner.apply(domain.domain_id))).status).toBe("VERIFIED");
  const old = await f.run(f.repo.get(domain.domain_id));
  f.cloud.workers.clear();
  expect((await f.run(f.make().apply(domain.domain_id))).status).toBe("VERIFYING");
  expect((await f.run(f.repo.get(domain.domain_id)))?.selftest_received_at).toBeNull();
  expect((await f.run(f.provisioner.verify(domain.domain_id))).status).toBe("VERIFIED");
  expect((await f.run(f.repo.get(domain.domain_id)))?.selftest_token).not.toBe(old?.selftest_token);
  expect(f.events).toHaveLength(2);
});

test("teardown stops inbox routing before checking a nonempty bucket and reapply restores rules", async () => {
  const f = await fixture();
  const domain = await f.run(f.provisioner.create({ domain: f.domain }));
  await f.run(f.provisioner.apply(domain.domain_id));
  await f.run(f.mailbox.createInbox({ domain: f.domain, username: "bot" }));
  await f.run(f.provisioner.routing.run());
  const rule = Array.from(f.cloud.rules.values())[0];
  if (rule === undefined) throw new Error("Expected inbox rule");
  const resources = await f.run(f.repo.resources(domain.domain_id));
  f.buffer.putObject(key(900), new Uint8Array([1, 2, 3]), receivedAt);
  const mutations = f.cloud.mutations.length;
  const provisioner = f.make({
    buffer: {
      ...f.buffer.service,
      listObjects: (prefix, cursor) =>
        Effect.gen(function* () {
          expect(f.cloud.rules.size).toBe(0);
          return yield* f.buffer.service.listObjects(prefix, cursor);
        }),
    },
  });
  await expect(f.run(provisioner.teardown(domain.domain_id))).rejects.toMatchObject({
    code: "action_required",
    fix: expect.stringContaining("Drain the buffer"),
  });
  expect(f.cloud.mutations.slice(mutations)).toEqual([`deleteRule:${rule.id}`]);
  expect(await f.run(f.repo.resources(domain.domain_id))).toEqual(resources);
  expect(await f.run(f.inbound.get())).toBeDefined();
  await f.run(f.make().apply(domain.domain_id));
  await f.run(f.provisioner.routing.run());
  expect(f.cloud.rules.size).toBe(1);
  f.buffer.objects.clear();
  await f.run(f.make().teardown(domain.domain_id));
  expect(f.cloud.buckets.size).toBe(0);
});

test("reconcile repairs a disabled recorded rule without leaking it or deleting unrelated rules", async () => {
  const f = await fixture();
  const domain = await f.run(f.provisioner.create({ domain: f.domain }));
  await f.run(f.provisioner.apply(domain.domain_id));
  const inbox = await f.run(f.mailbox.createInbox({ domain: f.domain, username: "bot" }));
  await f.run(f.provisioner.routing.run());
  const old = Array.from(f.cloud.rules.values())[0];
  if (old === undefined) throw new Error("Expected recorded inbox rule");
  f.cloud.rules.set(old.id, { ...old, enabled: false });
  f.cloud.rules.set("unrelated", {
    ...old,
    id: "unrelated",
    name: "unrelated",
    matchers: [{ type: "literal", field: "to", value: "other@agents.example.test" }],
  });
  await f.run(f.provisioner.routing.reconcile());
  f.cloud.failNext("deleteRule");
  expect(await f.run(f.provisioner.routing.run())).toMatchObject({ retried: 1 });
  f.time.now += 10000;
  await f.run(f.provisioner.routing.run());
  expect(f.cloud.rules.has(old.id)).toBe(false);
  expect(f.cloud.rules.has("unrelated")).toBe(true);
  expect(f.cloud.rules.size).toBe(2);
  await f.run(f.mailbox.deleteInbox(inbox.inbox_id));
  await f.run(f.provisioner.routing.run());
  expect(f.cloud.rules.size).toBe(1);
});

test.each([
  "deleteDns",
  "deleteSending",
  "deleteBucket",
  "deleteQueue",
  "deleteConsumer",
  "deleteWorker",
  "deleteSubscription",
])("resumes teardown after a lost response from %s", async (operation) => {
  const f = await fixture();
  const domain = await f.run(f.provisioner.create({ domain: f.domain }));
  await f.run(f.provisioner.apply(domain.domain_id));
  f.cloud.failNext(operation, true);
  await expect(f.run(f.provisioner.teardown(domain.domain_id))).rejects.toMatchObject({
    code: "service_unavailable",
  });
  await f.run(f.make().teardown(domain.domain_id));
  expect(await f.run(f.repo.resources(domain.domain_id))).toEqual([]);
  expect(f.cloud.dns).toHaveLength(3);
});

test("concurrent apply requests share one serialized resource set", async () => {
  const f = await fixture();
  const domain = await f.run(f.provisioner.create({ domain: f.domain }));
  await Promise.all([
    f.run(f.provisioner.apply(domain.domain_id)),
    f.run(f.provisioner.apply(domain.domain_id)),
  ]);
  expect(f.cloud.sending.size).toBe(1);
  expect(f.cloud.buckets.size).toBe(1);
  expect(f.cloud.queues.size).toBe(2);
  expect(f.cloud.workers.size).toBe(1);
});

test("domain pagination keeps stale token errors and BIND TXT values use bounded strings", async () => {
  const f = await fixture();
  await expect(f.run(f.provisioner.list({ page_token: "invalid" }))).rejects.toMatchObject({
    code: "page_token_stale",
  });
  const value = `v=DKIM1; p=${"A".repeat(600)}`;
  const text = bindRecord({
    type: "TXT",
    name: "key.agents.example.test",
    value,
    status: "MISSING",
  });
  const chunks = Array.from(text.matchAll(/"([^"\\]*)"/g), (match) => match[1] ?? "");
  expect(chunks.join("")).toBe(value);
  expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 255)).toBe(true);
});

test("adopted resources survive teardown and a recreated adopted resource becomes owned", async () => {
  const f = await fixture();
  const domain = await f.run(f.provisioner.create({ domain: f.domain }));
  const bucket = `inbot-${domain.domain_id}-inbound`;
  f.cloud.buckets.add(bucket);
  await f.run(f.provisioner.apply(domain.domain_id));
  expect(
    (await f.run(f.repo.resources(domain.domain_id))).find((resource) => resource.kind === "bucket")
      ?.owned,
  ).toBe(0);
  f.cloud.buckets.delete(bucket);
  await f.run(f.provisioner.apply(domain.domain_id));
  expect(
    (await f.run(f.repo.resources(domain.domain_id))).find((resource) => resource.kind === "bucket")
      ?.owned,
  ).toBe(1);
  await f.run(f.provisioner.teardown(domain.domain_id));
  expect(f.cloud.buckets.has(bucket)).toBe(false);
});

test("existing sending and routing DNS are adopted without deleting their records", async () => {
  const f = await fixture();
  const zone = f.cloud.zones[0];
  if (zone === undefined) throw new Error("Expected fake zone");
  await f.run(f.cloud.service.createSending(zone, f.domain));
  await f.run(f.cloud.service.enableRouting(zone, f.domain));
  const ids = f.cloud.dns.map((record) => record.id);
  const domain = await f.run(f.provisioner.create({ domain: f.domain }));
  await f.run(f.provisioner.apply(domain.domain_id));
  await f.run(f.provisioner.teardown(domain.domain_id));
  expect(f.cloud.sending.size).toBe(1);
  expect(f.cloud.dns.map((record) => record.id)).toEqual(ids);
});

test.each(["identity", "bundle", "settings"])(
  "resumes after a local %s step failure",
  async (step) => {
    const f = await fixture();
    const domain = await f.run(f.provisioner.create({ domain: f.domain }));
    const broken = f.make({
      inbound: {
        ...f.inbound,
        generateInboundIdentity:
          step === "identity"
            ? () => Effect.fail(new BufferError({ code: "identity_failed" }))
            : f.inbound.generateInboundIdentity,
        set:
          step === "settings"
            ? () => Effect.fail(new BufferError({ code: "invalid_config" }))
            : f.inbound.set,
      },
      readWorker:
        step === "bundle"
          ? async () => {
              throw new Error("Synthetic missing artifact");
            }
          : async () => "export default { email() {} };",
    });
    await expect(f.run(broken.apply(domain.domain_id))).rejects.toBeDefined();
    expect((await f.run(f.make().apply(domain.domain_id))).status).toBe("VERIFYING");
    expect(f.cloud.workers.size).toBe(1);
    expect(f.cloud.queues.size).toBe(2);
    expect(await f.run(f.inbound.get())).toBeDefined();
  },
);
