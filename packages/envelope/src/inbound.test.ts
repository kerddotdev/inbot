import { expect, test, vi } from "vitest";
import {
  frameInbound,
  InboundFrameError,
  maxInboundHeaderSize,
  maxMessageSize,
  parseInbound,
} from "./index.js";

const envelope = {
  mail_from: "sender@example.invalid",
  rcpt_to: ["bcc@example.invalid", "\u00e9@example.invalid"],
};

function headerFrame(header: Uint8Array, declaredSize = header.byteLength) {
  const magic = new TextEncoder().encode("INBOT-INBOUND/1\n");
  const frame = new Uint8Array(magic.byteLength + 4 + header.byteLength);
  frame.set(magic);
  new DataView(frame.buffer).setUint32(magic.byteLength, declaredSize, false);
  frame.set(header, magic.byteLength + 4);
  return frame;
}

test.each([0, 3, 200_003])("roundtrips a framed raw body of %i bytes", async (size) => {
  const raw = Uint8Array.from({ length: size }, (_, index) => index % 256);
  let offset = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === size) {
        controller.close();
        return;
      }
      controller.enqueue(raw.subarray(offset, offset + 997));
      offset = Math.min(size, offset + 997);
    },
  });
  const framed = frameInbound(envelope, source);
  const bytes = new Uint8Array(await new Response(framed.stream).arrayBuffer());
  expect(bytes.byteLength).toBe(framed.length(size));
  const header = new TextEncoder().encode(JSON.stringify(envelope));
  expect(bytes.subarray(0, bytes.byteLength - size)).toEqual(headerFrame(header));
  const parsed = parseInbound(bytes);
  expect(parsed.envelope).toEqual(envelope);
  expect(parsed.raw).toEqual(raw);
  expect(parsed.raw.buffer).toBe(bytes.buffer);
  const padded = new Uint8Array(bytes.byteLength + 7);
  padded.set(bytes, 7);
  expect(parseInbound(padded.subarray(7))).toEqual(parsed);
});

test.each([
  ["empty frame", new Uint8Array(0)],
  ["bad magic", new TextEncoder().encode("OTHER-INBOUND/1\n")],
  ["unsupported version", new TextEncoder().encode("INBOT-INBOUND/2\n")],
  ["truncated length", new TextEncoder().encode("INBOT-INBOUND/1\n\0\0\0")],
  ["oversized header", headerFrame(new Uint8Array(0), maxInboundHeaderSize + 1)],
  ["truncated header", headerFrame(new Uint8Array(1), 2)],
  ["empty JSON", headerFrame(new Uint8Array(0))],
  ["invalid JSON", headerFrame(new TextEncoder().encode("{"))],
  ["invalid UTF-8", headerFrame(new Uint8Array([0xff]))],
])("rejects %s with a typed error", (_name, frame) => {
  expect(() => parseInbound(frame)).toThrow(InboundFrameError);
});

test.each([
  null,
  [],
  {},
  { mail_from: 42, rcpt_to: [] },
  { mail_from: "sender@example.invalid", rcpt_to: "inbox@example.invalid" },
  { mail_from: "sender@example.invalid", rcpt_to: [42] },
  { ...envelope, subject: "private subject" },
])("rejects an invalid envelope %# with a typed error", (invalid) => {
  const frame = headerFrame(new TextEncoder().encode(JSON.stringify(invalid)));
  expect(() => parseInbound(frame)).toThrow(InboundFrameError);
});

test("accepts an empty SMTP reverse path", async () => {
  const framed = frameInbound(
    { mail_from: "", rcpt_to: ["inbox@example.invalid"] },
    new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
  );
  const bytes = new Uint8Array(await new Response(framed.stream).arrayBuffer());
  expect(parseInbound(bytes).envelope.mail_from).toBe("");
});

test("enforces the header byte limit while allowing the exact boundary", async () => {
  const empty = { mail_from: "", rcpt_to: [] };
  const paddingSize = maxInboundHeaderSize - JSON.stringify(empty).length;
  const source = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  const framed = frameInbound({ ...empty, mail_from: "a".repeat(paddingSize) }, source);
  const bytes = new Uint8Array(await new Response(framed.stream).arrayBuffer());
  expect(parseInbound(bytes).envelope.mail_from).toHaveLength(paddingSize);
  const pull = vi.fn();
  const oversizedSource = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
  expect(() =>
    frameInbound({ ...empty, mail_from: "\u00e9".repeat(paddingSize) }, oversizedSource),
  ).toThrow(InboundFrameError);
  expect(pull).not.toHaveBeenCalled();
  expect(oversizedSource.locked).toBe(false);
});

test("keeps schema failures free of sender and recipient values", () => {
  const invalid = { ...envelope, subject: "private subject" };
  const source = new ReadableStream<Uint8Array>({}, { highWaterMark: 0 });
  expect(() => frameInbound(invalid, source)).toThrow(InboundFrameError);
  try {
    parseInbound(headerFrame(new TextEncoder().encode(JSON.stringify(invalid))));
    throw new Error("Expected a frame error.");
  } catch (error) {
    expect(error).toBeInstanceOf(InboundFrameError);
    expect(String(error)).not.toContain(envelope.mail_from);
    expect(JSON.stringify(error)).not.toContain(envelope.mail_from);
    expect(JSON.stringify(error)).not.toContain(envelope.rcpt_to[0]);
  }
});

test("rejects a raw body above 25 MiB independently of frame overhead", () => {
  const header = headerFrame(new TextEncoder().encode(JSON.stringify(envelope)));
  const bytes = new Uint8Array(header.byteLength + maxMessageSize + 1);
  bytes.set(header);
  expect(() => parseInbound(bytes)).toThrow(InboundFrameError);
});

test("does not read ahead and propagates cancellation to the raw stream", async () => {
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    controller.enqueue(new Uint8Array([1, 2, 3]));
  });
  const cancel = vi.fn();
  const source = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  const reader = frameInbound(envelope, source).stream.getReader();
  expect(pull).not.toHaveBeenCalled();
  expect((await reader.read()).value).toEqual(
    headerFrame(new TextEncoder().encode(JSON.stringify(envelope))),
  );
  expect(pull).not.toHaveBeenCalled();
  expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
  expect(pull).toHaveBeenCalledOnce();
  await reader.cancel("Synthetic cancellation.");
  expect(cancel).toHaveBeenCalledWith("Synthetic cancellation.");
  expect(source.locked).toBe(false);
});

test("propagates a raw stream failure and releases its reader", async () => {
  const failure = new Error("Synthetic raw failure.");
  const source = new ReadableStream<Uint8Array>(
    {
      pull: () => {
        throw failure;
      },
    },
    { highWaterMark: 0 },
  );
  const framed = frameInbound(envelope, source);
  await expect(new Response(framed.stream).arrayBuffer()).rejects.toBe(failure);
  expect(source.locked).toBe(false);
});
