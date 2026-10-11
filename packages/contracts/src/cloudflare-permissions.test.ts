import { expect, test } from "vitest";
import { cloudflareTokenUrl } from "./cloudflare-permissions.js";

test("dashboard template encodes all nine documented or dashboard-verified permissions", () => {
  const url = new URL(cloudflareTokenUrl);
  expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/profile/api-tokens");
  expect(url.searchParams.get("accountId")).toBe("*");
  expect(url.searchParams.get("zoneId")).toBe("all");
  expect(url.searchParams.get("name")).toBe("Inbot");
  expect(JSON.parse(url.searchParams.get("permissionGroupKeys") ?? "null")).toEqual([
    { key: "zone", type: "read" },
    { key: "dns", type: "edit" },
    { key: "zone_settings", type: "edit" },
    { key: "email_routing_rule", type: "edit" },
    { key: "email_sending", type: "edit" },
    { key: "workers_scripts", type: "edit" },
    { key: "workers_r2", type: "edit" },
    { key: "queues", type: "edit" },
    { key: "argotunnel", type: "edit" },
  ]);
});
