import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { VaultSettings } from "../../../../packages/contracts/src/vault.js";
import { wireError } from "../http/errors.js";

export type CdpResolver = (
  hostname: string,
) => Promise<readonly { readonly address: string; readonly family: number }[]>;

const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["192.88.99.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] satisfies [string, number][])
  privateAddresses.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] satisfies [string, number][])
  privateAddresses.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const mappedV4 = new BlockList();
mappedV4.addSubnet("::ffff:0:0", 96, "ipv6");

function publicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !privateAddresses.check(address, "ipv4");
  return (
    family === 6 &&
    (globalV6.check(address, "ipv6") || mappedV4.check(address, "ipv6")) &&
    !privateAddresses.check(address, "ipv6")
  );
}

function denied(message: string) {
  return wireError(
    "missing_permission",
    message,
    "Ask the owner to add public CDP hosts in Settings, then use an HTTPS or WSS endpoint on an allowed host.",
  );
}

export async function checkCdpEndpoint(
  endpoint: string,
  tunnel: boolean,
  settings: VaultSettings,
  resolve: CdpResolver = (hostname) => lookup(hostname, { all: true }),
): Promise<void> {
  if (!tunnel) return;
  if (settings.remote_cdp_hosts.length === 0)
    throw denied("Remote credential fill and capture are disabled.");
  const url = new URL(endpoint);
  const hostname = url.hostname;
  if (
    !["https:", "wss:"].includes(url.protocol) ||
    !settings.remote_cdp_hosts.some((host) =>
      host.startsWith("*.") ? hostname.endsWith(host.slice(1)) : hostname === host,
    )
  )
    throw denied("The remote CDP endpoint is not allowed.");
  let addresses: Awaited<ReturnType<CdpResolver>>;
  try {
    addresses = await resolve(hostname);
  } catch {
    throw wireError(
      "service_unavailable",
      "The CDP hostname could not be resolved.",
      "Check the CDP hostname and the server's DNS connection, then retry.",
    );
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !publicAddress(address)))
    throw denied("The remote CDP endpoint must resolve only to public addresses.");
}
