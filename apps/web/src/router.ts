import { useMemo, useSyncExternalStore } from "react";

export type ViewState = "ready" | "loading" | "empty" | "error";

export type Route =
  | { name: "setup" }
  | { name: "login" }
  | { name: "locked" }
  | { name: "inbox"; inboxId: string; threadId: string | undefined; state: ViewState | undefined }
  | { name: "approvals"; draftId: string | undefined; state: ViewState | undefined }
  | { name: "domains" }
  | { name: "keys" }
  | { name: "remote" }
  | { name: "settings" };

export const links = {
  setup: "#/setup",
  login: "#/login",
  locked: "#/locked",
  inbox: (inboxId: string, threadId?: string) =>
    threadId ? `#/inbox/${inboxId}/${threadId}` : `#/inbox/${inboxId}`,
  approvals: (draftId?: string) => (draftId ? `#/approvals/${draftId}` : "#/approvals"),
  domains: "#/domains",
  keys: "#/keys",
  remote: "#/remote",
  settings: "#/settings",
} as const;

export const defaultRoute = links.inbox("billing-bot", "northwind-invoice");

function readViewState(query: URLSearchParams): ViewState | undefined {
  const value = query.get("state");
  if (value === "ready" || value === "loading" || value === "empty" || value === "error") {
    return value;
  }
  return undefined;
}

export function parseRoute(hash: string): Route | undefined {
  const [path = "", search = ""] = hash.replace(/^#\/?/, "").split("?");
  const [head, first, second] = path.split("/");
  const state = readViewState(new URLSearchParams(search));
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
      return first ? { name: "inbox", inboxId: first, threadId: second, state } : undefined;
    case "approvals":
      return { name: "approvals", draftId: first, state };
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
