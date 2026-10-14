import { useMemo, useSyncExternalStore } from "react";

export type ApprovalSelection = {
  kind: "draft" | "credential-use" | "credential-request";
  id: string;
};

export type Route =
  | { name: "setup" }
  | { name: "login" }
  | { name: "locked" }
  | {
      name: "inbox";
      inboxId: string | undefined;
      threadId: string | undefined;
    }
  | { name: "approvals"; selection: ApprovalSelection | undefined }
  | { name: "vault"; inboxId: string | undefined; credentialId: string | undefined }
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
  credentialUse: (id: string) => `#/approvals/credential-use/${encodeURIComponent(id)}`,
  credentialRequest: (id: string) => `#/approvals/credential-request/${encodeURIComponent(id)}`,
  vault: (inboxId?: string, credentialId?: string) =>
    inboxId && credentialId
      ? `#/vault/${encodeURIComponent(inboxId)}/${encodeURIComponent(credentialId)}`
      : "#/vault",
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
      if (first === "credential-use" || first === "credential-request")
        return {
          name: "approvals",
          selection: second ? { kind: first, id: second } : undefined,
        };
      return { name: "approvals", selection: first ? { kind: "draft", id: first } : undefined };
    case "vault":
      return { name: "vault", inboxId: first || undefined, credentialId: second || undefined };
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
