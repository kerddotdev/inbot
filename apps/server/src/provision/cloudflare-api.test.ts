import { Effect, Layer, Redacted } from "effect";
import { expect, test, vi } from "vitest";
import { TransportConfig } from "../outbound/transport-config.js";
import { CloudflareApi, sendingEvents, type Zone } from "./cloudflare-api.js";

const zone: Zone = { id: "zone", name: "example.test", account: { id: "account" } };
const domain = "agents.example.test";
const sending = {
  id: "sending",
  tag: "sending",
  name: domain,
  enabled: true,
  preview_enabled: true,
};
const rule = {
  id: "rule",
  tag: "rule",
  name: "inbot-rule",
  enabled: true,
  matchers: [{ type: "literal", field: "to", value: `bot@${domain}` }],
  actions: [{ type: "worker", value: ["worker"] }],
};
const subscription = {
  id: "subscription",
  name: "events",
  enabled: true,
  source: { type: "email.sending", zone_id: zone.id, domain },
  destination: { type: "queues.queue", queue_id: "queue" },
  events: sendingEvents,
};
function service(fetch: typeof globalThis.fetch, configured = true) {
  return Effect.runPromise(
    CloudflareApi.pipe(
      Effect.provide(
        CloudflareApi.live({ fetch }).pipe(
          Layer.provide(
            Layer.succeed(TransportConfig, {
              get: () =>
                Effect.succeed(
                  configured
                    ? {
                        account_id: "account",
                        api_token: Redacted.make("synthetic-token"),
                      }
                    : undefined,
                ),
              set: () => Effect.void,
              clear: () => Effect.void,
            }),
          ),
        ),
      ),
    ),
  );
}
function response(result: unknown, result_info?: unknown) {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    ...(result_info === undefined ? {} : { result_info }),
  });
}

test("missing transport gives a Settings fix before any provider request", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const api = await service(fetch, false);
  await expect(Effect.runPromise(api.verifyToken())).rejects.toMatchObject({
    code: "validation_error",
    message: "Configure a Cloudflare transport token first.",
    fix: "Configure the Cloudflare mail transport in Settings, then register the domain again.",
  });
  expect(fetch).not.toHaveBeenCalled();
});

test("uses captured sending/routing/subscription shapes and correct request fields", async () => {
  const seen: { path: string; method: string; body: unknown }[] = [];
  const api = await service(async (input, options) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.cloudflare.com");
    expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer synthetic-token");
    const method = options?.method ?? "GET";
    const body: unknown = typeof options?.body === "string" ? JSON.parse(options.body) : undefined;
    seen.push({ path: url.pathname, method, body });
    if (url.pathname.endsWith("/tokens/verify")) return response({ id: "token", status: "active" });
    if (url.pathname.endsWith("/subdomains") && method === "POST") return response(sending);
    if (url.pathname.endsWith("/subdomains/sending"))
      return response({ ...sending, preview_enabled: false });
    if (url.pathname.endsWith("/rules") && method === "POST") return response(rule);
    if (url.pathname.endsWith("/subscriptions") && method === "POST") return response(subscription);
    if (url.pathname.endsWith("/consumers") && method === "POST")
      return response({ consumer_id: "consumer", type: "http_pull" });
    return response({});
  });
  await Effect.runPromise(api.verifyToken());
  expect(await Effect.runPromise(api.createSending(zone, domain))).toMatchObject({
    tag: "sending",
    preview_enabled: true,
  });
  await Effect.runPromise(api.disablePreview(zone.id, "sending"));
  expect((await Effect.runPromise(api.getSending(zone.id, "sending"))).preview_enabled).toBe(false);
  await Effect.runPromise(api.enableRouting(zone, domain));
  await Effect.runPromise(api.unlockRoutingDns(zone, domain));
  await Effect.runPromise(api.createRule(zone, `bot@${domain}`, "worker", "inbot-rule"));
  await Effect.runPromise(api.createConsumer("queue"));
  await Effect.runPromise(api.configureEventsQueue("queue", "events"));
  await Effect.runPromise(api.createSubscription(zone.id, domain, "queue", "events"));
  expect(seen).toContainEqual({
    path: "/client/v4/zones/zone/email/routing/dns",
    method: "POST",
    body: { name: domain },
  });
  expect(seen.filter((request) => request.path.endsWith("/email/routing/dns"))).toEqual([
    { path: "/client/v4/zones/zone/email/routing/dns", method: "POST", body: { name: domain } },
    { path: "/client/v4/zones/zone/email/routing/dns", method: "PATCH", body: { name: domain } },
  ]);
  expect(seen).toContainEqual({
    path: "/client/v4/zones/zone/email/sending/subdomains/sending",
    method: "PATCH",
    body: { preview_enabled: false },
  });
  expect(seen.find((request) => request.path.endsWith("/rules"))?.body).toMatchObject({
    matchers: [{ type: "literal", field: "to", value: `bot@${domain}` }],
    actions: [{ type: "worker", value: ["worker"] }],
  });
  expect(seen.find((request) => request.path.endsWith("/consumers"))?.body).toEqual({
    type: "http_pull",
  });
  expect(seen.find((request) => request.path.endsWith("/queues/queue"))?.body).toMatchObject({
    settings: { message_retention_period: 300 },
  });
  expect(seen.find((request) => request.path.endsWith("/subscriptions"))?.body).toMatchObject({
    source: { type: "email.sending", zone_id: "zone", domain },
    destination: { type: "queues.queue", queue_id: "queue" },
    events: sendingEvents,
  });
});

test("uploads one multipart module with public recipient and disables workers.dev and preview URLs", async () => {
  const requests: { path: string; body: RequestInit["body"] }[] = [];
  const api = await service(async (input, options) => {
    requests.push({ path: new URL(String(input)).pathname, body: options?.body });
    return response({});
  });
  await Effect.runPromise(
    api.uploadWorker({
      name: "worker",
      source: "export default { email() {} };",
      bucket: "bucket",
      queue: "inbound",
      recipient: "age1synthetic",
    }),
  );
  await Effect.runPromise(api.disableWorkerPublicUrls("worker"));
  const body = requests[0]?.body;
  expect(body).toBeInstanceOf(FormData);
  if (!(body instanceof FormData)) throw new Error("Expected multipart form");
  expect(Array.from(body.keys()).sort()).toEqual(["inbound.js", "metadata"]);
  const metadata = body.get("metadata");
  if (!(metadata instanceof Blob)) throw new Error("Expected JSON metadata part");
  const parsed: unknown = JSON.parse(await metadata.text());
  expect(parsed).toEqual({
    main_module: "inbound.js",
    compatibility_date: "2026-10-10",
    bindings: [
      { type: "r2_bucket", name: "INBOUND_BUCKET", bucket_name: "bucket" },
      { type: "queue", name: "INBOUND_QUEUE", queue_name: "inbound" },
      { type: "plain_text", name: "RECIPIENT", text: "age1synthetic" },
    ],
  });
  expect(requests[1]).toEqual({
    path: "/client/v4/accounts/account/workers/scripts/worker/subdomain",
    body: JSON.stringify({ enabled: false, previews_enabled: false }),
  });
});

test("refuses apex routing/sending before fetch and never calls the unscoped disable endpoint", async () => {
  let calls = 0;
  const api = await service(async () => {
    calls++;
    return response({});
  });
  await expect(Effect.runPromise(api.createSending(zone, zone.name))).rejects.toMatchObject({
    code: "validation_error",
  });
  await expect(Effect.runPromise(api.enableRouting(zone, zone.name))).rejects.toMatchObject({
    code: "validation_error",
  });
  for (const name of ["", zone.name, "*.example.test", "other.invalid"])
    await expect(Effect.runPromise(api.unlockRoutingDns(zone, name))).rejects.toMatchObject({
      code: "validation_error",
    });
  await expect(Effect.runPromise(api.disableRouting(zone, domain))).rejects.toMatchObject({
    code: "not_supported",
  });
  await expect(
    Effect.runPromise(api.createRule(zone, "*@example.test", "worker", "rule")),
  ).rejects.toMatchObject({ code: "validation_error" });
  expect(calls).toBe(0);
});

test("names the denied permission without returning provider bodies or credentials", async () => {
  const api = await service(async () =>
    Response.json(
      { success: false, errors: [{ message: "secret provider detail" }] },
      { status: 403 },
    ),
  );
  await expect(Effect.runPromise(api.createQueue("queue"))).rejects.toMatchObject({
    code: "missing_permission",
    message: "The Cloudflare token needs Queues Write (POST queue).",
  });
});

test("paginates zones, DNS, queues and subscriptions and follows R2 cursors", async () => {
  const calls: URL[] = [];
  const api = await service(async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    const second = url.searchParams.get("page") === "2";
    const info = { total_pages: 2 };
    if (url.pathname.endsWith("/zones")) return response(second ? [zone] : [], info);
    if (url.pathname.endsWith("/dns_records"))
      return response(
        second
          ? [
              {
                id: "dns",
                type: "TXT",
                name: domain,
                content: "v=spf1 -all",
                proxiable: false,
                proxied: false,
                ttl: 1,
                comment: null,
                tags: [],
                meta: {},
              },
            ]
          : [],
        info,
      );
    if (url.pathname.endsWith("/queues"))
      return response(second ? [{ queue_id: "queue", queue_name: "inbound" }] : [], info);
    if (url.pathname.endsWith("/subscriptions"))
      return response(second ? [subscription] : [], info);
    if (url.pathname.endsWith("/buckets"))
      return response(
        { buckets: [{ name: url.searchParams.has("cursor") ? "second" : "first" }] },
        url.searchParams.has("cursor") ? {} : { cursor: "next" },
      );
    throw new Error("Unexpected endpoint");
  });
  expect(await Effect.runPromise(api.zones(zone.name))).toEqual([zone]);
  expect((await Effect.runPromise(api.dns(zone.id)))[0]?.id).toBe("dns");
  expect((await Effect.runPromise(api.queues()))[0]?.queue_id).toBe("queue");
  expect(await Effect.runPromise(api.subscriptions())).toEqual([subscription]);
  expect(await Effect.runPromise(api.buckets())).toEqual(["first", "second"]);
  expect(calls[0]?.searchParams.get("account.id")).toBe("account");
});

test("supports account token verification", async () => {
  const paths: string[] = [];
  const api = await service(async (input) => {
    paths.push(new URL(String(input)).pathname);
    return response({ id: "token", status: "active" });
  });
  await Effect.runPromise(api.verifyToken());
  expect(paths).toEqual(["/client/v4/accounts/account/tokens/verify"]);
});

const recordedDeletes = [
  {
    kind: "DNS records",
    path: "/zones/zone/dns_records/dns",
    run: (api: CloudflareApi["Service"]) => api.deleteDns(zone.id, "dns"),
  },
  {
    kind: "sending subdomain",
    path: "/zones/zone/email/sending/subdomains/sending",
    run: (api: CloudflareApi["Service"]) => api.deleteSending(zone.id, "sending"),
  },
  {
    kind: "routing rule",
    path: "/zones/zone/email/routing/rules/rule",
    run: (api: CloudflareApi["Service"]) => api.deleteRule(zone.id, "rule"),
  },
  {
    kind: "R2 bucket",
    path: "/accounts/account/r2/buckets/bucket",
    run: (api: CloudflareApi["Service"]) => api.deleteBucket("bucket"),
  },
  {
    kind: "queue",
    path: "/accounts/account/queues/queue",
    run: (api: CloudflareApi["Service"]) => api.deleteQueue("queue"),
  },
  {
    kind: "queue consumer",
    path: "/accounts/account/queues/queue/consumers/consumer",
    run: (api: CloudflareApi["Service"]) => api.deleteConsumer("queue", "consumer"),
  },
  {
    kind: "Worker",
    path: "/accounts/account/workers/scripts/worker",
    run: (api: CloudflareApi["Service"]) => api.deleteWorker("worker"),
  },
  {
    kind: "event subscription",
    path: "/accounts/account/event_subscriptions/subscriptions/subscription",
    run: (api: CloudflareApi["Service"]) => api.deleteSubscription("subscription"),
  },
];

test.each(recordedDeletes)(
  "treats a recorded $kind DELETE 404 as already deleted",
  async ({ path, run }) => {
    const api = await service(async (input, options) => {
      expect(new URL(String(input)).pathname).toBe(`/client/v4${path}`);
      expect(options?.method).toBe("DELETE");
      return new Response(null, { status: 404 });
    });
    await Effect.runPromise(run(api));
  },
);

test.each(recordedDeletes)(
  "names the failing $kind delete without disclosing provider details",
  async ({ kind, run }) => {
    const api = await service(async () =>
      Response.json(
        { success: false, errors: [{ message: "secret provider detail" }] },
        { status: 400 },
      ),
    );
    await expect(Effect.runPromise(run(api))).rejects.toMatchObject({
      code: "service_unavailable",
      message: `Cloudflare did not confirm the provisioning operation (DELETE ${kind}).`,
      fix: "Retry to reconcile durable progress. Check the account, token, and provider availability.",
    });
  },
);

test.each(["http", "envelope", "network", "decode"])(
  "names a routing DNS unlock failure from %s",
  async (failure) => {
    const api = await service(async () => {
      if (failure === "network") throw new Error("secret provider detail");
      if (failure === "http") return new Response(null, { status: 400 });
      if (failure === "decode") return Response.json({ unexpected: "secret provider detail" });
      return Response.json({ success: false, errors: [{ message: "secret provider detail" }] });
    });
    await expect(Effect.runPromise(api.unlockRoutingDns(zone, domain))).rejects.toMatchObject({
      code: "service_unavailable",
      message: "Cloudflare did not confirm the provisioning operation (PATCH routing DNS).",
    });
  },
);

test.each([401, 403, 404])(
  "falls back to user token verification when the account endpoint returns %s",
  async (status) => {
    const paths: string[] = [];
    const api = await service(async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return path === "/client/v4/accounts/account/tokens/verify"
        ? new Response(null, { status })
        : response({ id: "token", status: "active" });
    });
    await Effect.runPromise(api.verifyToken());
    expect(paths).toEqual([
      "/client/v4/accounts/account/tokens/verify",
      "/client/v4/user/tokens/verify",
    ]);
  },
);

test("rejects a token denied by both verification endpoints", async () => {
  const paths: string[] = [];
  const api = await service(async (input) => {
    paths.push(new URL(String(input)).pathname);
    return new Response(null, { status: 403 });
  });
  await expect(Effect.runPromise(api.verifyToken())).rejects.toMatchObject({
    code: "missing_permission",
  });
  expect(paths).toHaveLength(2);
});

test.each(["disabled", "expired", "unavailable"])(
  "does not try another endpoint for a token reported as %s",
  async (status) => {
    const paths: string[] = [];
    const api = await service(async (input) => {
      paths.push(new URL(String(input)).pathname);
      return status === "unavailable"
        ? new Response(null, { status: 503 })
        : response({ id: "token", status });
    });
    await expect(Effect.runPromise(api.verifyToken())).rejects.toMatchObject({
      code: "service_unavailable",
    });
    expect(paths).toEqual(["/client/v4/accounts/account/tokens/verify"]);
  },
);

test("names routing unlock permission failures while preserving the permission fix", async () => {
  const api = await service(async () => new Response(null, { status: 403 }));
  await expect(Effect.runPromise(api.unlockRoutingDns(zone, domain))).rejects.toMatchObject({
    code: "missing_permission",
    message: "The Cloudflare token needs Zone Settings Write (PATCH routing DNS).",
    fix: "Grant Zone Settings Write on the configured account or zone, then retry.",
  });
});

test("remote adapter uses remotely managed tunnels, secret tokens and proxied owned DNS", async () => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const tunnel = { id: "tunnel-id", name: "inbot-remote-synthetic", config_src: "cloudflare" };
  const api = await service(async (input, options) => {
    const url = new URL(String(input));
    const method = options?.method ?? "GET";
    const body: unknown = typeof options?.body === "string" ? JSON.parse(options.body) : undefined;
    calls.push({ path: url.pathname + url.search, method, body });
    if (url.pathname.endsWith("/token")) return response("synthetic-secret");
    if (url.pathname.endsWith("/dns_records") && method === "POST")
      return response({
        id: "dns-id",
        type: "CNAME",
        name: "inbot.example.test",
        content: "tunnel-id.cfargotunnel.com",
        proxied: true,
        comment: "inbot:synthetic",
      });
    if (method === "GET") return response([tunnel]);
    return method === "POST" ? response(tunnel) : response(null);
  });
  expect(await Effect.runPromise(api.tunnels())).toEqual([tunnel]);
  await Effect.runPromise(api.createTunnel(tunnel.name));
  await Effect.runPromise(
    api.configureTunnel(tunnel.id, "inbot.example.test", "http://127.0.0.1:3456"),
  );
  expect(Redacted.value(await Effect.runPromise(api.tunnelToken(tunnel.id)))).toBe(
    "synthetic-secret",
  );
  await Effect.runPromise(
    api.createTunnelDns(zone, "inbot.example.test", tunnel.id, "inbot:synthetic"),
  );
  await Effect.runPromise(api.deleteTunnel(tunnel.id));
  expect(calls[0]?.path).toContain("cfd_tunnel?is_deleted=false");
  expect(calls[1]).toMatchObject({
    method: "POST",
    body: { name: tunnel.name, config_src: "cloudflare" },
  });
  expect(calls[2]).toMatchObject({
    path: "/client/v4/accounts/account/cfd_tunnel/tunnel-id/configurations",
    method: "PUT",
    body: {
      config: {
        ingress: [
          { hostname: "inbot.example.test", service: "http://127.0.0.1:3456" },
          { service: "http_status:404" },
        ],
      },
    },
  });
  expect(calls[4]).toMatchObject({
    method: "POST",
    body: {
      type: "CNAME",
      name: "inbot.example.test",
      content: "tunnel-id.cfargotunnel.com",
      proxied: true,
      ttl: 1,
      comment: "inbot:synthetic",
    },
  });
  expect(calls[5]?.method).toBe("DELETE");
  await expect(
    Effect.runPromise(api.createTunnelDns(zone, zone.name, tunnel.id, "marker")),
  ).rejects.toMatchObject({ code: "validation_error" });
  expect(calls).toHaveLength(6);
});
