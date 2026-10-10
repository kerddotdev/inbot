import { Schema } from "effect";
import { McpSchema } from "effect/ai";
import { expect } from "vitest";
import type { fixture } from "../http/test-fixture.js";

export async function client(
  api: Awaited<ReturnType<typeof fixture>>,
  token: string,
  browser?: { cookie: string; csrf: string },
) {
  let credential = token;
  let id = 0;
  let session: string | undefined;
  async function rpc(method: string, params: unknown, notification = false) {
    const response = await api.request("/mcp", {
      token: browser === undefined ? credential : null,
      method: "POST",
      body: { jsonrpc: "2.0", ...(notification ? {} : { id: ++id }), method, params },
      headers: {
        accept: "application/json, text/event-stream",
        ...(browser === undefined ? {} : { cookie: browser.cookie, "x-inbot-csrf": browser.csrf }),
        ...(session === undefined
          ? {}
          : { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" }),
      },
    });
    expect(response.status).toBe(notification ? 202 : 200);
    session = response.headers.get("mcp-session-id") ?? session;
    if (notification) return undefined;
    const body = await response.text();
    const json = response.headers.get("content-type")?.includes("text/event-stream")
      ? body
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .at(-1)
          ?.slice(6)
      : body;
    const envelope = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ result: Schema.Unknown })),
    )(json);
    return envelope.result;
  }
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "inbot-test", version: "1.0.0" },
  });
  expect(
    Schema.decodeUnknownSync(Schema.Struct({ protocolVersion: Schema.String }))(initialized)
      .protocolVersion,
  ).toBe("2025-06-18");
  await rpc("notifications/initialized", {}, true);
  return {
    list: async () =>
      Schema.decodeUnknownSync(Schema.Struct({ tools: Schema.Array(McpSchema.Tool) }))(
        await rpc("tools/list", {}),
      ),
    call: async (name: string, args: unknown) => {
      const result = Schema.decodeUnknownSync(McpSchema.CallToolResult)(
        await rpc("tools/call", { name, arguments: args }),
      );
      const text = result.content.find((block) => block.type === "text");
      if (text?.type !== "text") throw new Error("Expected text content");
      expect(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(text.text)).toEqual(
        result.structuredContent,
      );
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(20_000);
      return result;
    },
    credential: (value: string) => {
      credential = value;
    },
  };
}
