interface TokenPermission {
  readonly name: string;
  readonly scope: "Zone" | "Account";
  readonly level: "read" | "edit";
  readonly why: string;
  readonly key: string;
  readonly apiPermission: string;
}

export const cloudflareTunnelPermission = {
  name: "Cloudflare Tunnel",
  scope: "Account",
  level: "edit",
  why: "Create, configure and delete the optional remote access tunnel and obtain its connector token.",
  key: "argotunnel",
  apiPermission: "Cloudflare Tunnel Write",
} as const satisfies TokenPermission;

// Documented keys: https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
// Email Routing Rules, Email Sending and Cloudflare Tunnel keys were owner-verified
// against the live dashboard on 2026-10-11; they are absent from that reference.
export const cloudflareTokenPermissions = [
  {
    name: "Zone",
    scope: "Zone",
    level: "read",
    why: "Find the mail domain's zone in the configured account.",
    key: "zone",
    apiPermission: "Zone Zone Read",
  },
  {
    name: "DNS",
    scope: "Zone",
    level: "edit",
    why: "Snapshot and manage mail DNS records and the remote access hostname.",
    key: "dns",
    apiPermission: "DNS Write",
  },
  {
    name: "Zone Settings",
    scope: "Zone",
    level: "edit",
    why: "Inspect, enable and unlock Email Routing DNS for the mail subdomain.",
    key: "zone_settings",
    apiPermission: "Zone Settings Write",
  },
  {
    name: "Email Routing Rules",
    scope: "Zone",
    level: "edit",
    why: "Route each inbox and the verification address to the encrypted inbound Worker.",
    key: "email_routing_rule",
    apiPermission: "Email Routing Rules Write",
  },
  {
    name: "Email Sending",
    scope: "Account",
    level: "edit",
    why: "Manage sending subdomains, inspect their DNS and send outbound mail and verification probes.",
    key: "email_sending",
    apiPermission: "Email Sending: Edit",
  },
  {
    name: "Workers Scripts",
    scope: "Account",
    level: "edit",
    why: "Upload and manage the Worker that encrypts inbound mail.",
    key: "workers_scripts",
    apiPermission: "Workers Scripts Write",
  },
  {
    name: "Workers R2 Storage",
    scope: "Account",
    level: "edit",
    why: "Manage the ciphertext buffer bucket and read and delete encrypted mail objects.",
    key: "workers_r2",
    apiPermission: "Workers R2 Storage Write",
  },
  {
    name: "Queues",
    scope: "Account",
    level: "edit",
    why: "Manage inbound pointers and delivery event queues, consumers and subscriptions.",
    key: "queues",
    apiPermission: "Queues Write",
  },
  cloudflareTunnelPermission,
] as const satisfies readonly TokenPermission[];

export const cloudflareTokenUrl =
  "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=" +
  encodeURIComponent(
    JSON.stringify(
      cloudflareTokenPermissions.map((permission) => ({
        key: permission.key,
        type: permission.level,
      })),
    ),
  ) +
  "&accountId=*&zoneId=all&name=" +
  encodeURIComponent("Inbot");
