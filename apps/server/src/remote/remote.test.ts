import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test as base } from "vitest";
import { fixture } from "../http/test-fixture.js";
import { makeRemote } from "./remote.js";
import { remoteRepository } from "./repository.js";
import { artifacts, makeBinary, sha256 } from "./binary.js";

const hostname = "inbot.example.test";
const test = base.extend<{ f: Awaited<ReturnType<typeof fixture>> }>({
  f: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-remote-"));
    const f = await fixture(home);
    try {
      await use(f);
    } finally {
      await f.close();
      await rm(home, { recursive: true, force: true });
    }
  },
});

test("rejects apex, wildcard, invalid, and foreign hostnames before effects", async ({ f }) => {
  for (const hostname of [
    "example.test",
    "*.example.test",
    "bad..example.test",
    "-bad.example.test",
    "inbot.foreign.test",
    "https://inbot.example.test",
    "inbot.example.test/path",
  ]) {
    await expect(f.run(f.remote.enable({ hostname }))).rejects.toMatchObject({
      code: "validation_error",
    });
  }
  expect(f.cloud.mutations).toEqual([]);
  expect((await f.run(f.remote.status())).state).toBe("disabled");
  f.cloud.permissions.delete("Cloudflare Tunnel Write");
  await expect(f.run(f.remote.enable({ hostname }))).rejects.toMatchObject({
    code: "missing_permission",
  });
  expect(f.cloud.mutations).toEqual([]);
});

test("provisions one owned tunnel and proxied CNAME and never exposes credentials", async ({
  f,
}) => {
  const apex = f.cloud.dns.filter((record) => record.name === "example.test");
  const first = await f.run(f.remote.enable({ hostname: hostname.toUpperCase() }));
  expect(first).toEqual({
    state: "connecting",
    hostname,
    reason: null,
    connector_version: "2026.9.1",
  });
  const tunnel = Array.from(f.cloud.tunnels.values())[0];
  expect(tunnel).toBeDefined();
  expect(f.cloud.dns.find((record) => record.name === hostname)).toMatchObject({
    type: "CNAME",
    content: `${tunnel?.id}.cfargotunnel.com`,
    proxied: true,
  });
  expect(f.cloud.tunnelConfigs.get(tunnel?.id ?? "")?.origin).toBe(f.tunnelUrl);
  expect(f.cloud.dns.filter((record) => record.name === "example.test")).toEqual(apex);
  await f.run(f.remote.enable({ hostname }));
  expect(f.cloud.tunnels.size).toBe(1);
  expect(f.cloud.dns.filter((record) => record.name === hostname)).toHaveLength(1);
  expect(JSON.stringify(await f.run(f.remote.status()))).not.toContain("token");
  expect(
    (await readFile(join(f.home, "inbot.db"))).includes(Buffer.from("synthetic-tunnel-token")),
  ).toBe(false);
  expect((await f.run(f.remote.disable())).state).toBe("disabled");
  expect(f.connector.running).toBe(false);
  expect(f.cloud.tunnels.size).toBe(0);
  expect(f.cloud.dns.filter((record) => record.name === hostname)).toEqual([]);
  await f.run(f.remote.disable());
});

for (const operation of ["createTunnel", "configureTunnel", "createTunnelDns", "tunnelToken"]) {
  test(`reconciles an uncertain ${operation} without duplicate resources`, async ({ f }) => {
    f.cloud.failNext(operation, true);
    await expect(f.run(f.remote.enable({ hostname }))).rejects.toMatchObject({
      code: "service_unavailable",
    });
    expect((await f.run(f.remote.status())).state).toBe("action_required");
    const fresh = makeRemote({
      store: f.store,
      api: f.cloud.service,
      provisioner: f.provisioner,
      binary: { ensure: () => Effect.succeed("/fake/verified") },
      spawn: async () => ({
        pid: 101,
        exited: () => false,
        ready: async () => false,
        stop: async () => {},
      }),
    });
    await f.run(fresh.attach(f.tunnelUrl));
    await f.run(fresh.enable({ hostname }));
    expect(f.cloud.tunnels.size).toBe(1);
    expect(f.cloud.dns.filter((record) => record.name === hostname)).toHaveLength(1);
    expect(f.cloud.mutations.filter((call) => call === "createTunnel")).toHaveLength(1);
    expect(f.cloud.mutations.filter((call) => call === "createTunnelDns")).toHaveLength(1);
    await f.run(fresh.shutdown());
    await f.run(fresh.disable());
  });
}

test("disable reconciles a tunnel created before its ID was recorded", async ({ f }) => {
  f.cloud.failNext("createTunnel", true);
  await expect(f.run(f.remote.enable({ hostname }))).rejects.toMatchObject({
    code: "service_unavailable",
  });
  expect(f.cloud.tunnels.size).toBe(1);
  await f.run(f.remote.disable());
  expect(f.cloud.tunnels.size).toBe(0);
});

for (const operation of ["deleteDns", "deleteTunnel"]) {
  test(`disable retains durable ownership after an uncertain ${operation}`, async ({ f }) => {
    await f.run(f.remote.enable({ hostname }));
    f.cloud.failNext(operation, true);
    await expect(f.run(f.remote.disable())).rejects.toMatchObject({ code: "service_unavailable" });
    expect(f.connector.running).toBe(false);
    expect((await f.run(f.remote.status())).state).toBe("action_required");
    expect(await f.run(f.remote.publicOrigin())).toBeUndefined();
    await f.run(f.remote.disable());
    expect(f.cloud.tunnels.size).toBe(0);
    expect(f.cloud.dns.filter((record) => record.name === hostname)).toEqual([]);
  });
}

test("does not overwrite or delete existing or changed DNS", async ({ f }) => {
  f.cloud.addDns([{ type: "CNAME", name: hostname, content: "other.example.test" }]);
  await expect(f.run(f.remote.enable({ hostname }))).rejects.toMatchObject({
    code: "action_required",
  });
  expect(f.cloud.mutations).toEqual([]);
  const other = f.cloud.dns.find((record) => record.name === hostname);
  if (other === undefined) throw new Error("Missing conflicting DNS");
  f.cloud.dns.splice(f.cloud.dns.indexOf(other), 1);
  await f.run(f.remote.enable({ hostname }));
  const index = f.cloud.dns.findIndex((record) => record.name === hostname);
  const owned = f.cloud.dns[index];
  if (owned === undefined) throw new Error("Missing DNS record");
  f.cloud.dns[index] = { ...owned, content: "changed.example.test" };
  await expect(f.run(f.remote.disable())).rejects.toMatchObject({ code: "action_required" });
  expect(f.cloud.tunnels.size).toBe(1);
  expect(f.cloud.dns[index]?.content).toBe("changed.example.test");
});

test("account changes never redirect teardown to another account", async ({ f }) => {
  await f.run(f.remote.enable({ hostname }));
  f.cloud.account.id = "other-account";
  await f.run(f.remote.tick());
  expect(f.connector.running).toBe(false);
  expect((await f.run(f.remote.status())).state).toBe("action_required");
  await expect(f.run(f.remote.disable())).rejects.toMatchObject({ code: "action_required" });
  expect(f.cloud.tunnels.size).toBe(1);
});

test("readiness controls state and injected clock bounds restart backoff and stop", async ({
  f,
}) => {
  await f.run(f.remote.enable({ hostname }));
  await f.run(f.remote.tick());
  expect((await f.run(f.remote.status())).state).toBe("connecting");
  f.connector.ready = true;
  await f.run(f.remote.tick());
  expect((await f.run(f.remote.status())).state).toBe("connected");
  f.connector.running = false;
  expect((await f.run(f.remote.status())).state).toBe("connecting");
  await f.run(f.remote.tick());
  f.advance(999);
  await f.run(f.remote.tick());
  expect(f.connector.starts).toBe(1);
  f.advance(1);
  await f.run(f.remote.tick());
  expect(f.connector.starts).toBe(2);
  f.connector.ready = false;
  f.connector.running = false;
  await f.run(f.remote.tick());
  f.advance(1000);
  await f.run(f.remote.tick());
  expect(f.connector.starts).toBe(3);
  f.connector.running = false;
  await f.run(f.remote.tick());
  f.advance(1999);
  await f.run(f.remote.tick());
  expect(f.connector.starts).toBe(3);
  await f.run(f.remote.disable());
  f.advance(60_000);
  await f.run(f.remote.tick());
  expect(f.connector.starts).toBe(3);
});

test("shutdown stops only the injected child and restart never downloads", async ({ f }) => {
  await f.run(f.remote.enable({ hostname }));
  await f.run(f.remote.shutdown());
  expect(f.connector.running).toBe(false);
  expect(f.connector.stops).toBe(1);
  expect((await f.run(remoteRepository(f.store).get()))?.desired).toBe("enabled");
  const permissions: boolean[] = [];
  const remote = makeRemote({
    store: f.store,
    api: f.cloud.service,
    provisioner: f.provisioner,
    binary: {
      ensure: (allowed) =>
        Effect.sync(() => {
          permissions.push(allowed);
          return "/fake/verified";
        }),
    },
    spawn: async () => ({
      pid: 103,
      exited: () => false,
      ready: async () => true,
      stop: async () => {},
    }),
  });
  await f.run(remote.attach("http://127.0.0.1:4567"));
  await f.run(remote.tick());
  expect(permissions).toEqual([false]);
  expect((await f.run(remote.status())).state).toBe("connected");
  const row = await f.run(remoteRepository(f.store).get());
  expect(f.cloud.tunnelConfigs.get(row?.tunnel_id ?? "")?.origin).toBe("http://127.0.0.1:4567");
  await f.run(remote.shutdown());
});

test("checksum mismatch refuses execution and cached tampering is detected", async ({ f }) => {
  const bytes = Buffer.from("synthetic executable");
  let downloads = 0;
  const artifact = { file: "cloudflared-test", sha256: sha256(bytes) };
  const binary = makeBinary(f.home, {
    platform: "linux-x64",
    artifact,
    downloader: async () => {
      downloads++;
      return bytes;
    },
  });
  await expect(f.run(binary.ensure(false))).rejects.toMatchObject({ code: "action_required" });
  expect(downloads).toBe(0);
  const path = await f.run(binary.ensure(true));
  expect(await readFile(path)).toEqual(bytes);
  await writeFile(path, "tampered executable");
  await f.run(binary.ensure(false));
  expect(await readFile(path)).toEqual(bytes);
  await writeFile(join(f.home, "bin", "2026.9.1-cloudflared-test"), "tampered archive");
  await expect(f.run(binary.ensure(true))).rejects.toMatchObject({
    code: "action_required",
    message: expect.stringContaining("checksum mismatch"),
  });
  expect(downloads).toBe(1);
  const mismatch = makeBinary(join(f.home, "mismatch"), {
    artifact,
    downloader: async () => Buffer.from("invalid"),
  });
  await expect(f.run(mismatch.ensure(true))).rejects.toMatchObject({ code: "action_required" });
  expect(Object.keys(artifacts)).toHaveLength(5);
});

test("invalid or conflicting enable requests preserve a working remote configuration", async ({
  f,
}) => {
  await f.run(f.remote.enable({ hostname }));
  f.connector.ready = true;
  await f.run(f.remote.tick());
  const mutations = [...f.cloud.mutations];
  await expect(
    f.run(f.remote.enable({ hostname: "different.example.test" })),
  ).rejects.toMatchObject({ code: "action_required" });
  await expect(f.run(f.remote.enable({ hostname: "invalid/hostname" }))).rejects.toMatchObject({
    code: "validation_error",
  });
  await f.run(f.remote.tick());
  expect((await f.run(f.remote.status())).state).toBe("connected");
  expect(f.connector.running).toBe(true);
  expect(f.cloud.mutations).toEqual(mutations);
});
