import { Schema } from "effect";
import { afterEach, expect, test, vi } from "vitest";
import { createInboundKey, InboundPointer } from "./pointer.js";

afterEach(() => vi.useRealTimers());

test("creates unique UUIDv7 keys that sort by receipt millisecond", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T12:00:00.000Z"));
  const first = createInboundKey();
  const sameTime = createInboundKey();
  vi.setSystemTime(new Date("2026-10-10T12:00:00.001Z"));
  const next = createInboundKey();
  expect(first).not.toBe(sameTime);
  expect(first < next).toBe(true);
  expect(first).toMatch(
    /^inbound\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.age$/,
  );
  expect(Number.parseInt(first.slice(8, 21).replace("-", ""), 16)).toBe(
    Date.parse("2026-10-10T12:00:00.000Z"),
  );
});

test("validates pointer fields and rejects metadata and malformed values", () => {
  const pointer = {
    version: 1,
    key: createInboundKey(),
    size: 1024,
    received_at: "2026-10-10T12:00:00.000Z",
  };
  const decode = Schema.decodeUnknownSync(InboundPointer, { onExcessProperty: "error" });
  expect(decode(pointer)).toEqual(pointer);
  for (const invalid of [
    { ...pointer, version: 2 },
    { ...pointer, key: "inbound/sender@example.invalid.age" },
    { ...pointer, size: -1 },
    { ...pointer, size: 1.5 },
    { ...pointer, size: Number.POSITIVE_INFINITY },
    { ...pointer, received_at: "2026-02-30T12:00:00.000Z" },
    { ...pointer, received_at: "not a date" },
    { ...pointer, sender: "sender@example.invalid" },
    { ...pointer, subject: "private subject" },
  ]) {
    expect(() => decode(invalid)).toThrow();
  }
});
