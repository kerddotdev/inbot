import { Buffer } from "node:buffer";
import { expect, test, vi } from "vitest";
import { decrypt, encrypt, generateIdentity, maxMessageSize } from "./index.js";

function stream(bytes: Uint8Array, chunkSize = 8191): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset = Math.min(offset + chunkSize, bytes.byteLength);
    },
  });
}

test.each([0, 1, 65535, 65536, 65537, 5 * 1024 * 1024])(
  "roundtrips %i bytes from streams with the exact predicted ciphertext length",
  async (size) => {
    const { identity, recipient } = await generateIdentity();
    expect(identity).toMatch(/^AGE-SECRET-KEY-1/);
    expect(recipient).toMatch(/^age1/);
    const plaintext = Uint8Array.from({ length: size }, (_, index) => index % 251);
    const encrypted = await encrypt(recipient, stream(plaintext));
    const expectedLength = encrypted.size(size);
    const ciphertext = new Uint8Array(await new Response(encrypted).arrayBuffer());
    expect(ciphertext.byteLength).toBe(expectedLength);
    const payloadSize = size + 16 + 16 * Math.max(1, Math.ceil(size / 65536));
    const header = new TextDecoder().decode(
      ciphertext.subarray(0, ciphertext.length - payloadSize),
    );
    expect(header).toMatch(/^age-encryption\.org\/v1\n-> X25519 /);
    expect(header).toMatch(/\n--- [A-Za-z0-9+/]{43}\n$/);
    expect(Buffer.compare(await decrypt(identity, stream(ciphertext, 113)), plaintext)).toBe(0);
    expect(Buffer.compare(await decrypt(identity, ciphertext), plaintext)).toBe(0);
  },
);

test("supports byte input and hides a known plaintext marker", async () => {
  const { identity, recipient } = await generateIdentity();
  const marker = "From: synthetic-sender@example.invalid\r\nSubject: private subject\r\n";
  const plaintext = new TextEncoder().encode(marker.repeat(100));
  const ciphertext = await encrypt(recipient, plaintext);
  expect(new TextDecoder().decode(ciphertext)).not.toContain(marker);
  expect(Buffer.compare(await decrypt(identity, ciphertext), plaintext)).toBe(0);
});

test("rejects a different identity and tampered or truncated ciphertext", async () => {
  const { identity, recipient } = await generateIdentity();
  const wrong = await generateIdentity();
  const ciphertext = await encrypt(
    recipient,
    new TextEncoder().encode("synthetic private message"),
  );
  await expect(decrypt(wrong.identity, ciphertext)).rejects.toThrow();
  const tampered = ciphertext.slice();
  tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
  await expect(decrypt(identity, tampered)).rejects.toThrow();
  await expect(decrypt(identity, ciphertext.subarray(0, -1))).rejects.toThrow();
});

test("encrypts before EOF, limits output chunks, and propagates cancellation", async () => {
  const { recipient } = await generateIdentity();
  const cancelled = Promise.withResolvers<void>();
  const cancel = vi.fn(() => cancelled.resolve());
  let reads = 0;
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array(5 * 1024 * 1024));
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const encrypted = await encrypt(recipient, source);
  const reader = encrypted.getReader();
  expect((await reader.read()).value?.byteLength).toBeLessThan(1024);
  expect((await reader.read()).value?.byteLength).toBe(16);
  for (let index = 0; index < 3; index += 1) {
    expect((await reader.read()).value?.byteLength).toBe(65552);
  }
  expect(reads).toBe(1);
  await reader.cancel();
  await cancelled.promise;
  expect(cancel).toHaveBeenCalledOnce();
});

test("propagates plaintext stream failures", async () => {
  const { recipient } = await generateIdentity();
  const source = new ReadableStream<Uint8Array>({
    pull() {
      throw new Error("Synthetic input failure.");
    },
  });
  const encrypted = await encrypt(recipient, source);
  await expect(new Response(encrypted).arrayBuffer()).rejects.toThrow("Synthetic input failure.");
});

test("rejects non-X25519 recipients before consuming plaintext", async () => {
  const pull = vi.fn();
  const source = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
  await expect(encrypt("age1pq1invalid", source)).rejects.toThrow("X25519");
  expect(pull).not.toHaveBeenCalled();
});

test("rejects decryption beyond the service's 25 MiB limit", async () => {
  const { identity, recipient } = await generateIdentity();
  const chunk = new Uint8Array(65536);
  let remaining = maxMessageSize + 1;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      const length = Math.min(chunk.byteLength, remaining);
      controller.enqueue(chunk.subarray(0, length));
      remaining -= length;
    },
  });
  await expect(decrypt(identity, await encrypt(recipient, source))).rejects.toThrow(
    "exceeds 25 MiB",
  );
});
