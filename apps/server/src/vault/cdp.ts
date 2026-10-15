export class CdpError extends Error {
  constructor(
    readonly code:
      | "cdp_unreachable"
      | "target_not_found"
      | "origin_not_allowed"
      | "element_not_found"
      | "element_not_editable"
      | "cdp_timeout"
      | "cdp_protocol",
    message: string,
  ) {
    super(message);
    this.name = "CdpError";
  }
}

export interface CdpTarget {
  readonly endpoint: string;
  readonly url?: string;
  readonly target_id?: string;
  readonly checkEndpoint?: (endpoint: string) => Promise<void>;
}
export interface FillInput extends CdpTarget {
  readonly selector: string;
  readonly value: string;
  readonly allowedOrigins: readonly string[];
  readonly timeoutMs?: number;
}
export interface ReadInput extends CdpTarget {
  readonly selector: string;
  readonly allowedOrigins: readonly string[];
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new CdpError("cdp_protocol", "Invalid CDP response");
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new CdpError("cdp_protocol", "Invalid CDP string");
  return value;
}

function endpointUrl(endpoint: string): URL {
  try {
    const url = new URL(endpoint);
    if (["ws:", "wss:", "http:", "https:"].includes(url.protocol)) return url;
  } catch {}
  throw new CdpError("cdp_unreachable", "Expected an HTTP or WebSocket CDP endpoint");
}

async function resolveSocket(
  endpoint: string,
  signal: AbortSignal,
  checkEndpoint?: CdpTarget["checkEndpoint"],
): Promise<string> {
  await checkEndpoint?.(endpoint);
  const url = endpointUrl(endpoint);
  if (url.protocol === "ws:" || url.protocol === "wss:") return endpoint;
  url.pathname = `${url.pathname.replace(/\/$/, "")}/json/version`;
  let socket: string;
  try {
    const response = await fetch(url, { signal, redirect: "error" });
    if (!response.ok) throw new Error();
    const body: unknown = await response.json();
    socket = string(record(body).webSocketDebuggerUrl);
    if (!["ws:", "wss:"].includes(endpointUrl(socket).protocol)) throw new Error();
  } catch {
    throw new CdpError(
      signal.aborted ? "cdp_timeout" : "cdp_unreachable",
      signal.aborted ? "CDP operation timed out" : `Cannot resolve CDP at ${url.host}`,
    );
  }
  await checkEndpoint?.(socket);
  return socket;
}

export function resolveBrowserSocket(endpoint: string, timeoutMs = 10_000): Promise<string> {
  return resolveSocket(endpoint, AbortSignal.timeout(timeoutMs));
}

class Client {
  private readonly socket: WebSocket;
  private id = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: CdpError) => void }
  >();
  private failure: CdpError | undefined;
  readonly ready: Promise<void>;
  sessionId: string | undefined;

  constructor(
    endpoint: string,
    private readonly signal: AbortSignal,
  ) {
    this.socket = new WebSocket(endpoint);
    this.ready = new Promise((resolve, reject) => {
      const fail = (error: CdpError) => {
        this.failure ??= error;
        reject(error);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
      };
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("close", () =>
        fail(new CdpError("cdp_unreachable", "CDP socket closed")),
      );
      this.socket.addEventListener("error", () =>
        fail(new CdpError("cdp_unreachable", "CDP socket failed")),
      );
      this.socket.addEventListener("message", (event) => {
        try {
          if (typeof event.data !== "string") throw new Error();
          const parsed: unknown = JSON.parse(event.data);
          const message = record(parsed);
          if (typeof message.id !== "number") return;
          const pending = this.pending.get(message.id);
          if (!pending) return;
          if (message.error !== undefined)
            pending.reject(new CdpError("cdp_protocol", string(record(message.error).message)));
          else pending.resolve(message.result);
          this.pending.delete(message.id);
        } catch {
          fail(new CdpError("cdp_protocol", "Invalid CDP message"));
          this.close();
        }
      });
      const abort = () => {
        fail(new CdpError("cdp_timeout", "CDP operation timed out"));
        this.close();
      };
      signal.addEventListener("abort", abort, { once: true });
      this.socket.addEventListener("close", () => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.signal.aborted)
      return Promise.reject(new CdpError("cdp_timeout", "CDP operation timed out"));
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      try {
        this.socket.send(JSON.stringify({ id, method, params, sessionId: this.sessionId }));
      } catch {
        this.pending.delete(id);
        reject(new CdpError("cdp_unreachable", "Cannot send CDP command"));
      }
    });
  }

  close(): void {
    this.socket.close();
  }
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new CdpError("cdp_protocol", "Invalid page URL");
  }
}

async function attach(client: Client, input: CdpTarget, socket: string): Promise<void> {
  if (/^\/devtools\/page\/[^/]+/.test(new URL(socket).pathname)) return;
  const targets = record(await client.call("Target.getTargets")).targetInfos;
  if (!Array.isArray(targets)) throw new CdpError("cdp_protocol", "Invalid CDP targets");
  const pages = targets.map(record).filter((target) => target.type === "page");
  const hint = input.url;
  const target =
    input.target_id !== undefined
      ? pages.find((page) => page.targetId === input.target_id)
      : hint !== undefined
        ? (pages.find((page) => string(page.url).startsWith(hint)) ??
          pages.find((page) => origin(string(page.url)) === origin(hint)))
        : pages.length === 1
          ? pages[0]
          : undefined;
  if (!target) throw new CdpError("target_not_found", "No matching page; provide url or target_id");
  client.sessionId = string(
    record(
      await client.call("Target.attachToTarget", {
        targetId: string(target.targetId),
        flatten: true,
      }),
    ).sessionId,
  );
}

async function frame(client: Client, allowedOrigins: readonly string[]) {
  const tree = record(record(await client.call("Page.getFrameTree")).frameTree);
  const main = record(tree.frame);
  const url = string(main.url);
  const observed = origin(url);
  if (!allowedOrigins.includes(observed))
    throw new CdpError("origin_not_allowed", `Page origin is not allowed: ${observed}`);
  return { url, origin: observed, loaderId: string(main.loaderId) };
}

async function runtimeCall(client: Client, method: string, params: Record<string, unknown>) {
  const result = record(await client.call(method, params));
  if (result.exceptionDetails !== undefined)
    throw new CdpError("cdp_protocol", "CDP JavaScript execution failed");
  return record(result.result);
}

const prepareElement = `function() {
  const el = this;
  const textField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  if ((!textField && !el.isContentEditable) || el.disabled || el.readOnly ||
      (el instanceof HTMLInputElement && ["hidden", "file", "checkbox", "radio", "submit", "button", "reset", "image"].includes(el.type))) return false;
  try {
    el.focus();
    if (document.activeElement !== el) return false;
    if (textField) el.select?.();
    else {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return true;
  } catch { return false; }
}`;

async function operate(input: FillInput | ReadInput, fill: boolean) {
  const signal = AbortSignal.timeout(input.timeoutMs ?? 10_000);
  const socket = await resolveSocket(input.endpoint, signal, input.checkEndpoint);
  let client: Client;
  try {
    client = new Client(socket, signal);
  } catch {
    throw new CdpError("cdp_unreachable", "Cannot connect to CDP");
  }
  try {
    await client.ready;
    await attach(client, input, socket);
    const before = await frame(client, input.allowedOrigins);
    const element = await runtimeCall(client, "Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(input.selector)})`,
      returnByValue: false,
    });
    if (element.subtype === "null" || element.type === "undefined")
      throw new CdpError("element_not_found", `Element not found: ${input.selector}`);
    const objectId = string(element.objectId);
    if (fill && "value" in input) {
      const prepared = await runtimeCall(client, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: prepareElement,
        returnByValue: true,
      });
      if (prepared.value !== true)
        throw new CdpError("element_not_editable", `Element is not editable: ${input.selector}`);
      const after = await frame(client, input.allowedOrigins);
      if (before.url !== after.url || before.loaderId !== after.loaderId)
        throw new CdpError("cdp_protocol", "Page navigated before insertion");
      // The secret must only enter CDP through native text insertion.
      await client.call("Input.insertText", { text: input.value });
      return { origin: after.origin, url: after.url, value: "" };
    }
    const result = await runtimeCall(client, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        const value = this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement
          ? this.value : this.innerText.trim();
        return value.length > 16384 ? null : value;
      }`,
      returnByValue: true,
    });
    if (result.value === null) throw new CdpError("cdp_protocol", "Element text is too long");
    const value = string(result.value);
    if (value.length > 16384) throw new CdpError("cdp_protocol", "Element text is too long");
    return { origin: before.origin, url: before.url, value };
  } finally {
    client.close();
  }
}

export async function fillField(
  input: FillInput,
): Promise<{ readonly origin: string; readonly url: string }> {
  try {
    const { origin, url } = await operate(input, true);
    return { origin, url };
  } catch (error) {
    if (error instanceof CdpError && input.value)
      throw new CdpError(error.code, error.message.split(input.value).join("[redacted]"));
    throw error;
  }
}

export function readField(
  input: ReadInput,
): Promise<{ readonly origin: string; readonly url: string; readonly value: string }> {
  return operate(input, false);
}
