export const DOMAIN = "agents.kerd.dev";

export type RecordStatus = "valid" | "missing" | "invalid";

export interface DnsRecord {
  id: string;
  status: RecordStatus;
  type: "MX" | "TXT";
  name: string;
  value: string;
  note?: string;
}

export const dnsRecords: DnsRecord[] = [
  { id: "mx1", status: "valid", type: "MX", name: DOMAIN, value: "10 route1.mx.cloudflare.net" },
  { id: "mx2", status: "valid", type: "MX", name: DOMAIN, value: "20 route2.mx.cloudflare.net" },
  { id: "mx3", status: "missing", type: "MX", name: DOMAIN, value: "30 route3.mx.cloudflare.net" },
  {
    id: "spf",
    status: "valid",
    type: "TXT",
    name: DOMAIN,
    value: "v=spf1 include:_spf.mx.cloudflare.net ~all",
  },
  {
    id: "dkim",
    status: "invalid",
    type: "TXT",
    name: `cf2024-1._domainkey.${DOMAIN}`,
    value: "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...",
    note: "Published value does not match the expected key.",
  },
  {
    id: "bounce-mx",
    status: "valid",
    type: "MX",
    name: `cf-bounce.${DOMAIN}`,
    value: "10 route1.mx.cloudflare.net",
  },
  {
    id: "bounce-spf",
    status: "valid",
    type: "TXT",
    name: `cf-bounce.${DOMAIN}`,
    value: "v=spf1 include:_spf.mx.cloudflare.net ~all",
  },
  {
    id: "dmarc",
    status: "missing",
    type: "TXT",
    name: `_dmarc.${DOMAIN}`,
    value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${DOMAIN}`,
  },
];

export interface RemoteAccess {
  enabled: boolean;
  tunnelUrl: string;
  connector: { state: "connected"; version: string; since: string };
  routes: string[];
}

export const remoteAccess: RemoteAccess = {
  enabled: true,
  tunnelUrl: "https://mail.kerd.dev",
  connector: { state: "connected", version: "cloudflared 2026.9.1", since: "08:12" },
  routes: ["/v0", "/mcp"],
};
