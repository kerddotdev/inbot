import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clock, Effect, Layer, Schema } from "effect";
import { expect, test as baseTest } from "vitest";
import { Home } from "../home.js";
import { Mailbox, type MailboxService } from "../mailbox/mailbox.js";
import { Store } from "../store.js";
import { authenticateInbound } from "./authentication.js";
import { extractInbound } from "./extract.js";
import { ingestInbound, InboundRecipientResult, MAX_INBOUND_BYTES } from "./ingest.js";
import { parseInbound } from "./parse.js";
import { InboundPayload, type InboundInput } from "./payload.js";

const receivedAt = "2026-10-10T12:00:00.000Z";
const now = Date.parse(receivedAt);
const clock: Clock.Clock = {
  currentTimeMillisUnsafe: () => now,
  currentTimeMillis: Effect.succeed(now),
  currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(now) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => 0n,
  monotonicTimeNanos: Effect.succeed(0n),
  sleep: () => Effect.succeed(undefined),
};

const test = baseTest.extend<{ home: string; key: Uint8Array }>({
  home: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-inbound-test-"));
    try {
      await use(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  key: async ({ home: _home }, use) => {
    const key = randomBytes(32);
    try {
      await use(key);
    } finally {
      key.fill(0);
    }
  },
});

function withMailbox<A, E>(
  home: string,
  key: Uint8Array,
  use: (mailbox: MailboxService) => Effect.Effect<A, E, Mailbox>,
) {
  const store = Store.layer(key).pipe(
    Layer.provide(Home.layer({ flag: home, flavor: "development" })),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* Mailbox);
    }).pipe(
      Effect.provide(Mailbox.Live.pipe(Layer.provide(store))),
      Effect.provideService(Clock.Clock, clock),
    ),
  );
}

function mime(headers: readonly string[], body: string) {
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body.replace(/\r?\n/g, "\r\n")}`);
}

function payload(
  raw: Uint8Array,
  recipients: readonly string[] = ["agent@example.test"],
): InboundInput {
  return { mail_from: "alice@example.test", rcpt_to: recipients, raw, received_at: receivedAt };
}

function stored(results: readonly InboundRecipientResult[], index = 0) {
  const result = results[index];
  if (result?.status !== "stored") throw new Error("Expected a stored delivery.");
  return result;
}

const alternative = mime(
  [
    "Message-ID: <original@example.test>",
    "From: Alice Example <alice@example.test>",
    "Reply-To: Support Team <support@example.test>, backup@example.test",
    "To: Agent <agent@example.test>, Team: second@example.test, Third <third@example.test>;",
    "Cc: reviewer@example.test",
    "Subject: Project update",
    "Date: Sat, 10 Oct 2026 10:00:00 +0200",
    "List-ID: Project Updates <updates.example.test>",
    "List-Unsubscribe: <mailto:unsubscribe@example.test>",
    "Auto-Submitted: no",
    "Authentication-Results: mx.receiver.test; spf=pass smtp.mailfrom=example.test",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="alternative"',
  ],
  `--alternative
Content-Type: text/plain; charset=utf-8

Project update.

Best,
Alice
--alternative
Content-Type: text/html; charset=utf-8

<p>Project update.</p><p>Best,<br>Alice</p>
--alternative--`,
);

const mixed = mime(
  [
    "Message-ID: <attachments@example.test>",
    "From: alice@example.test",
    "To: agent@example.test",
    "Subject: Synthetic attachments",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="mixed"',
  ],
  `--mixed
Content-Type: text/html; charset=utf-8

<p>See the report.</p><img src="cid:logo@example.test">
--mixed
Content-Type: application/pdf
Content-Disposition: attachment; filename="report.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQKAP8=
--mixed
Content-Type: image/png
Content-Disposition: inline; filename="logo.png"
Content-ID: <logo@example.test>
Content-Transfer-Encoding: base64

iVBORw0KGgoAAf8=
--mixed--`,
);

const quotedPrintable = mime(
  [
    "Message-ID: encoded@example.test",
    "From: =?UTF-8?Q?J=C3=B6rg_Example?= <joerg@example.test>",
    "To: agent@example.test",
    "Subject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe_aus_K=C3=B6ln?=",
    "In-Reply-To: original@example.test",
    "References: <older@example.test> original@example.test",
    " <original@example.test>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
  ],
  "Gr=C3=BC=C3=9Fe aus K=C3=B6ln.\nA soft line=\n continues.\n",
);

test("parses alternatives, flattened addresses, dates and selected headers", async () => {
  const parsed = await parseInbound(alternative, receivedAt);
  expect(parsed).toMatchObject({
    message_id: "<original@example.test>",
    from: "Alice Example <alice@example.test>",
    reply_to: ["Support Team <support@example.test>", "backup@example.test"],
    to: ["Agent <agent@example.test>", "second@example.test", "Third <third@example.test>"],
    cc: ["reviewer@example.test"],
    subject: "Project update",
    date: "2026-10-10T08:00:00.000Z",
    references: [],
    headers: {
      "message-id": "<original@example.test>",
      date: "Sat, 10 Oct 2026 10:00:00 +0200",
      "list-id": "Project Updates <updates.example.test>",
      "list-unsubscribe": "<mailto:unsubscribe@example.test>",
      "auto-submitted": "no",
      "authentication-results": "mx.receiver.test; spf=pass smtp.mailfrom=example.test",
    },
  });
  expect(parsed.text?.trim()).toBe("Project update.\n\nBest,\nAlice");
  expect(parsed.html?.trim()).toBe("<p>Project update.</p><p>Best,<br>Alice</p>");
  expect(parsed.attachments).toEqual([]);
});

test("decodes RFC 2047 and quoted-printable and normalizes folded references", async () => {
  const parsed = await parseInbound(quotedPrintable, receivedAt);
  expect(parsed).toMatchObject({
    message_id: "<encoded@example.test>",
    from: "J\u00f6rg Example <joerg@example.test>",
    subject: "Gr\u00fc\u00dfe aus K\u00f6ln",
    text: "Gr\u00fc\u00dfe aus K\u00f6ln.\nA soft line continues.\n",
    in_reply_to: "<original@example.test>",
    references: ["<older@example.test>", "<original@example.test>"],
    headers: { "in-reply-to": "original@example.test" },
  });
  expect(parsed.headers.references).toContain("<older@example.test> original@example.test");
});

test("preserves binary PDF and inline image bytes and content ids", async () => {
  const parsed = await parseInbound(mixed, receivedAt);
  expect(parsed.attachments).toEqual([
    {
      filename: "report.pdf",
      content_type: "application/pdf",
      content_disposition: "attachment",
      content: new Uint8Array(Buffer.from("%PDF-1.4\n\x00\xff", "latin1")),
    },
    {
      filename: "logo.png",
      content_type: "image/png",
      content_disposition: "inline",
      content_id: "<logo@example.test>",
      content: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 255]),
    },
  ]);
});

test("treats a nested message as an attachment without borrowing its sender or authentication", async () => {
  const raw = mime(
    [
      "From: outer@example.test",
      "To: agent@example.test",
      'Content-Type: multipart/mixed; boundary="nested"',
    ],
    `--nested
Content-Type: text/plain

Outer content
--nested
Content-Type: message/rfc822

From: inner@example.test
Authentication-Results: forged.test; dmarc=pass

Inner content
--nested--`,
  );
  const parsed = await parseInbound(raw, receivedAt);
  expect(parsed.from).toBe("outer@example.test");
  expect(parsed.text?.trim()).toBe("Outer content");
  expect(parsed.authentication_results).toEqual([]);
  expect(parsed.attachments[0]?.content_type).toBe("message/rfc822");
});

test.each([undefined, "not a date"])("falls back to received time for date %s", async (date) => {
  const raw = mime(date === undefined ? [] : [`Date: ${date}`], "New content");
  expect((await parseInbound(raw, receivedAt)).date).toBe(receivedAt);
});

test("synthesizes an identity from the exact raw bytes independently of receipt time", async () => {
  const raw = mime(["From: alice@example.test"], "No message identifier");
  const expected = `<${createHash("sha256").update(raw).digest("hex")}@inbot.invalid>`;
  expect((await parseInbound(raw, receivedAt)).message_id).toBe(expected);
  expect((await parseInbound(raw, "2026-10-11T12:00:00Z")).message_id).toBe(expected);
  expect(
    (await parseInbound(Buffer.concat([raw, Buffer.from("changed")]), receivedAt)).message_id,
  ).not.toBe(expected);
});

const newReply = "Agreed, please proceed.\n\n-- \nAlice Example\nEngineer";
const oldContent = "Previous message content";
const replies = [
  ["English", "On Sat, Oct 10, 2026, Bob <bob@example.test> wrote:"],
  ["German", "Am 10.10.2026 um 10:00 schrieb Bob <bob@example.test>:"],
  ["French", "Le 10 octobre 2026, Bob <bob@example.test> a \u00e9crit :"],
  ["Spanish", "El 10 de octubre de 2026, Bob <bob@example.test> escribi\u00f3:"],
  ["Hungarian", "2026. okt\u00f3ber 10. napon Bob <bob@example.test> ezt \u00edrta:"],
  ["Hungarian ASCII", "2026. okt. 10. napon Bob <bob@example.test> ezt irta:"],
  ["Outlook divider", "-----Original Message-----"],
  [
    "Outlook headers",
    "From: Bob <bob@example.test>\nSent: Saturday, October 10, 2026\nTo: Alice\nSubject: Original message",
  ],
];

test.each(replies)(
  "extracts a %s reply and retains the sender signature",
  async (_style, attribution) => {
    const raw = mime(
      ["Content-Type: text/plain; charset=utf-8"],
      `${newReply}\n\n${attribution}\n> ${oldContent}\n> Earlier history`,
    );
    const parsed = await parseInbound(raw, receivedAt);
    expect(extractInbound(parsed).extracted_text).toBe(newReply);
    expect(parsed.text).toContain(oldContent);
  },
);

test("strips a trailing single quoted line", () => {
  expect(extractInbound({ text: `${newReply}\n\n> ${oldContent}` }).extracted_text).toBe(newReply);
});

test("strips mobile and legal boilerplate while keeping a personal signature", () => {
  expect(extractInbound({ text: `${newReply}\n\nSent from my iPhone` }).extracted_text).toBe(
    newReply,
  );
  expect(
    extractInbound({ text: `${newReply}\n\nThis email is confidential.\nLegal footer` })
      .extracted_text,
  ).toBe(newReply);
});

test.each([
  '<div class="gmail_quote"><div>On Sat Bob wrote:</div><blockquote>Previous message content</blockquote></div>',
  "<blockquote>Previous message content</blockquote>",
  "<div>2026. okt. 10. napon Bob ezt \u00edrta:</div><div>Previous message content</div>",
])("extracts HTML history and keeps the new reply and signature: %s", async (history) => {
  const html = `<div>Agreed, please proceed.</div><div>Best,<br>Alice Example</div>`;
  const raw = mime(["Content-Type: text/html; charset=utf-8"], html + history);
  const parsed = await parseInbound(raw, receivedAt);
  expect(extractInbound(parsed).extracted_html).toBe(html);
  expect(parsed.html).toContain(oldContent);
});

test.each(["On Sat Bob wrote:", "2026. okt. 10. napon Bob ezt \u00edrta:"])(
  "keeps a recognizable signature following quoted history: %s",
  (attribution) => {
    expect(
      extractInbound({
        text: `Agreed.\n\n${attribution}\n> Old message\n> Older message\n\n--\nAlice\nEngineer`,
      }).extracted_text,
    ).toBe("Agreed.\n\n--\nAlice\nEngineer");
    expect(
      extractInbound({
        html: `<p>Agreed.</p><div>${attribution}</div><blockquote>Old message</blockquote><div class="gmail_signature">Best,<br>Alice</div>`,
      }).extracted_html,
    ).toBe('<p>Agreed.</p><div class="gmail_signature">Best,<br>Alice</div>');
  },
);

test("preserves absent and empty bodies without inventing a representation", () => {
  expect(extractInbound({})).toEqual({});
  expect(extractInbound({ text: "", html: "" })).toEqual({
    extracted_text: "",
    extracted_html: "",
  });
});

test.each(["spf", "dkim", "dmarc"])("accepts a trusted %s pass", (method) => {
  expect(authenticateInbound([`mx.receiver.test; ${method}=pass`], ["mx.receiver.test"])).toBe(
    "pass",
  );
});

test("labels missing, failing, neutral and unsupported authentication as unauthenticated", () => {
  for (const headers of [
    [],
    ["mx.receiver.test; spf=fail; dkim=fail; dmarc=fail"],
    ["mx.receiver.test; spf=neutral; dkim=none; dmarc=temperror"],
    ["mx.receiver.test; arc=pass"],
  ])
    expect(authenticateInbound(headers)).toBe("unauthenticated");
});

test("trusts only the topmost header by default and ignores a forged second pass", () => {
  const headers = ["mx.receiver.test; spf=fail", "attacker.test; spf=pass; dkim=pass; dmarc=pass"];
  expect(authenticateInbound(headers)).toBe("unauthenticated");
  expect(authenticateInbound(headers, ["mx.receiver.test"])).toBe("unauthenticated");
  expect(authenticateInbound(["mx.receiver.test; spf=pass", "attacker.test; spf=fail"])).toBe(
    "pass",
  );
});

test("matches configured authserv ids exactly and accepts a trusted later result", () => {
  expect(
    authenticateInbound(
      [
        "attacker.test; spf=pass",
        "MX.RECEIVER.TEST (receiver) 1; DKIM/1=PASS header.d=example.test",
      ],
      ["mx.receiver.test"],
    ),
  ).toBe("pass");
  expect(
    authenticateInbound(["mx.receiver.test.attacker.test; spf=pass"], ["mx.receiver.test"]),
  ).toBe("unauthenticated");
  expect(authenticateInbound(['"mx.receiver.test"; spf=pass'], ["MX.RECEIVER.TEST"])).toBe("pass");
});

test("does not interpret comments, quoted reasons or malformed headers as passing results", () => {
  for (const header of [
    "mx.receiver.test; spf=fail (dkim=pass; dmarc=pass)",
    'mx.receiver.test; spf=fail reason="rejected; dkim=pass"',
    "mx.receiver.test; spf=fail smtp.mailfrom=pass",
    "mx.receiver.test; spf=passer",
    "mx.receiver.test; spf=pass (unterminated",
    'mx.receiver.test; spf=fail reason="unterminated; dkim=pass',
  ])
    expect(authenticateInbound([header])).toBe("unauthenticated");
  expect(authenticateInbound(["mx.receiver.test; spf (nested (comment; dkim=fail)) = pass"])).toBe(
    "pass",
  );
});

test("retains authentication header order and values through MIME parsing", async () => {
  const headers = ["mx.receiver.test; spf=fail", "attacker.test; dmarc=pass"];
  const parsed = await parseInbound(
    mime(
      headers.map((value) => `Authentication-Results: ${value}`),
      "Synthetic message",
    ),
    receivedAt,
  );
  expect(parsed.authentication_results).toEqual(headers);
  expect(parsed.headers["authentication-results"]).toBe(headers.join("\n"));
  expect(authenticateInbound(parsed.authentication_results)).toBe("unauthenticated");
});

test("decodes the envelope independently of raw bytes and validates received_at", () => {
  const metadata = Schema.decodeUnknownSync(InboundPayload)(payload(alternative));
  expect(metadata).toEqual({
    mail_from: "alice@example.test",
    rcpt_to: ["agent@example.test"],
    received_at: receivedAt,
  });
  expect(() =>
    Schema.decodeUnknownSync(InboundPayload)({ ...metadata, received_at: "invalid" }),
  ).toThrow();
});

test("stores MIME fields, extracted bodies, raw bytes and attachment bytes in the encrypted store", async ({
  home,
  key,
}) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      yield* mailbox.createInbox({ username: "agent", domain: "example.test" });
      const identity = stored(yield* ingestInbound(payload(alternative)));
      const message = yield* mailbox.getMessage(identity.recipient, identity.message_id);
      expect(message).toMatchObject({
        message_id: "<original@example.test>",
        from: "Alice Example <alice@example.test>",
        reply_to: ["Support Team <support@example.test>", "backup@example.test"],
        timestamp: "2026-10-10T08:00:00.000Z",
        extracted_text: "Project update.\n\nBest,\nAlice",
        extracted_html: "<p>Project update.</p><p>Best,<br>Alice</p>",
        size: alternative.byteLength,
      });
      expect(message.labels).toEqual(expect.arrayContaining(["received", "unread"]));
      expect(message.labels).not.toContain("unauthenticated");
      expect(yield* mailbox.getRawMessage(identity.recipient, identity.message_id)).toEqual(
        alternative,
      );
      const attachments = stored(yield* ingestInbound(payload(mixed)));
      const attachmentMessage = yield* mailbox.getMessage(
        attachments.recipient,
        attachments.message_id,
      );
      expect(attachmentMessage.timestamp).toBe(receivedAt);
      expect(attachmentMessage.labels).toContain("unauthenticated");
      for (const attachment of attachmentMessage.attachments ?? []) {
        const read = yield* mailbox.getAttachment(
          attachments.recipient,
          attachments.message_id,
          attachment.attachment_id,
        );
        const expected =
          attachment.filename === "report.pdf"
            ? Buffer.from("%PDF-1.4\n\x00\xff", "latin1")
            : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 255]);
        expect(read.content).toEqual(expected);
      }
      expect(attachmentMessage.attachments).toHaveLength(2);
    }),
  );
});

test("threads replies within each inbox and makes repeated multi-recipient ingestion idempotent", async ({
  home,
  key,
}) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      for (const username of ["agent", "second"])
        yield* mailbox.createInbox({ username, domain: "example.test" });
      const recipients = ["AGENT@EXAMPLE.TEST", "second@example.test"];
      const originals = yield* ingestInbound(payload(alternative, recipients));
      const first = stored(originals);
      const second = stored(originals, 1);
      expect(first.message_id).toBe(second.message_id);
      expect(first.thread_id).not.toBe(second.thread_id);
      const replyRaw = mime(
        [
          "Message-ID: <reply@example.test>",
          "From: bob@example.test",
          "To: unrelated@example.test",
          "In-Reply-To: <original@example.test>",
          "References: <older@example.test> <original@example.test>",
          "Date: Sat, 10 Oct 2026 11:00:00 +0200",
          "Content-Type: text/plain; charset=utf-8",
        ],
        `${newReply}\n\nOn Sat Alice wrote:\n> ${oldContent}`,
      );
      const replies = yield* ingestInbound(payload(replyRaw, recipients));
      expect(stored(replies).thread_id).toBe(first.thread_id);
      expect(stored(replies, 1).thread_id).toBe(second.thread_id);
      expect(yield* ingestInbound(payload(replyRaw, recipients))).toEqual(replies);
      expect(yield* ingestInbound(payload(alternative, recipients))).toEqual(originals);
      for (const original of [first, second]) {
        const messages = yield* mailbox.listMessages(original.recipient, {
          include_unauthenticated: true,
        });
        expect(messages.count).toBe(2);
        const thread = yield* mailbox.getThread(original.recipient, original.thread_id);
        expect(thread.message_count).toBe(2);
        expect(thread.received_timestamp).toBe("2026-10-10T09:00:00.000Z");
        expect(thread.sent_timestamp).toBeUndefined();
        const reply = yield* mailbox.getMessage(original.recipient, "<reply@example.test>");
        expect(reply.extracted_text).toBe(newReply);
        expect(reply.to).toEqual(["unrelated@example.test"]);
      }
    }),
  );
});

test("uses References when In-Reply-To is absent", async ({ home, key }) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      yield* mailbox.createInbox({ username: "agent", domain: "example.test" });
      const original = stored(yield* ingestInbound(payload(alternative)));
      const reply = stored(
        yield* ingestInbound(
          payload(
            mime(
              [
                "Message-ID: <references-only@example.test>",
                "References: <original@example.test> <unknown@example.test>",
              ],
              "References-only reply",
            ),
          ),
        ),
      );
      expect(reply.thread_id).toBe(original.thread_id);
    }),
  );
});

test("skips paused and unknown recipients and permits redelivery after resume", async ({
  home,
  key,
}) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      yield* mailbox.createInbox({ username: "agent", domain: "example.test" });
      yield* mailbox.createInbox({ username: "paused", domain: "example.test", status: "paused" });
      const results = yield* ingestInbound(
        payload(alternative, ["paused@example.test", "UNKNOWN@EXAMPLE.TEST", "AGENT@EXAMPLE.TEST"]),
      );
      expect(results).toEqual([
        { recipient: "paused@example.test", status: "skipped_paused" },
        { recipient: "unknown@example.test", status: "skipped_unknown" },
        {
          recipient: "agent@example.test",
          status: "stored",
          message_id: "<original@example.test>",
          thread_id: expect.any(String),
        },
      ]);
      expect(
        (yield* mailbox.listMessages("paused@example.test", { include_unauthenticated: true }))
          .count,
      ).toBe(0);
      expect((yield* mailbox.listInboxes()).count).toBe(2);
      yield* mailbox.updateInbox("paused@example.test", { status: "active" });
      expect(
        stored(yield* ingestInbound(payload(alternative, ["paused@example.test"]))).recipient,
      ).toBe("paused@example.test");
      expect((yield* mailbox.listMessages("paused@example.test")).count).toBe(1);
    }),
  );
});

test.for([
  {
    name: "pass",
    headers: ["Authentication-Results: mx.receiver.test; dkim=pass"],
    unauthenticated: false,
  },
  { name: "missing", headers: [], unauthenticated: true },
  {
    name: "all fail",
    headers: ["Authentication-Results: mx.receiver.test; spf=fail; dkim=fail; dmarc=fail"],
    unauthenticated: true,
  },
  {
    name: "forged second pass",
    headers: [
      "Authentication-Results: mx.receiver.test; spf=fail",
      "Authentication-Results: attacker.test; dmarc=pass",
    ],
    unauthenticated: true,
  },
])(
  "stores correct authentication labels for $name",
  async ({ headers, unauthenticated }, { home, key }) => {
    await withMailbox(home, key, (mailbox) =>
      Effect.gen(function* () {
        yield* mailbox.createInbox({ username: "agent", domain: "example.test" });
        const identity = stored(
          yield* ingestInbound(payload(mime(headers, "Synthetic authentication test"))),
        );
        const message = yield* mailbox.getMessage(identity.recipient, identity.message_id);
        expect(message.labels.includes("unauthenticated")).toBe(unauthenticated);
        expect(message.labels).toEqual(expect.arrayContaining(["received", "unread"]));
        expect((yield* mailbox.listMessages(identity.recipient)).count).toBe(
          unauthenticated ? 0 : 1,
        );
      }),
    );
  },
);

test.for([
  {
    name: "a forged passing trusted header below a failing trusted header",
    headers: [
      "mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail",
      "mx.cloudflare.net; dmarc=pass",
    ],
    unauthenticated: true,
  },
  {
    name: "a passing topmost trusted header",
    headers: ["mx.cloudflare.net; dkim=pass", "mx.cloudflare.net; dmarc=fail"],
    unauthenticated: false,
  },
  {
    name: "an unterminated trusted result above a forged pass",
    headers: ['mx.cloudflare.net; spf=fail reason="unterminated', "mx.cloudflare.net; dmarc=pass"],
    unauthenticated: true,
  },
  {
    name: "an invalid trusted comment above a forged pass",
    headers: ["mx.cloudflare.net; spf=pass )", "mx.cloudflare.net; dmarc=pass"],
    unauthenticated: true,
  },
  {
    name: "an untrusted header above a passing trusted header",
    headers: ["attacker.test; spf=fail", "mx.cloudflare.net; spf=pass"],
    unauthenticated: false,
  },
  {
    name: "an untrusted header above a failing trusted header and a forged pass",
    headers: [
      "attacker.test; spf=pass",
      "mx.cloudflare.net; spf=fail",
      "mx.cloudflare.net; dmarc=pass",
    ],
    unauthenticated: true,
  },
])(
  "preserves wire order and evaluates only the first trusted header for $name",
  async ({ headers, unauthenticated }, { home, key }) => {
    const raw = mime(
      [
        "Received: from smtp.example.test by mx.cloudflare.net; Sat, 10 Oct 2026 12:00:00 +0000",
        ...headers.map((value) => `Authentication-Results: ${value}`),
        "From: Alice Example <alice@example.test>",
        "To: Agent <agent@example.test>",
        "Date: Sat, 10 Oct 2026 12:00:00 +0000",
        "Message-ID: <authentication@example.test>",
        "Subject: Synthetic authentication test",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
      ],
      "Synthetic authentication test",
    );
    const parsed = await parseInbound(raw, receivedAt);
    expect(parsed.authentication_results).toEqual(headers);
    expect(authenticateInbound(parsed.authentication_results, ["mx.cloudflare.net"])).toBe(
      unauthenticated ? "unauthenticated" : "pass",
    );
    await withMailbox(home, key, (mailbox) =>
      Effect.gen(function* () {
        yield* mailbox.createInbox({ username: "agent", domain: "example.test" });
        const identity = stored(
          yield* ingestInbound(payload(raw), { trusted_authserv_ids: ["mx.cloudflare.net"] }),
        );
        const message = yield* mailbox.getMessage(identity.recipient, identity.message_id);
        expect(message.labels.includes("unauthenticated")).toBe(unauthenticated);
        expect(message.labels).toEqual(expect.arrayContaining(["received", "unread"]));
      }),
    );
  },
);

test("replays a synthesized id without changing the original stored body or labels", async ({
  home,
  key,
}) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      yield* mailbox.createInbox({ username: "agent", domain: "example.test" });
      const raw = mime([], "Message without identifiers or date");
      const identity = stored(yield* ingestInbound(payload(raw)));
      expect(identity.message_id).toMatch(/^<[0-9a-f]{64}@inbot\.invalid>$/);
      yield* mailbox.updateMessage(identity.recipient, identity.message_id, {
        remove_labels: ["unread"],
      });
      expect(
        yield* ingestInbound({ ...payload(raw), received_at: "2026-10-11T12:00:00Z" }),
      ).toEqual([identity]);
      const message = yield* mailbox.getMessage(identity.recipient, identity.message_id);
      expect(message.timestamp).toBe(receivedAt);
      expect(message.from).toBe("alice@example.test");
      expect(message.labels).not.toContain("unread");
      expect(
        (yield* mailbox.listMessages(identity.recipient, { include_unauthenticated: true })).count,
      ).toBe(1);
    }),
  );
});

test("rejects oversized payloads before storing messages", async ({ home, key }) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      yield* mailbox.createInbox({ username: "agent", domain: "example.test" });
      const error = yield* Effect.flip(
        ingestInbound(payload(new Uint8Array(MAX_INBOUND_BYTES + 1))),
      );
      expect(error).toMatchObject({ _tag: "InboundError", code: "payload_too_large" });
      expect(
        (yield* mailbox.listMessages("agent@example.test", { include_unauthenticated: true }))
          .count,
      ).toBe(0);
    }),
  );
});

test("reports invalid payloads and parser limits without leaking message content", async ({
  home,
  key,
}) => {
  await withMailbox(home, key, (mailbox) =>
    Effect.gen(function* () {
      yield* mailbox.createInbox({ username: "agent", domain: "example.test" });
      const invalid = yield* Effect.flip(
        ingestInbound({ ...payload(alternative), received_at: "invalid" }),
      );
      expect(invalid).toMatchObject({ _tag: "InboundError", code: "invalid_payload" });
      const malformed = mime([`Subject: ${"private".repeat(400_000)}`], "Sensitive content");
      const failure = yield* Effect.flip(ingestInbound(payload(malformed)));
      expect(failure).toMatchObject({ _tag: "InboundError", code: "invalid_mime" });
      expect(String(failure)).not.toContain("private");
      expect(String(failure)).not.toContain("Sensitive content");
      expect(
        (yield* mailbox.listMessages("agent@example.test", { include_unauthenticated: true }))
          .count,
      ).toBe(0);
    }),
  );
});
