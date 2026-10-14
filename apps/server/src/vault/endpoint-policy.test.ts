import { expect, test, vi } from "vitest";
import { checkCdpEndpoint } from "./endpoint-policy.js";

const settings = { remote_cdp_hosts: ["browser.test", "*.browserbase.com"] };
const publicDns = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);

test("permits local CDP without consulting hosts, schemes or DNS", async () => {
  const resolve = vi.fn(async () => {
    throw new Error("DNS must not run");
  });
  for (const endpoint of ["http://127.0.0.1:9222", "ws://[::1]:9222/page", "https://private.test"])
    await expect(
      checkCdpEndpoint(endpoint, false, { remote_cdp_hosts: [] }, resolve),
    ).resolves.toBeUndefined();
  expect(resolve).not.toHaveBeenCalled();
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
      { remote_cdp_hosts: ["browserbase.com"] },
      publicDns,
    ),
  ).resolves.toBeUndefined();
});

test("disables remote use by default and rejects empty or failed DNS without leaking details", async () => {
  const resolve = vi.fn(async () => []);
  await expect(
    checkCdpEndpoint("wss://browser.test", true, { remote_cdp_hosts: [] }, resolve),
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
