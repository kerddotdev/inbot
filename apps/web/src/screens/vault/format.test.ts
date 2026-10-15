import { expect, test } from "vitest";
import {
  approvalsCount,
  exportFilename,
  relativeTime,
  totpRefreshDelay,
  totpSecondsRemaining,
} from "./format";

const now = Date.parse("2026-10-14T12:00:00Z");

test("export filename uses the local calendar date", () => {
  expect(exportFilename(new Date(2026, 0, 5, 23, 59))).toBe("inbot-credentials-2026-01-05.json");
});

test("TOTP countdown rounds up and never goes negative", () => {
  expect(totpSecondsRemaining("2026-10-14T12:00:12.200Z", now)).toBe(13);
  expect(totpSecondsRemaining("2026-10-14T11:59:00Z", now)).toBe(0);
});

test("TOTP refresh waits for the period end and retries no faster than once a second", () => {
  expect(totpRefreshDelay("2026-10-14T12:00:10Z", now)).toBe(10_300);
  expect(totpRefreshDelay("2026-10-14T11:59:00Z", now)).toBe(1000);
});

test("approvals count includes only unexpired credential items", () => {
  const live = { expires_at: "2026-10-15T12:00:00Z" };
  const expired = { expires_at: "2026-10-13T12:00:00Z" };
  expect(approvalsCount([{}, {}], [live, expired], [live, live, expired], now)).toBe(5);
  expect(approvalsCount([], undefined, undefined, now)).toBe(0);
});

test("relative time reads naturally in both directions", () => {
  expect(relativeTime("2026-10-14T09:00:00Z", now)).toBe("3 hours ago");
  expect(relativeTime("2026-10-14T12:00:20Z", now)).toBe("just now");
  expect(relativeTime("2026-10-16T12:00:00Z", now)).toBe("in 2 days");
});
