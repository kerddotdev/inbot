import type { ProviderMessage } from "./cloudflare.js";

function encoded(value: string) {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of value) {
    if (Buffer.byteLength(chunk + character) > 42) {
      chunks.push(`=?UTF-8?B?${Buffer.from(chunk).toString("base64")}?=`);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(`=?UTF-8?B?${Buffer.from(chunk).toString("base64")}?=`);
  return chunks.join("\r\n ");
}

function mailbox(value: ProviderMessage["from"]) {
  return typeof value === "string" ? value : `${encoded(value.name)} <${value.address}>`;
}

function base64(value: string) {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function part(value: string, type: string) {
  return `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(Buffer.from(value).toString("base64"))}`;
}

export function renderMime(message: ProviderMessage, messageId: string, timestamp: string) {
  const headers = [
    `Message-ID: ${messageId}`,
    `Date: ${new Date(timestamp).toUTCString()}`,
    `From: ${mailbox(message.from)}`,
    ...(message.to.length ? [`To: ${message.to.map(mailbox).join(",\r\n ")}`] : []),
    ...(message.cc.length ? [`Cc: ${message.cc.map(mailbox).join(",\r\n ")}`] : []),
    ...(message.reply_to !== undefined ? [`Reply-To: ${mailbox(message.reply_to)}`] : []),
    `Subject: ${encoded(message.subject)}`,
    "MIME-Version: 1.0",
    ...Object.entries(message.headers).map(
      ([name, value]) => `${name}: ${value.replace(/ (?![^ ]*$)/g, "\r\n ")}`,
    ),
  ];
  const parts = [
    ...(message.text !== undefined ? [part(message.text, "text/plain")] : []),
    ...(message.html !== undefined ? [part(message.html, "text/html")] : []),
  ];
  const boundary = `inbot_${messageId.replace(/[^a-z0-9]/gi, "")}`;
  const alternative = `${boundary}_alt`;
  let body = parts[0] ?? part("", "text/plain");
  if (parts.length > 1)
    body = `Content-Type: multipart/alternative; boundary="${alternative}"\r\n\r\n${parts.map((value) => `--${alternative}\r\n${value}\r\n`).join("")}--${alternative}--`;
  if (message.attachments.length) {
    const attached = message.attachments.map((attachment) => {
      const filename = encodeURIComponent(attachment.filename).replace(/'/g, "%27");
      return `Content-Type: ${attachment.type}\r\nContent-Disposition: ${attachment.disposition}; filename*=utf-8''${filename}\r\nContent-Transfer-Encoding: base64\r\n${attachment.content_id ? `Content-ID: <${attachment.content_id}>\r\n` : ""}\r\n${base64(attachment.content)}`;
    });
    body = `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${[body, ...attached].map((value) => `--${boundary}\r\n${value}\r\n`).join("")}--${boundary}--`;
  }
  return Buffer.from(`${headers.join("\r\n")}\r\n${body}\r\n`);
}
