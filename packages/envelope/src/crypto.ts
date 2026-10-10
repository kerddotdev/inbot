import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import type { ReadableStreamWithSize } from "age-encryption";
import { maxInboundFrameOverhead, maxMessageSize } from "./frame.js";

const chunkSize = 64 * 1024;

export async function generateIdentity() {
  const identity = await generateX25519Identity();
  return { identity, recipient: await identityToRecipient(identity) };
}

function chunkStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let pending: Uint8Array = new Uint8Array(0);
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          while (pending.byteLength === 0) {
            const next = await reader.read();
            if (next.done) {
              reader.releaseLock();
              controller.close();
              return;
            }
            pending = next.value;
          }
          controller.enqueue(pending.subarray(0, chunkSize));
          pending =
            pending.byteLength > chunkSize ? pending.subarray(chunkSize) : new Uint8Array(0);
        } catch (error) {
          reader.releaseLock();
          throw error;
        }
      },
      async cancel(reason) {
        pending = new Uint8Array(0);
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    },
    { highWaterMark: 0 },
  );
}

export function encrypt(recipient: string, plaintext: Uint8Array): Promise<Uint8Array>;
export function encrypt(
  recipient: string,
  plaintext: ReadableStream<Uint8Array>,
): Promise<ReadableStreamWithSize>;
export function encrypt(
  recipient: string,
  plaintext: ReadableStream<Uint8Array> | Uint8Array,
): Promise<ReadableStreamWithSize | Uint8Array>;
export async function encrypt(
  recipient: string,
  plaintext: ReadableStream<Uint8Array> | Uint8Array,
) {
  if (!/^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/.test(recipient)) {
    throw new Error("An X25519 age recipient is required.");
  }
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  return plaintext instanceof Uint8Array
    ? encrypter.encrypt(plaintext)
    : encrypter.encrypt(chunkStream(plaintext));
}

export async function decrypt(
  identity: string,
  ciphertext: ReadableStream<Uint8Array> | Uint8Array,
): Promise<Uint8Array> {
  if (!identity.startsWith("AGE-SECRET-KEY-1")) {
    throw new Error("An X25519 age identity is required.");
  }
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  const source =
    ciphertext instanceof Uint8Array
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(ciphertext);
            controller.close();
          },
        })
      : ciphertext;
  const reader = (await decrypter.decrypt(chunkStream(source))).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxMessageSize + maxInboundFrameOverhead) {
        await reader.cancel();
        throw new Error("Decrypted message exceeds 25 MiB plus inbound frame overhead.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const plaintext = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    plaintext.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return plaintext;
}
