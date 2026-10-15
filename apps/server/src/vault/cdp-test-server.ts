import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { once } from "node:events";
import { runInNewContext } from "node:vm";

export interface Command {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId?: string;
}

interface Options {
  readonly pages?: readonly { targetId: string; type: string; url: string }[];
  readonly pageUrl?: string;
  readonly navigateTo?: string;
  readonly reload?: boolean;
  readonly missing?: boolean;
  readonly elementKind?: "input" | "textarea" | "contenteditable" | "text";
  readonly inputType?: string;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly value?: string;
  readonly silentMethod?: string;
  readonly protocolError?: { method: string; message: string };
  readonly reply?: (command: Command, result: unknown) => unknown;
  readonly closeOn?: string;
  readonly handshake?: "silent" | "reject";
  readonly version?: "silent" | "invalid" | "error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function command(value: unknown): Command {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    typeof value.method !== "string" ||
    !isRecord(value.params) ||
    (value.sessionId !== undefined && typeof value.sessionId !== "string")
  )
    throw new Error("Invalid test command");
  return {
    id: value.id,
    method: value.method,
    params: value.params,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
  };
}

function frame(payload: Buffer, opcode = 1): Buffer {
  const header = Buffer.alloc(payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10);
  header[0] = 0x80 | opcode;
  if (header.length === 2) header[1] = payload.length;
  else if (header.length === 4) {
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

export async function fakeCdp(options: Options = {}) {
  const messages: Command[] = [];
  const requests: string[] = [];
  const sockets = new Set<Duplex>();
  const connections: { path: string; closed: Promise<void> }[] = [];
  let frameChecks = 0;
  let endpoint = "";
  const pageUrl = options.pageUrl ?? "https://example.test/login";
  const document: {
    activeElement?: object;
    createRange: () => { selectNodeContents: () => void };
  } = {
    createRange: () => ({ selectNodeContents() {} }),
  };
  class Element {
    value = options.value ?? "test-value";
    innerText = this.value;
    isContentEditable = options.elementKind === "contenteditable";
    disabled = options.disabled ?? false;
    readOnly = options.readOnly ?? false;
    type = options.inputType ?? "text";
    focus() {
      document.activeElement = this;
    }
    select() {}
  }
  class Input extends Element {}
  class Textarea extends Element {}
  const element =
    options.elementKind === "textarea"
      ? new Textarea()
      : options.elementKind === "contenteditable" || options.elementKind === "text"
        ? new Element()
        : new Input();
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    if (options.version === "silent") return;
    res.setHeader("Content-Type", "application/json");
    if (options.version === "error") res.statusCode = 503;
    res.end(
      JSON.stringify(
        options.version === "invalid"
          ? {}
          : {
              webSocketDebuggerUrl: endpoint.replace("http:", "ws:") + "/devtools/browser/test",
            },
      ),
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("end", () => socket.end());
  });
  server.on("upgrade", (req, socket, head) => {
    connections.push({
      path: req.url ?? "",
      closed: new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
      }),
    });
    if (options.handshake === "silent") return;
    if (options.handshake === "reject") {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") throw new Error("Missing WebSocket key");
    const accept = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
        `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let buffer = Buffer.from(head);
    let fragments: Buffer[] = [];
    const answer = (text: string) => {
      const parsed: unknown = JSON.parse(text);
      const received = command(parsed);
      messages.push(received);
      if (received.method === options.closeOn) {
        socket.end();
        return;
      }
      if (received.method === options.silentMethod) return;
      let result: unknown;
      switch (received.method) {
        case "Target.getTargets":
          result = {
            targetInfos: options.pages ?? [{ targetId: "page-1", type: "page", url: pageUrl }],
          };
          break;
        case "Target.attachToTarget":
          result = { sessionId: "session-1" };
          break;
        case "Page.getFrameTree": {
          frameChecks++;
          result = {
            frameTree: {
              frame: {
                id: "main",
                loaderId: options.reload && frameChecks > 1 ? "loader-2" : "loader-1",
                url: frameChecks > 1 ? (options.navigateTo ?? pageUrl) : pageUrl,
              },
              childFrames: [{ frame: { url: "https://untrusted.test" } }],
            },
          };
          break;
        }
        case "Runtime.evaluate":
          result = {
            result: options.missing
              ? { type: "object", subtype: "null", value: null }
              : { type: "object", subtype: "node", objectId: "element-1" },
          };
          break;
        case "Runtime.callFunctionOn": {
          const fn = received.params.functionDeclaration;
          if (typeof fn !== "string") throw new Error("Missing test function");
          const value: unknown = runInNewContext(`(${fn}).call(element)`, {
            element,
            document,
            HTMLInputElement: Input,
            HTMLTextAreaElement: Textarea,
            window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
          });
          result = {
            result: {
              type: typeof value,
              value,
            },
          };
          break;
        }
        case "Input.insertText":
          result = {};
          break;
        default:
          throw new Error(`Unexpected CDP method: ${received.method}`);
      }
      socket.write(
        frame(
          Buffer.from(
            JSON.stringify(
              options.protocolError?.method === received.method
                ? {
                    id: received.id,
                    error: { code: -32000, message: options.protocolError.message },
                  }
                : {
                    id: received.id,
                    result: options.reply ? options.reply(received, result) : result,
                  },
            ),
          ),
        ),
      );
    };
    const consume = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const first = buffer.readUInt8(0);
        const second = buffer.readUInt8(1);
        if (!(second & 0x80)) throw new Error("Client frames must be masked");
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (length > 16 * 1024 * 1024) throw new Error("Test frame too large");
        if (buffer.length < offset + 4 + length) return;
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < length; i++)
          payload[i] = payload.readUInt8(i) ^ buffer.readUInt8(offset + (i % 4));
        buffer = buffer.subarray(offset + 4 + length);
        const opcode = first & 0x0f;
        if (opcode === 8) {
          socket.end(frame(payload, 8));
          return;
        }
        if (opcode === 9) {
          socket.write(frame(payload, 10));
          continue;
        }
        if (opcode !== 1 && opcode !== 0) throw new Error("Unsupported test frame");
        fragments.push(payload);
        if (first & 0x80) {
          answer(Buffer.concat(fragments).toString("utf8"));
          fragments = [];
        }
      }
    };
    socket.on("data", consume);
    consume(Buffer.alloc(0));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test address");
  endpoint = `http://127.0.0.1:${address.port}`;
  return {
    endpoint,
    messages,
    requests,
    connections,
    browserSocket: endpoint.replace("http:", "ws:") + "/devtools/browser/test",
    pageSocket: endpoint.replace("http:", "ws:") + "/devtools/page/page-1",
    async closed() {
      await Promise.all(connections.map((connection) => connection.closed));
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
