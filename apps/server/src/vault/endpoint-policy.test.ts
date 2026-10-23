import { expect, test, vi } from "vitest";
import { checkCdpEndpoint } from "./endpoint-policy.js";

const settings = { cdp_endpoints: [], remote_cdp_hosts: ["browser.test", "*.browserbase.com"] };
const publicDns = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);

test("denies unregistered local endpoints before DNS and never echoes endpoint credentials", async () => {
  const resolve = vi.fn(async () => {
    throw new Error("DNS must not run");
  });
  for (const endpoint of [
    "http://127.0.0.1:9222",
    "ws://[::1]:9222/page",
    "https://user:password@private.test/connect?token=private-token",
  ])
    await expect(
      checkCdpEndpoint(endpoint, false, { remote_cdp_hosts: [], cdp_endpoints: [] }, resolve),
    ).rejects.toMatchObject({
      code: "missing_permission",
      fix: expect.stringContaining("Trusted browsers"),
    });
  expect(resolve).not.toHaveBeenCalled();
});

test("matches owner browser hostname, effective port and transport while ignoring endpoint tokens", async () => {
  const resolve = vi.fn(async () => {
    throw new Error("DNS must not run");
  });
  for (const [trusted, endpoint] of [
    ["http://127.0.0.1:9222", "ws://127.0.0.1:9222/devtools/browser/test"],
    ["ws://localhost", "http://localhost:80"],
    ["https://browser.test", "wss://user:password@browser.test:443/connect?token=secret"],
    ["wss://[::1]:9443", "https://[::1]:9443"],
  ]) {
    if (trusted === undefined || endpoint === undefined) throw new Error("Missing test endpoint");
    await expect(
      checkCdpEndpoint(
        endpoint,
        false,
        { remote_cdp_hosts: [], cdp_endpoints: [trusted] },
        resolve,
      ),
    ).resolves.toBeUndefined();
  }
  for (const endpoint of [
    "https://localhost:9222",
    "ws://localhost:9223",
    "ws://127.0.0.1:9222",
    "ftp://localhost:9222",
    "invalid",
  ])
    await expect(
      checkCdpEndpoint(
        endpoint,
        false,
        { remote_cdp_hosts: [], cdp_endpoints: ["http://localhost:9222"] },
        resolve,
      ),
    ).rejects.toMatchObject({ code: "missing_permission" });
  expect(resolve).not.toHaveBeenCalled();
});

test("local requests may use remote rules but tunnel requests ignore trusted browser origins", async () => {
  await expect(
    checkCdpEndpoint("wss://browser.test/connect?token=secret", false, settings, publicDns),
  ).resolves.toBeUndefined();
  await expect(
    checkCdpEndpoint(
      "http://127.0.0.1:9222",
      true,
      { ...settings, cdp_endpoints: ["http://127.0.0.1:9222"] },
      publicDns,
    ),
  ).rejects.toMatchObject({ code: "missing_permission" });
  await expect(
    checkCdpEndpoint(
      "wss://browser.test",
      true,
      { remote_cdp_hosts: [], cdp_endpoints: ["wss://browser.test"] },
      publicDns,
    ),
  ).rejects.toMatchObject({ code: "missing_permission" });
});

test("matches exact hosts and wildcard subdomains with TLS and no suffix tricks", async () => {
  for (const endpoint of [
    "https://browser.test:9443",
    "wss://a.browserbase.com/connect",
    "wss://a.b.browserbase.com",
  ])
    await expect(checkCdpEndpoint(endpoint, true, settings, publicDns)).resolves.toBeUndefined();
  for (const endpoint of [
    "wss://browserbase.com",
    "wss://evilbrowserbase.com",
    "wss://browser.test.evil.com",
    "https://browser.test.",
    "http://browser.test",
    "ws://a.browserbase.com",
    "wss://127.0.0.1",
  ])
    await expect(checkCdpEndpoint(endpoint, true, settings, publicDns)).rejects.toMatchObject({
      code: "missing_permission",
      fix: expect.any(String),
    });
  await expect(
    checkCdpEndpoint(
      "wss://browserbase.com",
      true,
      { remote_cdp_hosts: ["browserbase.com"], cdp_endpoints: [] },
      publicDns,
    ),
  ).resolves.toBeUndefined();
});

test("disables remote use by default and rejects empty or failed DNS without leaking details", async () => {
  const resolve = vi.fn(async () => []);
  await expect(
    checkCdpEndpoint(
      "wss://browser.test",
      true,
      { remote_cdp_hosts: [], cdp_endpoints: [] },
      resolve,
    ),
  ).rejects.toMatchObject({
    code: "missing_permission",
    message: "Remote credential fill and capture are disabled.",
    fix: expect.stringContaining("Settings"),
  });
  expect(resolve).not.toHaveBeenCalled();
  await expect(
    checkCdpEndpoint("wss://browser.test", true, settings, resolve),
  ).rejects.toMatchObject({ code: "missing_permission" });
  await expect(
    checkCdpEndpoint("wss://browser.test", true, settings, async () => {
      throw new Error("sensitive-dns-details");
    }),
  ).rejects.toMatchObject({
    code: "service_unavailable",
    message: "The CDP hostname could not be resolved.",
  });
});

test.for([
  "127.0.0.1",
  "127.9.8.7",
  "10.0.0.1",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.0.1",
  "169.254.169.254",
  "100.64.0.1",
  "100.127.255.255",
  "0.0.0.0",
  "0.1.2.3",
  "224.0.0.1",
  "255.255.255.255",
  "::",
  "::1",
  "fe80::1",
  "febf::1",
  "fc00::1",
  "fdff::1",
  "ff02::1",
  "fec0::1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "::ffff:10.0.0.1",
  "::ffff:ac10:1",
  "::ffff:c0a8:1",
  "::ffff:a9fe:1",
  "::ffff:6440:1",
  "::ffff:0:1",
  "::ffff:e000:1",
  "192.88.99.1",
  "2001:10::1",
  "2001:20::1",
  "3fff::1",
  "not-an-address",
])("rejects non-public DNS address %s even among public answers", async (address) => {
  for (const addresses of [[address], ["8.8.8.8", address]])
    await expect(
      checkCdpEndpoint("wss://browser.test", true, settings, async () =>
        addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
      ),
    ).rejects.toMatchObject({ code: "missing_permission" });
});

test.for([
  "8.8.8.8",
  "172.15.255.255",
  "172.32.0.1",
  "100.63.255.255",
  "100.128.0.1",
  "2606:4700:4700::1111",
  "::ffff:808:808",
])("accepts public DNS address %s", async (address) => {
  await expect(
    checkCdpEndpoint("wss://browser.test", true, settings, async () => [
      { address, family: address.includes(":") ? 6 : 4 },
    ]),
  ).resolves.toBeUndefined();
});
