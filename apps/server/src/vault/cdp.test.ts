import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CdpError, fillField, readField, resolveBrowserSocket } from "./cdp.js";
import { fakeCdp } from "./cdp-test-server.js";

const origin = "https://example.test";
const secret = 'synthetic-secret-"\\\n-value';
const cleanup: (() => Promise<void>)[] = [];

async function fake(options?: Parameters<typeof fakeCdp>[0]) {
  const server = await fakeCdp(options);
  cleanup.push(() => server.close());
  return server;
}

function input(endpoint: string) {
  return { endpoint, selector: "#password", value: secret, allowedOrigins: [origin] };
}

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe("CDP endpoint resolution", () => {
  it("resolves HTTP endpoints through json/version, including a base path", async () => {
    const server = await fake();
    expect(await resolveBrowserSocket(server.endpoint + "/base/", 1000)).toBe(server.browserSocket);
    expect(server.requests).toEqual(["/base/json/version"]);
  });

  it("passes WebSocket endpoints through unchanged", async () => {
    for (const endpoint of [
      "ws://example.test/devtools/page/1",
      "wss://example.test/devtools/browser/1",
    ])
      expect(await resolveBrowserSocket(endpoint, 1000)).toBe(endpoint);
  });

  it.each(["file:///tmp/cdp", "ftp://example.test", "invalid"])(
    "rejects unsupported endpoint %s",
    async (endpoint) => {
      await expect(resolveBrowserSocket(endpoint, 1000)).rejects.toMatchObject({
        code: "cdp_unreachable",
      });
    },
  );

  it.each(["invalid", "error"] as const)("rejects %s version responses", async (version) => {
    const server = await fake({ version });
    await expect(resolveBrowserSocket(server.endpoint, 1000)).rejects.toMatchObject({
      code: "cdp_unreachable",
    });
  });

  it("classifies network failures without echoing endpoint credentials", async () => {
    const server = await fake();
    await server.close();
    await expect(resolveBrowserSocket(server.endpoint, 1000)).rejects.toMatchObject({
      code: "cdp_unreachable",
    });
    const endpoint = server.endpoint.replace("http://", "http://username:private-password@");
    const error = await resolveBrowserSocket(endpoint, 1000).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CdpError);
    expect(error).toMatchObject({ code: "cdp_unreachable" });
    expect(String(error)).not.toContain("private-password");
  });

  it("times out HTTP discovery", async () => {
    const server = await fake({ version: "silent" });
    await expect(resolveBrowserSocket(server.endpoint, 50)).rejects.toMatchObject({
      code: "cdp_timeout",
    });
  });
});

describe("CDP fields", () => {
  const pages = [
    { targetId: "worker", type: "service_worker", url: origin + "/login" },
    { targetId: "first", type: "page", url: origin + "/other" },
    { targetId: "second", type: "page", url: origin + "/login" },
    { targetId: "third", type: "page", url: origin + "/login/next" },
  ];

  it("fills through a browser socket with flatten sessions and closes it", async () => {
    const server = await fake();
    expect(await fillField(input(server.endpoint))).toEqual({ origin, url: origin + "/login" });
    await server.closed();
    expect(server.connections).toHaveLength(1);
    expect(server.messages.map((message) => message.method)).toEqual([
      "Target.getTargets",
      "Target.attachToTarget",
      "Page.getFrameTree",
      "Runtime.evaluate",
      "Runtime.callFunctionOn",
      "Page.getFrameTree",
      "Input.insertText",
    ]);
    expect(server.messages[1]?.params).toEqual({ targetId: "page-1", flatten: true });
    expect(server.messages.slice(2).every((message) => message.sessionId === "session-1")).toBe(
      true,
    );
    expect(
      server.messages.filter((message) =>
        JSON.stringify(message).includes(JSON.stringify(secret).slice(1, -1)),
      ),
    ).toEqual([expect.objectContaining({ method: "Input.insertText", params: { text: secret } })]);
  });

  it("uses page-level sockets directly without attaching or a session", async () => {
    const server = await fake();
    await fillField(input(server.pageSocket));
    await server.closed();
    expect(server.messages.some((message) => message.method.startsWith("Target."))).toBe(false);
    expect(server.messages.every((message) => message.sessionId === undefined)).toBe(true);
    expect(server.connections[0]?.path).toBe("/devtools/page/page-1");
  });

  it.each([
    { hint: { url: origin + "/login" }, target: "second" },
    { hint: { url: origin + "/no-prefix" }, target: "first" },
    { hint: { target_id: "third" }, target: "third" },
    { hint: { target_id: "first", url: origin + "/login" }, target: "first" },
  ])("selects a page using $hint", async ({ hint, target }) => {
    const server = await fake({ pages });
    await fillField({ ...input(server.browserSocket), ...hint });
    expect(
      server.messages.find((message) => message.method === "Target.attachToTarget")?.params,
    ).toEqual({ targetId: target, flatten: true });
  });

  it.each([
    { hint: {}, available: pages },
    { hint: {}, available: [] },
    { hint: { target_id: "absent" }, available: pages },
    { hint: { target_id: "worker" }, available: pages },
    { hint: { url: "https://different.test" }, available: pages },
  ])("rejects absent or ambiguous page targets", async ({ hint, available }) => {
    const server = await fake({ pages: available });
    await expect(fillField({ ...input(server.browserSocket), ...hint })).rejects.toMatchObject({
      code: "target_not_found",
      message: expect.stringContaining("url or target_id"),
    });
    await server.closed();
    expect(server.messages.map((message) => message.method)).toEqual(["Target.getTargets"]);
  });

  it.each([fillField, readField])(
    "refuses an unapproved main frame before DOM access",
    async (operation) => {
      const server = await fake({ pageUrl: "https://untrusted.test/login" });
      await expect(operation(input(server.pageSocket))).rejects.toMatchObject({
        code: "origin_not_allowed",
        message: expect.stringContaining("https://untrusted.test"),
      });
      await server.closed();
      expect(server.messages.map((message) => message.method)).toEqual(["Page.getFrameTree"]);
    },
  );

  it("requires exact allowed origins", async () => {
    const server = await fake();
    await expect(
      fillField({ ...input(server.pageSocket), allowedOrigins: [origin + "/"] }),
    ).rejects.toMatchObject({ code: "origin_not_allowed" });
  });

  it.each([
    { navigation: { navigateTo: "https://untrusted.test/login" }, code: "origin_not_allowed" },
    { navigation: { navigateTo: origin + "/other" }, code: "cdp_protocol" },
    { navigation: { reload: true }, code: "cdp_protocol" },
  ])("refuses navigation between checks: $navigation", async ({ navigation, code }) => {
    const server = await fake(navigation);
    await expect(fillField(input(server.pageSocket))).rejects.toMatchObject({ code });
    await server.closed();
    expect(
      server.messages.filter((message) => message.method === "Page.getFrameTree"),
    ).toHaveLength(2);
    expect(server.messages.some((message) => message.method === "Input.insertText")).toBe(false);
  });

  it.each([fillField, readField])("reports missing elements", async (operation) => {
    const server = await fake({ missing: true });
    await expect(operation(input(server.pageSocket))).rejects.toMatchObject({
      code: "element_not_found",
    });
    await server.closed();
    expect(server.messages.some((message) => message.method === "Runtime.callFunctionOn")).toBe(
      false,
    );
  });

  it.each([
    { elementKind: "text" },
    { disabled: true },
    { readOnly: true },
    ...["hidden", "file", "checkbox", "radio", "submit", "button", "reset", "image"].map(
      (inputType) => ({ inputType }),
    ),
  ] satisfies readonly Parameters<typeof fakeCdp>[0][])(
    "refuses non-editable elements without inserting text: %j",
    async (options) => {
      const server = await fake(options);
      await expect(fillField(input(server.pageSocket))).rejects.toMatchObject({
        code: "element_not_editable",
      });
      expect(server.messages.some((message) => message.method === "Input.insertText")).toBe(false);
    },
  );

  it.each(["input", "textarea", "contenteditable"] as const)(
    "fills editable %s elements",
    async (elementKind) => {
      const server = await fake({ elementKind });
      await fillField(input(server.pageSocket));
      expect(server.messages.at(-1)).toMatchObject({
        method: "Input.insertText",
        params: { text: secret },
      });
    },
  );

  it("trims text from other elements", async () => {
    const server = await fake({ elementKind: "text", value: "  captured API key \n " });
    expect((await readField(input(server.pageSocket))).value).toBe("captured API key");
  });

  it("JSON-encodes selectors to prevent expression injection", async () => {
    const server = await fake();
    const selector = '#password\\\"); globalThis.attack = true; //';
    await fillField({ ...input(server.pageSocket), selector });
    expect(
      server.messages.find((message) => message.method === "Runtime.evaluate")?.params,
    ).toEqual({
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: false,
    });
  });

  it.each(["", "captured-api-key", "a".repeat(16384)])(
    "reads values within the limit",
    async (value) => {
      const server = await fake({ value });
      expect(await readField(input(server.pageSocket))).toEqual({
        origin,
        url: origin + "/login",
        value,
      });
      await server.closed();
      expect(server.messages.some((message) => message.method === "Input.insertText")).toBe(false);
    },
  );

  it("caps captured values without exposing them in errors", async () => {
    const value = "private-captured-value".repeat(1000);
    const server = await fake({ value });
    const error = await readField(input(server.pageSocket)).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "cdp_protocol", message: "Element text is too long" });
    expect(String(error)).not.toContain("private-captured-value");
    await server.closed();
  });

  it("preserves protocol error messages and closes the socket", async () => {
    const server = await fake({
      protocolError: { method: "Runtime.evaluate", message: "Invalid selector" },
    });
    await expect(fillField(input(server.pageSocket))).rejects.toMatchObject({
      code: "cdp_protocol",
      message: "Invalid selector",
    });
    await server.closed();
  });

  it("redacts secrets even if a protocol peer echoes insertion parameters", async () => {
    const server = await fake({
      protocolError: { method: "Input.insertText", message: `Refused ${secret}` },
    });
    const error = await fillField(input(server.pageSocket)).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "cdp_protocol", message: "Refused [redacted]" });
    expect(String(error)).not.toContain(secret);
    await server.closed();
  });

  it("does not expose runtime exception details", async () => {
    const server = await fake({
      reply: (message, result) =>
        message.method === "Runtime.callFunctionOn"
          ? { result: {}, exceptionDetails: { text: "private-read-value" } }
          : result,
    });
    await expect(readField(input(server.pageSocket))).rejects.toMatchObject({
      code: "cdp_protocol",
      message: "CDP JavaScript execution failed",
    });
  });

  it.each([
    "Target.getTargets",
    "Target.attachToTarget",
    "Page.getFrameTree",
    "Runtime.evaluate",
    "Runtime.callFunctionOn",
    "Input.insertText",
  ])("times out unanswered %s and closes the socket", async (silentMethod) => {
    const server = await fake({ silentMethod });
    await expect(
      fillField({ ...input(server.browserSocket), timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: "cdp_timeout" });
    await server.closed();
  });

  it("times out an unanswered WebSocket handshake", async () => {
    const server = await fake({ handshake: "silent" });
    await expect(fillField({ ...input(server.pageSocket), timeoutMs: 50 })).rejects.toMatchObject({
      code: "cdp_timeout",
    });
    await server.closed();
  });

  it("rejects failed handshakes", async () => {
    const server = await fake({ handshake: "reject" });
    await expect(fillField(input(server.pageSocket))).rejects.toMatchObject({
      code: "cdp_unreachable",
    });
    await server.closed();
  });

  it("rejects pending calls if the peer closes", async () => {
    const server = await fake({ closeOn: "Runtime.evaluate" });
    await expect(fillField(input(server.pageSocket))).rejects.toMatchObject({
      code: "cdp_unreachable",
    });
    await server.closed();
  });

  it.each([
    "Target.getTargets",
    "Target.attachToTarget",
    "Page.getFrameTree",
    "Runtime.evaluate",
    "Runtime.callFunctionOn",
  ])("rejects malformed %s results", async (method) => {
    const server = await fake({
      reply: (message, result) => (message.method === method ? {} : result),
    });
    await expect(fillField(input(server.browserSocket))).rejects.toMatchObject({
      code: "cdp_protocol",
    });
    await server.closed();
  });
});

it.skipIf(!process.env.INBOT_CDP_CHROME)(
  "fills and reads a real headless Chrome page",
  async () => {
    const binary = process.env.INBOT_CDP_CHROME;
    if (!binary) throw new Error("Chrome binary is required");
    const directory = await mkdtemp(join(tmpdir(), "inbot-cdp-"));
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><form>
      <input id="password" type="password" value="old-password">
      <textarea id="notes">old notes</textarea>
      <div id="editable" contenteditable="true">old content</div>
      <input id="disabled" disabled><input id="readonly" readonly>
      <input id="checkbox" type="checkbox"><input id="file" type="file">
      <input id="hidden" type="hidden"><input id="radio" type="radio">
      <input id="submit" type="submit"><input id="button" type="button">
      <div id="ordinary">  visible API key  </div><output id="observed"></output>
      <script>document.querySelector('#password').addEventListener('input', (event) => {
        document.querySelector('#observed').textContent = event.target.value;
      });</script></form>`);
    });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Missing HTTP test address");
      const pageUrl = `http://127.0.0.1:${address.port}/login`;
      child = spawn(
        binary,
        [
          "--headless=new",
          "--remote-debugging-port=0",
          "--remote-debugging-address=127.0.0.1",
          `--user-data-dir=${directory}`,
          "--no-first-run",
          "--no-default-browser-check",
          pageUrl,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      const browser = child;
      const endpoint = await new Promise<string>((resolve, reject) => {
        let stderr = "";
        const timer = setTimeout(() => reject(new Error("Chrome startup timed out")), 15_000);
        const done = () => clearTimeout(timer);
        browser.once("error", (error) => {
          done();
          reject(error);
        });
        browser.once("exit", () => {
          done();
          reject(new Error("Chrome exited before startup"));
        });
        browser.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
          const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1];
          if (match) {
            done();
            resolve(match);
          }
        });
      });
      const base = { endpoint, url: pageUrl, allowedOrigins: [new URL(pageUrl).origin] };
      const deadline = Date.now() + 15_000;
      while (true) {
        try {
          await readField({ ...base, selector: "#password" });
          break;
        } catch (error) {
          if (
            !(error instanceof CdpError) ||
            !["target_not_found", "element_not_found", "origin_not_allowed"].includes(error.code) ||
            Date.now() > deadline
          )
            throw error;
        }
      }
      for (const selector of ["#password", "#notes", "#editable"]) {
        const value = "new synthetic value";
        await fillField({ ...base, selector, value });
        expect((await readField({ ...base, selector })).value).toBe(value);
      }
      expect((await readField({ ...base, selector: "#observed" })).value).toBe(
        "new synthetic value",
      );
      expect((await readField({ ...base, selector: "#ordinary" })).value).toBe("visible API key");
      for (const selector of [
        "#disabled",
        "#readonly",
        "#checkbox",
        "#file",
        "#hidden",
        "#radio",
        "#submit",
        "#button",
        "#ordinary",
      ])
        await expect(
          fillField({ ...base, selector, value: "unused synthetic value" }),
        ).rejects.toMatchObject({ code: "element_not_editable" });
    } finally {
      if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child?.once("close", () => resolve()));
        child.kill("SIGTERM");
        const timer = setTimeout(() => child?.kill("SIGKILL"), 2000);
        await closed;
        clearTimeout(timer);
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

it("checks both the requested endpoint and discovered WebSocket before connecting", async () => {
  const server = await fake();
  const checked: string[] = [];
  const failure = { code: "missing_permission", message: "Discovery target denied" };
  const checkEndpoint = async (endpoint: string) => {
    checked.push(endpoint);
    if (endpoint === server.browserSocket) throw failure;
  };
  await expect(fillField({ ...input(server.endpoint), checkEndpoint })).rejects.toEqual(failure);
  expect(checked).toEqual([server.endpoint, server.browserSocket]);
  expect(server.connections).toEqual([]);
  expect(server.messages).toEqual([]);
  const direct = await fake();
  await expect(
    readField({
      ...input(direct.pageSocket),
      checkEndpoint: async () => {
        throw failure;
      },
    }),
  ).rejects.toEqual(failure);
  expect(direct.connections).toEqual([]);
  expect(direct.requests).toEqual([]);
});

it("refuses HTTP discovery redirects before contacting the redirected address", async () => {
  const target = await fake();
  const redirect = createServer((_request, response) => {
    response.writeHead(302, { location: `${target.endpoint}/json/version` });
    response.end();
  });
  redirect.listen(0, "127.0.0.1");
  await once(redirect, "listening");
  cleanup.push(async () => {
    redirect.closeAllConnections();
    await new Promise<void>((resolve) => redirect.close(() => resolve()));
  });
  const address = redirect.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing redirect test address");
  await expect(fillField(input(`http://127.0.0.1:${address.port}`))).rejects.toMatchObject({
    code: "cdp_unreachable",
  });
  expect(target.requests).toEqual([]);
  expect(target.connections).toEqual([]);
});
