import {
  decrypt,
  generateIdentity,
  maxMessageSize,
  parseInbound,
} from "../../../packages/envelope/src/index.js";
import { InboundPointer } from "../../../packages/envelope/src/pointer.js";
import { Schema } from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import worker, { type Env } from "./index.js";

class FakeFixedLengthStream extends TransformStream<ArrayBuffer | ArrayBufferView, Uint8Array> {
  constructor(expectedLength: number) {
    let length = 0;
    super({
      transform(chunk, controller) {
        const bytes =
          chunk instanceof ArrayBuffer
            ? new Uint8Array(chunk)
            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        length += bytes.byteLength;
        if (length > expectedLength) throw new Error("Synthetic length overflow.");
        controller.enqueue(bytes);
      },
      flush() {
        if (length !== expectedLength) throw new Error("Synthetic length underflow.");
      },
    });
  }
}

beforeEach(() => {
  vi.stubGlobal("FixedLengthStream", FakeFixedLengthStream);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T12:00:00.000Z"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function message(bytes: Uint8Array, rawSize = bytes.byteLength) {
  let offset = 0;
  const cancel = vi.fn();
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (offset === bytes.byteLength) {
      controller.close();
      return;
    }
    controller.enqueue(bytes.subarray(offset, offset + 997));
    offset = Math.min(offset + 997, bytes.byteLength);
  });
  return {
    from: "synthetic-sender@example.invalid",
    to: "synthetic-inbox@example.invalid",
    headers: new Headers({ subject: "synthetic private subject" }),
    raw: new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }),
    rawSize,
    setReject: vi.fn(),
    forward: vi.fn(async () => ({ messageId: "synthetic-forward" })),
    reply: vi.fn(async () => ({ messageId: "synthetic-reply" })),
    pull,
    cancel,
  } satisfies ForwardableEmailMessage & { pull: typeof pull; cancel: typeof cancel };
}

async function fixture() {
  const { identity, recipient } = await generateIdentity();
  const objects = new Map<string, Uint8Array>();
  const events: string[] = [];
  const put = vi.fn(
    async (key: string, value: unknown, _options?: R2PutOptions): Promise<R2Object> => {
      events.push("put");
      if (!(value instanceof ReadableStream)) throw new Error("Expected a stream body.");
      const ciphertext = new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, ciphertext);
      events.push("stored");
      return {
        key,
        version: "synthetic-version",
        size: ciphertext.byteLength,
        etag: "synthetic-etag",
        httpEtag: '"synthetic-etag"',
        checksums: { toJSON: () => ({}) },
        uploaded: new Date(),
        storageClass: "Standard",
        writeHttpMetadata() {},
      };
    },
  );
  const send = vi.fn(async (_pointer: InboundPointer, _options?: QueueSendOptions) => {
    events.push("queue");
    return { metadata: { metrics: { backlogCount: 1, backlogBytes: 256 } } };
  });
  const env: Env = { INBOUND_BUCKET: { put }, INBOUND_QUEUE: { send }, RECIPIENT: recipient };
  return { identity, objects, events, put, send, env };
}

const plaintext = new TextEncoder().encode(
  "From: header-sender@example.invalid\r\nTo: mailing-list@example.invalid\r\nSubject: synthetic private subject\r\n\r\nSynthetic private body.\r\n",
);

test.each([new Uint8Array(0), plaintext, new Uint8Array(200_003).fill(37)])(
  "stores framed ciphertext before sending a minimal JSON pointer %#",
  async (raw) => {
    const { identity, objects, events, put, send, env } = await fixture();
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    const info = vi.spyOn(console, "info");
    const debug = vi.spyOn(console, "debug");
    const input = message(raw);
    await worker.email(input, env);
    expect(input.setReject).not.toHaveBeenCalled();
    expect(input.forward).not.toHaveBeenCalled();
    expect(input.reply).not.toHaveBeenCalled();
    expect(events).toEqual(["put", "stored", "queue"]);
    expect(put).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    const call = send.mock.calls[0];
    if (!call) throw new Error("Missing pointer.");
    const [pointer, options] = call;
    expect(options).toEqual({ contentType: "json" });
    expect(Object.keys(pointer).sort()).toEqual(["key", "received_at", "size", "version"]);
    expect(Schema.decodeUnknownSync(InboundPointer)(pointer)).toEqual(pointer);
    expect(pointer.received_at).toBe("2026-10-10T12:00:00.000Z");
    const ciphertext = objects.get(pointer.key);
    if (!ciphertext) throw new Error("Missing object.");
    expect(pointer.size).toBe(ciphertext.byteLength);
    expect(parseInbound(await decrypt(identity, ciphertext))).toEqual({
      envelope: { mail_from: input.from, rcpt_to: [input.to] },
      raw,
    });
    expect(put.mock.calls[0]?.length).toBe(2);
    const metadata = JSON.stringify({ key: pointer.key, options: put.mock.calls[0]?.[2], pointer });
    expect(metadata).not.toContain(input.from);
    expect(metadata).not.toContain(input.to);
    expect(metadata).not.toContain(input.headers.get("subject"));
    expect(new TextDecoder().decode(ciphertext)).not.toContain(input.from);
    expect(new TextDecoder().decode(ciphertext)).not.toContain(input.to);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  },
);

test("rejects oversized messages without reading, storing, or queueing", async () => {
  const { objects, put, send, env } = await fixture();
  const input = message(plaintext, maxMessageSize + 1);
  await worker.email(input, env);
  expect(input.setReject).toHaveBeenCalledWith("Message exceeds 25 MiB.");
  expect(input.pull).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(objects.size).toBe(0);
});

test("throws if R2 fails and never sends a pointer", async () => {
  const { objects, put, send, env } = await fixture();
  const failure = new Error("Synthetic R2 failure.");
  put.mockRejectedValueOnce(failure);
  const input = message(plaintext);
  await expect(worker.email(input, env)).rejects.toBe(failure);
  expect(send).not.toHaveBeenCalled();
  expect(objects.size).toBe(0);
  expect(input.setReject).not.toHaveBeenCalled();
});

test("keeps a committed object and throws when the Queue fails", async () => {
  const { identity, objects, events, send, env } = await fixture();
  const failure = new Error("Synthetic Queue failure.");
  send.mockRejectedValueOnce(failure);
  const input = message(plaintext);
  await expect(worker.email(input, env)).rejects.toBe(failure);
  expect(events).toEqual(["put", "stored"]);
  expect(send).toHaveBeenCalledOnce();
  const pointer = send.mock.calls[0]?.[0];
  if (!pointer) throw new Error("Missing attempted pointer.");
  const ciphertext = objects.get(pointer.key);
  if (!ciphertext) throw new Error("Missing reconciliable object.");
  expect(parseInbound(await decrypt(identity, ciphertext))).toEqual({
    envelope: { mail_from: input.from, rcpt_to: [input.to] },
    raw: plaintext,
  });
  expect(objects.size).toBe(1);
});

test.each([-1, 1])(
  "throws for a rawSize mismatch of %i byte without queueing",
  async (difference) => {
    const { objects, send, env } = await fixture();
    await expect(
      worker.email(message(plaintext, plaintext.byteLength + difference), env),
    ).rejects.toThrow("Synthetic length");
    expect(send).not.toHaveBeenCalled();
    expect(objects.size).toBe(0);
  },
);

test("propagates a raw stream failure without persisting plaintext or queueing", async () => {
  const { objects, send, env } = await fixture();
  const failure = new Error("Synthetic MIME stream failure.");
  const input = message(plaintext);
  input.raw = new ReadableStream<Uint8Array>({
    pull() {
      throw failure;
    },
  });
  await expect(worker.email(input, env)).rejects.toBe(failure);
  expect(objects.size).toBe(0);
  expect(send).not.toHaveBeenCalled();
});

test("fails before storing when the recipient is invalid", async () => {
  const { put, send, env } = await fixture();
  await expect(worker.email(message(plaintext), { ...env, RECIPIENT: "invalid" })).rejects.toThrow(
    "X25519",
  );
  expect(put).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test("accepts the exact 25 MiB limit with streaming input", async () => {
  const { identity, objects, send, env } = await fixture();
  const input = message(new Uint8Array(0), maxMessageSize);
  const chunk = new Uint8Array(65536).fill(37);
  let remaining = maxMessageSize;
  input.raw = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (remaining === 0) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        remaining -= chunk.byteLength;
      },
    },
    { highWaterMark: 0 },
  );
  await worker.email(input, env);
  expect(input.setReject).not.toHaveBeenCalled();
  const pointer = send.mock.calls[0]?.[0];
  if (!pointer) throw new Error("Missing pointer.");
  const ciphertext = objects.get(pointer.key);
  if (!ciphertext) throw new Error("Missing object.");
  const { envelope, raw: decrypted } = parseInbound(await decrypt(identity, ciphertext));
  expect(envelope).toEqual({ mail_from: input.from, rcpt_to: [input.to] });
  expect(decrypted.byteLength).toBe(maxMessageSize);
  expect(decrypted.every((byte) => byte === 37)).toBe(true);
  expect(pointer.size).toBe(ciphertext.byteLength);
});
