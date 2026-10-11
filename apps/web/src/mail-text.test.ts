import { expect, test } from "vitest";
import { hasQuotedText } from "./mail-text";

test("quoted-text disclosure requires additional normalized full text", () => {
  expect(hasQuotedText("Reply", "Reply")).toBe(false);
  expect(hasQuotedText(" Reply\r\n body ", "Reply body")).toBe(false);
  expect(hasQuotedText(undefined, "Reply")).toBe(false);
  expect(hasQuotedText("Reply", undefined)).toBe(false);
  expect(hasQuotedText("", "Reply")).toBe(false);
  expect(hasQuotedText("Reply", "Longer extracted reply")).toBe(false);
  expect(hasQuotedText("Reply\n\n> Previous message", "Reply")).toBe(true);
  expect(hasQuotedText("> Previous message", "")).toBe(true);
});
