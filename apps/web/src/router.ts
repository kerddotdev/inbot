import { useMemo, useSyncExternalStore } from "react";

export type Route =
  | { name: "setup" }
  | { name: "login" }
  | { name: "locked" }
  | {
      name: "inbox";
      inboxId: string | undefined;
      threadId: string | undefined;
    }
  | { name: "approvals"; draftId: string | undefined }
  | { name: "domains" }
  | { name: "keys" }
  | { name: "remote" }
  | { name: "settings" };

export const links = {
  setup: "#/setup",
  login: "#/login",
  locked: "#/locked",
  inbox: (inboxId?: string, threadId?: string) =>
    inboxId
      ? `#/inbox/${encodeURIComponent(inboxId)}${threadId ? `/${encodeURIComponent(threadId)}` : ""}`
      : "#/inbox",
  approvals: (draftId?: string) =>
    draftId ? `#/approvals/${encodeURIComponent(draftId)}` : "#/approvals",
  domains: "#/domains",
  keys: "#/keys",
  remote: "#/remote",
  settings: "#/settings",
} as const;

export const defaultRoute = links.inbox();

export function parseRoute(hash: string): Route | undefined {
  const [path = ""] = hash.replace(/^#\/?/, "").split("?");
  let parts: string[];
  try {
    parts = path.split("/").map(decodeURIComponent);
  } catch {
    return undefined;
  }
  const [head, first, second] = parts;
  switch (head) {
    case "setup":
    case "login":
    case "locked":
    case "domains":
    case "keys":
    case "remote":
    case "settings":
      return { name: head };
    case "inbox":
      return { name: "inbox", inboxId: first || undefined, threadId: second };
    case "approvals":
      return { name: "approvals", draftId: first };
    default:
      return undefined;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

const getHash = () => window.location.hash;

export function useRoute(): Route | undefined {
  const hash = useSyncExternalStore(subscribe, getHash);
  return useMemo(() => parseRoute(hash), [hash]);
}

export function navigate(href: string) {
  window.location.hash = href;
}
