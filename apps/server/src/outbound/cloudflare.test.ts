import { Effect, Schema } from "effect";
import { expect, test, vi } from "vitest";
import { compose } from "./compose.js";
import { OutboundProvider, ProviderMessage } from "./cloudflare.js";

const message = compose("agent@example.test", {
  kind: "send",
  request: {
    to: "Reader <reader@example.test>",
    cc: "cc@example.test",
    bcc: "bcc@example.test",
    reply_to: "reply@example.test",
    subject: "Synthetic subject",
    text: "Synthetic body",
    html: "<p>Synthetic body</p>",
    headers: { "X-Trace": "synthetic" },
    attachments: [{ content: "YQ==", filename: "data.txt", content_type: "text/plain" }],
  },
}).provider;

function send(fetch: typeof globalThis.fetch, timeout = 30_000) {
  return OutboundProvider.use((provider) => provider.send(message)).pipe(
    Effect.provide(
      OutboundProvider.live({
        account_id: "synthetic-account",
        api_token: "synthetic-token",
        fetch,
        timeout_ms: timeout,
      }),
    ),
  );
}

test("the REST adapter constructs authenticated requests and decodes result.message_id", async () => {
  const fetch: typeof globalThis.fetch = async (url, init) => {
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/synthetic-account/email/sending/send",
    );
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).has("Authorization")).toBe(true);
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (typeof init?.body !== "string") throw new Error("Expected JSON body");
    const body = Schema.decodeUnknownSync(ProviderMessage)(JSON.parse(init.body));
    expect(body).toEqual(message);
    expect(body.to).toEqual([{ address: "reader@example.test", name: "Reader" }]);
    expect(body.reply_to).toBe("reply@example.test");
    expect(body.attachments[0]).toEqual({
      content: "YQ==",
      filename: "data.txt",
      type: "text/plain",
      disposition: "attachment",
    });
    expect(body.headers["Message-ID"]).toBeUndefined();
    return Response.json({
      success: true,
      result: {
        message_id: "<provider@example.test>",
        delivered: [],
        queued: ["reader@example.test"],
        permanent_bounces: [],
        suppressed_recipients: [],
      },
    });
  };
  expect(await Effect.runPromise(send(fetch))).toEqual({
    provider_message_id: "<provider@example.test>",
  });
});

test.each([
  { status: 400, providerCode: 10001, errorCode: "validation_error", retryable: false },
  {
    status: 400,
    providerCode: "E_HEADER_NOT_ALLOWED",
    errorCode: "validation_error",
    retryable: false,
  },
  {
    status: 403,
    providerCode: "E_SENDER_NOT_VERIFIED",
    errorCode: "domain_not_verified",
    retryable: false,
  },
  { status: 400, providerCode: 10200, errorCode: "payload_too_large", retryable: false },
  { status: 401, providerCode: 10101, errorCode: "unauthorized", retryable: false },
  { status: 403, providerCode: 10102, errorCode: "missing_permission", retryable: false },
  { status: 429, providerCode: 10004, errorCode: "rate_limit_exceeded", retryable: true },
  { status: 500, providerCode: 10002, errorCode: "service_unavailable", retryable: true },
  { status: 503, providerCode: 10100, errorCode: "service_unavailable", retryable: true },
])(
  "maps HTTP $status/$providerCode without retaining provider content",
  async ({ status, providerCode, errorCode, retryable }) => {
    const fetch: typeof globalThis.fetch = async () =>
      Response.json(
        {
          success: false,
          errors: [{ code: providerCode, message: "private body synthetic-token" }],
          result: null,
        },
        { status },
      );
    const error = await Effect.runPromise(Effect.flip(send(fetch)));
    expect(error).toMatchObject({ code: errorCode, retryable });
    expect(JSON.stringify(error)).not.toContain("private body");
    expect(JSON.stringify(error)).not.toContain("synthetic-token");
  },
);

test("rate-limit and quota errors respect Retry-After seconds and HTTP dates", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-10-10T12:00:00Z") });
  try {
    for (const header of ["120", new Date(Date.now() + 120_000).toUTCString()]) {
      const fetch: typeof globalThis.fetch = async () =>
        Response.json(
          { success: false, errors: [{ code: "E_DAILY_LIMIT", message: "quota" }] },
          { status: 429, headers: { "Retry-After": header } },
        );
      const error = await Effect.runPromise(Effect.flip(send(fetch)));
      expect(error.retry_after_ms).toBeGreaterThan(118_000);
      expect(error.retry_after_ms).toBeLessThanOrEqual(120_000);
    }
  } finally {
    vi.useRealTimers();
  }
});

test("network loss and a successful response missing its id report an unknown outcome", async () => {
  const network: typeof globalThis.fetch = async () => {
    throw new Error("private body synthetic-token");
  };
  const missing: typeof globalThis.fetch = async () =>
    Response.json({ success: true, result: { queued: ["reader@example.test"] } });
  const invalid: typeof globalThis.fetch = async () =>
    new Response("private body", { status: 200 });
  for (const fetch of [network, missing, invalid]) {
    const error = await Effect.runPromise(Effect.flip(send(fetch)));
    expect(error.outcome_unknown).toBe(true);
    expect(JSON.stringify(error)).not.toContain("private body");
  }
});

test("a timeout aborts the fetch and never includes private request details", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-10-10T12:00:00Z") });
  try {
    let aborted = false;
    const fetch: typeof globalThis.fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("private body"));
          },
          { once: true },
        );
      });
    const result = Effect.runPromise(Effect.flip(send(fetch, 100)));
    await vi.advanceTimersByTimeAsync(100);
    const error = await result;
    expect(aborted).toBe(true);
    expect(error).toMatchObject({
      code: "service_unavailable",
      retryable: true,
      outcome_unknown: true,
    });
    expect(JSON.stringify(error)).not.toContain("private body");
  } finally {
    vi.useRealTimers();
  }
});

test("BCC-only requests omit empty fields and use REST content_id for inline attachments", async () => {
  const outgoing = compose("agent@example.test", {
    kind: "send",
    request: {
      bcc: "reader@example.test",
      text: "Body",
      html: '<img src="cid:logo">',
      attachments: [
        {
          content: "YQ==",
          filename: "logo.png",
          content_type: "image/png",
          content_disposition: "inline",
          content_id: "logo",
        },
      ],
    },
  }).provider;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    if (typeof init?.body !== "string") throw new Error("Expected JSON body");
    const body: unknown = JSON.parse(init.body);
    expect(body).toEqual({
      from: "agent@example.test",
      bcc: ["reader@example.test"],
      subject: "",
      text: "Body",
      html: '<img src="cid:logo">',
      attachments: [
        {
          content: "YQ==",
          filename: "logo.png",
          type: "image/png",
          disposition: "inline",
          content_id: "logo",
        },
      ],
    });
    return Response.json({ success: true, result: { message_id: "<inline@example.test>" } });
  };
  expect(
    await Effect.runPromise(
      OutboundProvider.use((provider) => provider.send(outgoing)).pipe(
        Effect.provide(
          OutboundProvider.live({ account_id: "synthetic", api_token: "synthetic", fetch }),
        ),
      ),
    ),
  ).toEqual({ provider_message_id: "<inline@example.test>" });
});
