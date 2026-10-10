import { createHmac, timingSafeEqual } from "node:crypto";

export function signWebhook(secret: string, eventId: string, timestamp: string, body: string) {
  return `v1,${createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64"))
    .update(`${eventId}.${timestamp}.${body}`)
    .digest("base64")}`;
}

export function verifyWebhook(
  secret: string,
  eventId: string,
  timestamp: string,
  body: string,
  signature: string,
  nowMillis = Date.now(),
  toleranceSeconds = 300,
) {
  if (!/^\d+$/.test(timestamp) || Math.abs(nowMillis / 1000 - Number(timestamp)) > toleranceSeconds)
    return false;
  const expected = Buffer.from(signWebhook(secret, eventId, timestamp, body));
  return signature.split(" ").some((value) => {
    const actual = Buffer.from(value);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}
