export const maxMessageSize = 25 * 1024 * 1024;
export const maxInboundHeaderSize = 16 * 1024;
const magic = new TextEncoder().encode("INBOT-INBOUND/1\n");
const prefixSize = magic.byteLength + 4;
export const maxInboundFrameOverhead = prefixSize + maxInboundHeaderSize;

export interface InboundEnvelope {
  readonly mail_from: string;
  readonly rcpt_to: readonly string[];
}

export class InboundFrameError extends Error {
  readonly code = "invalid_inbound_frame";
  readonly fix = "Provide a version 1 inbound frame with a valid envelope and raw MIME body.";
  constructor(input: { readonly message: string }) {
    super(input.message);
    this.name = "InboundFrameError";
  }
}

function validateEnvelope(input: unknown): InboundEnvelope {
  if (
    input === null ||
    typeof input !== "object" ||
    !("mail_from" in input) ||
    typeof input.mail_from !== "string" ||
    !("rcpt_to" in input) ||
    !Array.isArray(input.rcpt_to) ||
    !input.rcpt_to.every((value: unknown): value is string => typeof value === "string") ||
    Object.keys(input).some((key) => key !== "mail_from" && key !== "rcpt_to")
  )
    throw new InboundFrameError({ message: "Invalid inbound envelope." });
  return { mail_from: input.mail_from, rcpt_to: input.rcpt_to };
}

export function frameInbound(envelope: InboundEnvelope, raw: ReadableStream<Uint8Array>) {
  const header = new TextEncoder().encode(JSON.stringify(validateEnvelope(envelope)));
  if (header.byteLength > maxInboundHeaderSize) {
    throw new InboundFrameError({ message: "Inbound envelope exceeds 16 KiB." });
  }
  const prefix = new Uint8Array(prefixSize + header.byteLength);
  prefix.set(magic);
  new DataView(prefix.buffer).setUint32(magic.byteLength, header.byteLength, false);
  prefix.set(header, prefixSize);
  const reader = raw.getReader();
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controller.enqueue(prefix);
      },
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            reader.releaseLock();
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          reader.releaseLock();
          throw error;
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, length: (rawSize: number) => prefix.byteLength + rawSize };
}

export function parseInbound(plaintext: Uint8Array) {
  if (!magic.every((byte, index) => plaintext[index] === byte)) {
    throw new InboundFrameError({ message: "Unsupported inbound frame version or magic." });
  }
  if (plaintext.byteLength < prefixSize) {
    throw new InboundFrameError({ message: "Truncated inbound frame length." });
  }
  const headerSize = new DataView(
    plaintext.buffer,
    plaintext.byteOffset,
    plaintext.byteLength,
  ).getUint32(magic.byteLength, false);
  if (headerSize > maxInboundHeaderSize) {
    throw new InboundFrameError({ message: "Inbound envelope exceeds 16 KiB." });
  }
  const rawOffset = prefixSize + headerSize;
  if (plaintext.byteLength < rawOffset) {
    throw new InboundFrameError({ message: "Truncated inbound envelope." });
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        plaintext.subarray(prefixSize, rawOffset),
      ),
    );
  } catch {
    throw new InboundFrameError({ message: "Invalid inbound envelope JSON or UTF-8." });
  }
  if (plaintext.byteLength - rawOffset > maxMessageSize) {
    throw new InboundFrameError({ message: "Raw MIME body exceeds 25 MiB." });
  }
  return { envelope: validateEnvelope(envelope), raw: plaintext.subarray(rawOffset) };
}
