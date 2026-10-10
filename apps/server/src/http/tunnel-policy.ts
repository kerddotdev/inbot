import { Context } from "effect";
import { decodeWebPath } from "./static.js";

export const TunnelTraffic = Context.Reference<boolean>("inbot/TunnelTraffic", {
  defaultValue: () => false,
});

export type TunnelRoute = "agent" | "auth" | "web" | "blocked";
export function tunnelPath(url: string): string {
  const raw = url.split("?")[0] ?? "";
  const decoded = decodeWebPath(url);
  if (decoded.includes("//") || /[;#]/.test(decoded)) throw new Error("Invalid tunnel path");
  // FindMyWay preserves encoded URI separators and ignores one trailing slash.
  return decodeURI(raw.replace(/%25/gi, "%2525")).replace(/\/$/, "") || "/";
}
export function tunnelRoute(url: string): TunnelRoute {
  const path = tunnelPath(url);
  if (path === "/mcp") return "agent";
  if (path === "/v0/ws") return "agent";
  if (path.startsWith("/mcp/")) return "blocked";
  if (["/oauth", "/.well-known"].some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))
    return "agent";
  if (
    [
      "/v0/owner/status",
      "/v0/owner/login",
      "/v0/owner/logout",
      "/v0/owner/password",
      "/v0/owner/sessions",
    ].includes(path) ||
    /^\/v0\/owner\/sessions\/[^/]+$/.test(path)
  )
    return "auth";
  if (path === "/v0" || path.startsWith("/v0/")) {
    if (/^\/v0\/(owner|domains|api-keys)(\/|$)/.test(path) || /\/api-keys(\/|$)/.test(path))
      return "blocked";
    if (/^\/v0\/inboxes\/[^/]+\/messages\/[^/]+\/resolve$/.test(path)) return "blocked";
    return "agent";
  }
  if (
    path === "/" ||
    path === "/login" ||
    path === "/favicon.svg" ||
    path === "/favicon.ico" ||
    path.startsWith("/assets/")
  )
    return "auth";
  return "web";
}
