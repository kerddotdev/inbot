import { Effect, Redacted } from "effect";
import { expect, test } from "vitest";
import {
  InboundBuffer,
  batchSize,
  decodeQueueBody,
  maxCiphertextSize,
  visibilityTimeoutMs,
} from "./cloudflare.js";
const base = "https://api.cloudflare.com/client/v4/accounts/synthetic-account";
const key = "inbound/01a1269c-73cc-7dd9-8d18-000000000001.age";
const pointer = { version: 1, key, size: 5118, received_at: "2026-10-10T12:00:00.000Z" };
const message = {
  id: "synthetic-message",
  timestamp_ms: 1791649150589,
  body: JSON.stringify(pointer),
  attempts: 0,
  metadata: { "CF-Content-Type": "json" },
  lease_id: "synthetic-lease",
};

function client(fetch: typeof globalThis.fetch) {
  const layer = InboundBuffer.live({
    account_id: "synthetic-account",
    bucket: "synthetic-bucket",
    api_token: Redacted.make("synthetic-token"),
    fetch,
  });
  return <A, E>(use: (buffer: typeof InboundBuffer.Service) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.flatMap(InboundBuffer, use).pipe(Effect.provide(layer)));
}

test("constructs documented pull, ack and retry requests with the captured queue result shape", async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const run = client(async (input, init) => {
    requests.push({ url: String(input), init });
    return Response.json({
      success: true,
      errors: [],
      messages: [],
      result: String(input).endsWith("/pull")
        ? {
            message_backlog_count: 1,
            messages: [message],
            metadata: {
              metrics: {
                backlog_count: 1,
                backlog_bytes: 123,
                oldest_message_timestamp_ms: 1791649150589,
              },
            },
          }
        : { ackCount: 1, retryCount: 1, warnings: [] },
    });
  });
  expect(await run((buffer) => buffer.pull("inbound queue"))).toEqual([
    { id: message.id, body: message.body, lease_id: message.lease_id, attempts: 0 },
  ]);
  await run((buffer) => buffer.ack("inbound queue", message.lease_id));
  await run((buffer) => buffer.retry("events queue", message.lease_id, 60));
  expect(requests.map((entry) => entry.url)).toEqual([
    `${base}/queues/inbound%20queue/messages/pull`,
    `${base}/queues/inbound%20queue/messages/ack`,
    `${base}/queues/events%20queue/messages/ack`,
  ]);
  expect(requests.map((entry) => JSON.parse(String(entry.init?.body)))).toEqual([
    { batch_size: batchSize, visibility_timeout_ms: visibilityTimeoutMs },
    { acks: [{ lease_id: message.lease_id }], retries: [] },
    { acks: [], retries: [{ lease_id: message.lease_id, delay_seconds: 60 }] },
  ]);
  for (const { init } of requests) {
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-token");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  }
});

test("uses literal object path slashes and documented R2 list metadata and pagination", async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const run = client(async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (init?.method === "DELETE") return Response.json({ success: true, result: { key } });
    if (url.includes("?"))
      return Response.json({
        success: true,
        result: [{ key, size: 5118, last_modified: pointer.received_at, etag: "synthetic-etag" }],
        result_info: { cursor: "next/+cursor", is_truncated: true },
      });
    return new Response(new Uint8Array([1, 2, 3]));
  });
  expect(await run((buffer) => buffer.getObject("inbound/name +.age"))).toEqual(
    new Uint8Array([1, 2, 3]),
  );
  expect(await run((buffer) => buffer.listObjects("inbound/", "previous/+cursor"))).toEqual({
    objects: [{ key, size: 5118, last_modified: pointer.received_at }],
    cursor: "next/+cursor",
  });
  await run((buffer) => buffer.deleteObject(key));
  expect(requests[0]?.url).toBe(
    `${base}/r2/buckets/synthetic-bucket/objects/inbound/name%20%2B.age`,
  );
  const listUrl = new URL(requests[1]?.url ?? "");
  expect(listUrl.pathname).toBe(
    "/client/v4/accounts/synthetic-account/r2/buckets/synthetic-bucket/objects",
  );
  expect(Object.fromEntries(listUrl.searchParams)).toEqual({
    prefix: "inbound/",
    cursor: "previous/+cursor",
    per_page: "1000",
  });
  expect(requests[2]?.url).toBe(`${base}/r2/buckets/synthetic-bucket/objects/${key}`);
  expect(requests.map((entry) => entry.init?.method)).toEqual(["GET", "GET", "DELETE"]);
  for (const { init } of requests)
    expect(new Headers(init?.headers).has("Authorization")).toBe(true);
});

test("decodes live plain JSON and the documented base64 JSON encoding", () => {
  expect(decodeQueueBody(JSON.stringify(pointer))).toEqual(pointer);
  expect(decodeQueueBody(Buffer.from(JSON.stringify(pointer)).toString("base64"))).toEqual(pointer);
  expect(() => decodeQueueBody("not JSON")).toThrow();
});

test("sanitizes provider failures, rejects invalid responses and treats missing deletion as idempotent", async () => {
  const unavailable = client(async () => {
    throw new Error("private payload and credential");
  });
  await expect(unavailable((buffer) => buffer.pull("queue"))).rejects.toMatchObject({
    code: "buffer_unavailable",
  });
  const invalid = client(async () =>
    Response.json({ success: true, result: { messages: [{ body: "private payload" }] } }),
  );
  await expect(invalid((buffer) => buffer.pull("queue"))).rejects.toMatchObject({
    code: "buffer_unavailable",
  });
  const missing = client(async () => new Response(null, { status: 404 }));
  await expect(missing((buffer) => buffer.getObject(key))).rejects.toMatchObject({
    code: "object_missing",
  });
  await expect(missing((buffer) => buffer.deleteObject(key))).resolves.toBeUndefined();
  const error = client(async () =>
    Response.json({ success: false, errors: [{ message: "private" }] }, { status: 429 }),
  );
  await expect(error((buffer) => buffer.ack("queue", "lease"))).rejects.toMatchObject({
    code: "buffer_unavailable",
  });
});

test("rejects oversized objects before buffering their body and cancels an oversized stream", async () => {
  const header = client(
    async () =>
      new Response(null, { headers: { "Content-Length": String(maxCiphertextSize + 1) } }),
  );
  await expect(header((buffer) => buffer.getObject(key))).rejects.toMatchObject({
    code: "object_too_large",
  });
  let cancelled = false;
  const stream = client(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(maxCiphertextSize + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await expect(stream((buffer) => buffer.getObject(key))).rejects.toMatchObject({
    code: "object_too_large",
  });
  expect(cancelled).toBe(true);
});

test("rejects a truncated list without a usable advancing cursor", async () => {
  const run = client(async () =>
    Response.json({
      success: true,
      result: [],
      result_info: { is_truncated: true, cursor: "same" },
    }),
  );
  await expect(run((buffer) => buffer.listObjects("inbound/", "same"))).rejects.toMatchObject({
    code: "buffer_unavailable",
  });
});

test("does not report an ack or retry as successful unless the lease count confirms it", async () => {
  const run = client(async () =>
    Response.json({
      success: true,
      result: { ackCount: 0, retryCount: 0, warnings: ["expired lease"] },
    }),
  );
  await expect(run((buffer) => buffer.ack("queue", "lease"))).rejects.toMatchObject({
    code: "buffer_unavailable",
  });
  await expect(run((buffer) => buffer.retry("queue", "lease", 5))).rejects.toMatchObject({
    code: "buffer_unavailable",
  });
});
