import { expect, test } from "vitest";
import type { Message } from "../../../../packages/contracts/src/messages.js";
import type { OutboundRequest } from "../../../../packages/contracts/src/outbound.js";
import { parseInbound } from "../inbound/parse.js";
import { compose, MAX_MESSAGE_BYTES, validateHeaders } from "./compose.js";
import { renderMime } from "./mime.js";

const inbox = "agent@example.test";
const parent: Message = {
  inbox_id: inbox,
  message_id: "<parent@example.test>",
  thread_id: "thread",
  labels: ["received"],
  from: "Alice <alice@example.test>",
  reply_to: ["Support <support@example.test>"],
  to: ["Agent <AGENT@example.test>", "bob@example.test"],
  cc: ["carol@example.test", "bob@example.test", inbox],
  bcc: ["hidden@example.test"],
  subject: "Project update",
  text: "Original body",
  html: "<p>Original body</p>",
  references: ["<root@example.test>"],
  size: 100,
  timestamp: "2026-10-10T10:00:00Z",
  created_at: "2026-10-10T10:00:00Z",
  updated_at: "2026-10-10T10:00:00Z",
};

function reply(
  request: Extract<OutboundRequest, { kind: "reply" }>["request"] = { text: "New body" },
) {
  return compose(inbox, { kind: "reply", message_id: parent.message_id, request }, { parent });
}

test("replies use Reply-To, keep only caller body, and add threading headers", () => {
  const result = reply();
  expect(result.to).toEqual(["Support <support@example.test>"]);
  expect(result.cc).toEqual([]);
  expect(result.provider.subject).toBe("Re: Project update");
  expect(result.provider.text).toBe("New body");
  expect(result.provider.html).toBeUndefined();
  expect(result.provider.headers).toEqual({
    "In-Reply-To": parent.message_id,
    References: "<root@example.test> <parent@example.test>",
  });
  expect(
    compose(
      inbox,
      { kind: "reply", message_id: parent.message_id, request: { text: "Reply" } },
      { parent: { ...parent, reply_to: [], subject: "rE: Project update" } },
    ).to,
  ).toEqual([parent.from]);
  expect(
    compose(
      inbox,
      { kind: "reply", message_id: parent.message_id, request: { text: "Reply" } },
      { parent: { ...parent, subject: "rE: Project update" } },
    ).provider.subject,
  ).toBe("rE: Project update");
});

test("reply-all excludes the inbox and duplicates, never copies BCC, and respects field overrides", () => {
  const all = compose(
    inbox,
    { kind: "reply-all", message_id: parent.message_id, request: { text: "All" } },
    { parent },
  );
  expect(all.to).toEqual(["Support <support@example.test>", "bob@example.test"]);
  expect(all.cc).toEqual(["carol@example.test"]);
  expect(all.bcc).toEqual([]);
  expect(
    reply({
      text: "All",
      reply_all: true,
      to: "override@example.test",
      cc: [],
      bcc: ["audit@example.test"],
    }),
  ).toMatchObject({
    to: ["override@example.test"],
    cc: [],
    bcc: ["audit@example.test"],
  });
});

test("generated reply headers override custom threading and trim old references within both header limits", () => {
  const long = {
    ...parent,
    references: Array.from({ length: 300 }, (_, i) => `<${i}@example.test>`),
  };
  const result = compose(
    inbox,
    {
      kind: "reply",
      message_id: parent.message_id,
      request: {
        text: "Reply",
        headers: {
          "in-reply-to": "<wrong@example.test>",
          references: "<wrong@example.test>",
          "X-Tracking": "track",
        },
      },
    },
    { parent: long },
  );
  expect(result.references.at(-1)).toBe(parent.message_id);
  expect(result.references.length).toBeLessThan(300);
  expect(Buffer.byteLength(result.provider.headers.References ?? "")).toBeLessThanOrEqual(2048);
  expect(validateHeaders(result.provider.headers)).toBeLessThanOrEqual(16 * 1024);
  expect(result.provider.headers["in-reply-to"]).toBeUndefined();
});

test("forwards include the original bodies and attachments, start a new thread, and avoid duplicate prefixes", async () => {
  const original = {
    attachment_id: "attachment",
    filename: "report.txt",
    content_type: "text/plain",
    size: 6,
    content_disposition: "attachment" as const,
  };
  const forwarded = compose(
    inbox,
    {
      kind: "forward",
      message_id: parent.message_id,
      request: { to: "reviewer@example.test", text: "Please review", html: "<p>Please review</p>" },
    },
    {
      parent: { ...parent, attachments: [original] },
      attachments: [{ attachment: original, content: Buffer.from("report") }],
    },
  );
  expect(forwarded.provider.subject).toBe("Fwd: Project update");
  expect(forwarded.provider.text).toContain("Please review\n\n---------- Forwarded message");
  expect(forwarded.provider.text).toContain("Original body");
  expect(forwarded.provider.html).toContain(parent.html);
  expect(forwarded.provider.attachments[0]).toMatchObject({
    filename: "report.txt",
    content: Buffer.from("report").toString("base64"),
  });
  expect(forwarded.in_reply_to).toBeUndefined();
  const parsed = await parseInbound(
    renderMime(forwarded.provider, "<new@inbot.local>", parent.timestamp),
    parent.timestamp,
  );
  expect(parsed.text?.trim()).toBe(forwarded.provider.text);
  expect(parsed.html?.trim()).toBe(forwarded.provider.html);
  expect(Buffer.from(parsed.attachments[0]?.content ?? []).toString()).toBe("report");
  expect(
    compose(
      inbox,
      {
        kind: "forward",
        message_id: parent.message_id,
        request: { to: inbox, subject: "fWD: Custom" },
      },
      { parent },
    ).provider.subject,
  ).toBe("fWD: Custom");
});

test.each([
  {
    request: { to: Array.from({ length: 51 }, (_, i) => `r${i}@example.test`), text: "body" },
    code: "validation_error",
  },
  {
    request: {
      to: inbox,
      text: "body",
      attachments: Array.from({ length: 33 }, () => ({ content: "YQ==" })),
    },
    code: "validation_error",
  },
  { request: { to: inbox, text: "a".repeat(MAX_MESSAGE_BYTES + 1) }, code: "payload_too_large" },
  {
    request: {
      to: inbox,
      text: "body",
      attachments: [{ content: Buffer.alloc(MAX_MESSAGE_BYTES + 1).toString("base64") }],
    },
    code: "payload_too_large",
  },
  {
    request: { to: inbox, text: "body", headers: { "Message-ID": "<forbidden@example.test>" } },
    code: "validation_error",
  },
  {
    request: { to: inbox, text: "body", headers: { "Reply-To": inbox } },
    code: "validation_error",
  },
  {
    request: {
      to: inbox,
      text: "body",
      headers: { "X-Value": "good\r\nBcc: leaked@example.test" },
    },
    code: "validation_error",
  },
  {
    request: { to: inbox, text: "body", headers: { "X-Value": "a".repeat(2049) } },
    code: "validation_error",
  },
  {
    request: {
      to: inbox,
      text: "body",
      headers: Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => [`X-${i}`, "a".repeat(2048)]),
      ),
    },
    code: "validation_error",
  },
  {
    request: { to: inbox, text: "body", headers: { "X-Value": "a", "x-value": "b" } },
    code: "validation_error",
  },
  {
    request: { to: inbox, text: "body", attachments: [{ url: "http://127.0.0.1/private" }] },
    code: "not_supported",
  },
  {
    request: { to: inbox, text: "body", attachments: [{ content: "!!!" }] },
    code: "validation_error",
  },
  {
    request: { to: inbox, text: "body", reply_to: ["one@example.test", "two@example.test"] },
    code: "validation_error",
  },
])("rejects invalid or unsupported composition ($code)", ({ request, code }) => {
  expect(() => compose(inbox, { kind: "send", request })).toThrow(
    expect.objectContaining({ code }),
  );
});

test("message size includes encoded attachments and MIME framing, not just decoded bytes", () => {
  expect(() =>
    compose(inbox, {
      kind: "send",
      request: {
        to: inbox,
        text: "body",
        attachments: [{ content: Buffer.alloc(4 * 1024 * 1024).toString("base64") }],
      },
    }),
  ).toThrow(expect.objectContaining({ code: "payload_too_large" }));
});

test("a named recipient, Unicode subject, inline content id and hidden BCC survive local MIME storage", async () => {
  const result = compose(inbox, {
    kind: "send",
    request: {
      to: "Reader <reader@example.test>",
      bcc: "private@example.test",
      subject: "Project \u00e9 summary",
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
  });
  const raw = renderMime(result.provider, "<local@inbot.local>", parent.timestamp);
  const parsed = await parseInbound(raw, parent.timestamp);
  expect(parsed.subject).toBe("Project \u00e9 summary");
  expect(parsed.to).toEqual(["Reader <reader@example.test>"]);
  expect(raw.toString()).not.toContain("private@example.test");
  expect(parsed.attachments[0]?.content_id).toBe("<logo>");
});

test("send cannot inject reply headers while claiming to create a new thread", () => {
  expect(() =>
    compose(inbox, {
      kind: "send",
      request: { to: inbox, text: "Body", headers: { "In-Reply-To": parent.message_id } },
    }),
  ).toThrow(expect.objectContaining({ code: "validation_error" }));
});
