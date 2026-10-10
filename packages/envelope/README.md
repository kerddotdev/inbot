# Envelope

`@inbot/envelope` implements binary age v1 envelopes with one X25519 recipient using `age-encryption` 0.3.1. It uses Web Crypto and Web Streams and has no Node-only runtime imports.

- `generateIdentity()` returns a secret `identity` and a public `recipient`. Keep the identity on the owner's machine.
- `encrypt(recipient, bytes)` returns ciphertext bytes. `encrypt(recipient, stream)` returns a real ciphertext stream with `size(plaintextLength)` after generating the header.
- `decrypt(identity, bytesOrStream)` returns authenticated plaintext bytes and rejects plaintext larger than 25 MiB. It buffers only on the service side and can temporarily retain about twice the plaintext size while assembling the result.
- `@inbot/envelope/pointer` exports the Effect `InboundPointer` schema, its inferred type, and `createInboundKey()`.

For strict pointer decoding, use `Schema.decodeUnknownSync(InboundPointer, { onExcessProperty: "error" })`. The pointer contains only `version`, `key`, ciphertext `size`, and a canonical ISO UTC `received_at`. Keys are `inbound/<UUIDv7>.age`, ordered by receipt millisecond, with 74 random bits from Web Crypto. Ordering within one millisecond is random.

Streaming is supported by the pinned library for both encryption and decryption. Input chunks are split into at most 64 KiB before reaching age: the library processes each incoming chunk synchronously and could otherwise enqueue a whole message's ciphertext before applying backpressure. The streaming path retains one incoming chunk plus a small number of 64 KiB buffers, rather than allocating a complete message. An unusually large upstream chunk still remains resident until consumed. Exact Workers isolate memory usage has not been measured.

The library's `stream.size(n)` uses the actual generated header length, a 16-byte payload nonce, and `n + 16 * max(1, ceil(n / 65536))` payload bytes. Empty input has one authentication tag; an exact 64 KiB multiple has no extra empty final chunk. The Worker passes this result to `FixedLengthStream` so R2 receives a body with a known length. Tests compare the predicted size with real ciphertext at 0, 1, 65535, 65536, 65537, and 5 MiB, and verify decryption across irregular input chunks.

References: [pinned age README](https://github.com/FiloSottile/typage/blob/v0.3.1/README.md), [age v1 specification](https://age-encryption.org/v1).
