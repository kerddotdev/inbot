import type { OwnerStatus } from "@inbot/contracts/src/owner.js";
import { defaultRoute, links, type Route } from "./router";

export function authRedirect(
  status: typeof OwnerStatus.Type,
  route: Route | undefined,
): string | undefined {
  if (status.locked) return route?.name === "locked" ? undefined : links.locked;
  if (!status.authenticated) {
    const name = status.setup_required ? "setup" : "login";
    return route?.name === name ? undefined : links[name];
  }
  if (!route || route.name === "login" || route.name === "setup" || route.name === "locked")
    return defaultRoute;
  return undefined;
}
