import { Schema } from "effect";
import * as Owner from "@inbot/contracts/src/owner.js";
import * as Inboxes from "@inbot/contracts/src/inboxes.js";
import * as Threads from "@inbot/contracts/src/threads.js";
import * as Messages from "@inbot/contracts/src/messages.js";
import * as Keys from "@inbot/contracts/src/api-keys.js";
import * as Drafts from "@inbot/contracts/src/drafts.js";
import * as Webhooks from "@inbot/contracts/src/webhooks.js";
import * as Domains from "@inbot/contracts/src/domains.js";
import * as Lists from "@inbot/contracts/src/lists.js";
import { ErrorResponse, type ErrorCode } from "@inbot/contracts/src/errors.js";

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fix: string | undefined,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return [error.message, error.fix].filter(Boolean).join(" ");
  return "The service could not be reached. Check that Inbot is running and try again.";
}

const segment = encodeURIComponent;
const inboxPath = (id: string) => `/v0/inboxes/${segment(id)}`;
export type ListSelection = { inboxId?: string; direction: Lists.Direction; type: Lists.ListType };
const listPath = ({ inboxId, direction, type }: ListSelection) =>
  `${inboxId === undefined ? "/v0" : inboxPath(inboxId)}/lists/${segment(direction)}/${segment(type)}`;
const threadPath = (inboxId: string, id: string) => `${inboxPath(inboxId)}/threads/${segment(id)}`;
const draftPath = (draft: Pick<Drafts.DraftItem, "inbox_id" | "draft_id">) =>
  `${inboxPath(draft.inbox_id)}/drafts/${segment(draft.draft_id)}`;

function pageQuery(pageToken: string | null) {
  const query = new URLSearchParams({ limit: "50" });
  if (pageToken) query.set("page_token", pageToken);
  return `?${query}`;
}

async function allPages<T, P extends { next_page_token?: string }>(
  load: (token: string | null) => Promise<P>,
  items: (page: P) => readonly T[],
): Promise<readonly T[]> {
  const result: T[] = [];
  let token: string | null = null;
  do {
    const page = await load(token);
    result.push(...items(page));
    token = page.next_page_token ?? null;
  } while (token !== null);
  return result;
}

export class ApiClient {
  private csrfToken: string | undefined;
  private sessionListeners = new Set<(code: "unauthorized" | "locked") => void>();

  constructor(private readonly fetcher: typeof fetch = (...args) => fetch(...args)) {}

  subscribeSession(listener: (code: "unauthorized" | "locked") => void) {
    this.sessionListeners.add(listener);
    return () => {
      this.sessionListeners.delete(listener);
    };
  }

  private async request<S extends Schema.Top & { readonly DecodingServices: never }>(
    path: string,
    schema: S,
    options: {
      method?: string;
      body?: unknown;
      idempotencyKey?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<S["Type"]> {
    const method = options.method ?? "GET";
    const headers = new Headers({ Accept: "application/json" });
    if (method !== "GET" && this.csrfToken) headers.set("X-Inbot-CSRF", this.csrfToken);
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
    const response = await this.fetcher(path, {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      throw new ApiError(
        "service_unavailable",
        "The service returned an invalid response.",
        "Retry the request.",
      );
    }
    if (!response.ok) {
      this.throwResponseError(path, body);
    }
    try {
      const value = Schema.decodeUnknownSync(schema)(body);
      if (path === "/v0/owner/status")
        this.csrfToken = response.headers.get("X-Inbot-CSRF") ?? undefined;
      return value;
    } catch {
      throw new ApiError(
        "service_unavailable",
        "The service response does not match the API contract.",
        "Update the UI and service together, then retry.",
      );
    }
  }

  private throwResponseError(path: string, body: unknown): never {
    let wire: ErrorResponse;
    try {
      wire = Schema.decodeUnknownSync(ErrorResponse)(body);
    } catch {
      throw new ApiError(
        "service_unavailable",
        "The service returned an invalid error response.",
        "Retry the request.",
      );
    }
    const publicAuth = /\/owner\/(status|setup|login|login-links\/redeem)$/.test(path);
    if (!publicAuth && (wire.code === "unauthorized" || wire.code === "locked")) {
      this.csrfToken = undefined;
      for (const listener of this.sessionListeners) listener(wire.code);
    }
    throw new ApiError(wire.code, wire.message, wire.fix);
  }

  async eventsSocket(origin: string, lastEventId?: string) {
    const status = await this.status();
    if (!status.authenticated || status.locked || !this.csrfToken)
      throw new ApiError(
        status.locked ? "locked" : "unauthorized",
        "The owner session is unavailable.",
        "Sign in again.",
      );
    const url = new URL("/v0/ws", origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (lastEventId) url.searchParams.set("last_event_id", lastEventId);
    return new WebSocket(url, ["inbot.events", `csrf.${this.csrfToken}`]);
  }

  webhooks = (signal: AbortSignal) =>
    allPages(
      (token) =>
        this.request(`/v0/webhooks${pageQuery(token)}`, Webhooks.ListWebhooksResponse, { signal }),
      (page) => page.webhooks,
    );

  createWebhook = (body: Webhooks.CreateWebhookRequest) =>
    this.request("/v0/webhooks", Webhooks.Webhook, { method: "POST", body });

  updateWebhook = (id: string, body: Webhooks.UpdateWebhookRequest) =>
    this.request(`/v0/webhooks/${segment(id)}`, Webhooks.Webhook, { method: "PATCH", body });

  deleteWebhook = (id: string) =>
    this.request(`/v0/webhooks/${segment(id)}`, Schema.Undefined, { method: "DELETE" });

  status = (signal?: AbortSignal) =>
    this.request("/v0/owner/status", Owner.OwnerStatus, signal ? { signal } : {});

  transport = (signal: AbortSignal) =>
    this.request("/v0/owner/transport", Owner.OwnerTransportStatus, { signal });

  configureTransport = (body: Owner.OwnerTransportRequest) =>
    this.request("/v0/owner/transport", Owner.OwnerTransportStatus, { method: "PUT", body });

  clearTransport = () =>
    this.request("/v0/owner/transport", Schema.Undefined, { method: "DELETE" });

  async authenticate(
    request: typeof Owner.OwnerSetupRequest.Type | typeof Owner.OwnerLoginRequest.Type,
  ) {
    const session = await this.request(
      "code" in request ? "/v0/owner/setup" : "/v0/owner/login",
      Owner.OwnerSessionResponse,
      { method: "POST", body: request },
    );
    this.csrfToken = session.csrf_token;
  }

  async redeem(token: string) {
    const session = await this.request("/v0/owner/login-links/redeem", Owner.OwnerSessionResponse, {
      method: "POST",
      body: { token },
    });
    this.csrfToken = session.csrf_token;
  }

  async logout() {
    await this.request("/v0/owner/logout", Schema.Undefined, { method: "POST" });
    this.csrfToken = undefined;
  }

  inboxes = (signal: AbortSignal) =>
    allPages(
      (token) =>
        this.request(`/v0/inboxes${pageQuery(token)}`, Inboxes.ListInboxesResponse, { signal }),
      (page) => page.inboxes,
    );

  listEntries = (selection: ListSelection, token: string | null, signal: AbortSignal) =>
    this.request(
      `${listPath(selection)}${pageQuery(token)}`,
      selection.inboxId === undefined
        ? Lists.ListListEntriesResponse
        : Lists.PodListListEntriesResponse,
      { signal },
    );

  createListEntry = (selection: ListSelection, body: Lists.CreateListEntryRequest) =>
    this.request(
      listPath(selection),
      selection.inboxId === undefined ? Lists.ListEntry : Lists.PodListEntry,
      { method: "POST", body },
    );

  deleteListEntry = (selection: ListSelection, entry: string) =>
    this.request(`${listPath(selection)}/${segment(entry)}`, Schema.Undefined, {
      method: "DELETE",
    });

  threads = (inboxId: string, token: string | null, signal: AbortSignal) =>
    this.request(`${inboxPath(inboxId)}/threads${pageQuery(token)}`, Threads.ListThreadsResponse, {
      signal,
    });

  thread = (inboxId: string, id: string, token: string | null, signal: AbortSignal) =>
    this.request(`${threadPath(inboxId, id)}${pageQuery(token)}`, Threads.Thread, { signal });

  updateThread = (inboxId: string, id: string, body: Threads.UpdateThreadRequest) =>
    this.request(threadPath(inboxId, id), Threads.UpdateThreadResponse, { method: "PATCH", body });

  send = (inboxId: string, body: Messages.SendMessageRequest, idempotencyKey: string) =>
    this.request(`${inboxPath(inboxId)}/messages/send`, Messages.SendMessageResponse, {
      method: "POST",
      body,
      idempotencyKey,
    });

  reply = (
    inboxId: string,
    id: string,
    body: Messages.ReplyToMessageRequest,
    idempotencyKey: string,
  ) =>
    this.request(
      `${inboxPath(inboxId)}/messages/${segment(id)}/reply`,
      Messages.SendMessageResponse,
      { method: "POST", body, idempotencyKey },
    );

  keys = (signal: AbortSignal) =>
    allPages(
      (token) =>
        this.request(`/v0/api-keys${pageQuery(token)}`, Keys.ListApiKeysResponse, { signal }),
      (page) => page.api_keys,
    );

  createKey = (body: Keys.CreateApiKeyRequest) =>
    this.request("/v0/api-keys", Keys.CreateApiKeyResponse, { method: "POST", body });

  revokeKey = (id: string) =>
    this.request(`/v0/api-keys/${segment(id)}`, Schema.Undefined, { method: "DELETE" });

  domains = (signal: AbortSignal) =>
    allPages(
      (token) =>
        this.request(`/v0/domains${pageQuery(token)}`, Domains.ListDomainsResponse, { signal }),
      (page) => page.domains,
    );

  domain = (id: string, signal?: AbortSignal) =>
    this.request(`/v0/domains/${segment(id)}`, Domains.Domain, signal ? { signal } : {});

  domainPlan = (id: string) =>
    this.request(`/v0/domains/${segment(id)}/plan`, Domains.ProvisionPlan);

  createDomain = (body: Domains.CreateDomainRequest) =>
    this.request("/v0/domains", Domains.Domain, { method: "POST", body });

  updateDomain = (id: string, body: Domains.UpdateDomainRequest) =>
    this.request(`/v0/domains/${segment(id)}`, Domains.Domain, { method: "PATCH", body });

  applyDomain = (id: string) =>
    this.request(`/v0/domains/${segment(id)}/apply`, Domains.Domain, { method: "POST" });

  async verifyDomain(id: string) {
    await this.request(`/v0/domains/${segment(id)}/verify`, Schema.Undefined, { method: "POST" });
    return this.domain(id);
  }

  teardownDomain = (id: string) =>
    this.request(`/v0/domains/${segment(id)}/teardown`, Domains.Domain, { method: "POST" });

  deleteDomain = (id: string) =>
    this.request(`/v0/domains/${segment(id)}`, Schema.Undefined, { method: "DELETE" });

  async domainZoneFile(id: string) {
    const path = `/v0/domains/${segment(id)}/zone-file`;
    const response = await this.fetcher(path, {
      method: "GET",
      headers: { Accept: "text/plain" },
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ApiError(
          "service_unavailable",
          "The service returned an invalid error response.",
          "Retry the request.",
        );
      }
      this.throwResponseError(path, body);
    }
    if (!response.headers.get("Content-Type")?.startsWith("text/plain"))
      throw new ApiError(
        "service_unavailable",
        "The service did not return a zone file.",
        "Update the UI and service together, then retry.",
      );
    return response.blob();
  }

  pendingDrafts = async (signal: AbortSignal) => {
    const drafts = await allPages(
      (token) =>
        this.request(`/v0/drafts${pageQuery(token)}`, Drafts.ListDraftsResponse, { signal }),
      (page) => page.drafts,
    );
    return drafts.filter((draft) => draft.pending_approval === true);
  };

  draft = (id: string, signal: AbortSignal) =>
    this.request(`/v0/drafts/${segment(id)}`, Drafts.Draft, { signal });

  approve = (draft: Drafts.DraftItem, idempotencyKey: string) =>
    this.request(
      `${draftPath(draft)}/approve`,
      Schema.Union([Messages.SendMessageResponse, Drafts.Draft]),
      { method: "POST", idempotencyKey },
    );

  reject = (draft: Drafts.DraftItem, reason: string) =>
    this.request(`${draftPath(draft)}/reject`, Drafts.Draft, {
      method: "POST",
      body: reason ? { reason } : {},
    });
}

export const api = new ApiClient();
