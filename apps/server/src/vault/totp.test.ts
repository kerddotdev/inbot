import * as OTPAuth from "otpauth";
import { expect, test, vi } from "vitest";
import { normalizeTotp, totpCode, TotpError } from "./totp.js";

const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const vectors = [
  { algorithm: "SHA1", seed: "12345678901234567890", codes: ["94287082", "07081804", "65353130"] },
  {
    algorithm: "SHA256",
    seed: "12345678901234567890123456789012",
    codes: ["46119246", "68084774", "77737706"],
  },
  {
    algorithm: "SHA512",
    seed: "1234567890123456789012345678901234567890123456789012345678901234",
    codes: ["90693936", "25091201", "47863826"],
  },
];

test.each(vectors)("matches RFC 6238 Appendix B for $algorithm", ({ algorithm, seed, codes }) => {
  const uri = new OTPAuth.TOTP({
    label: "rfc6238",
    algorithm,
    digits: 8,
    period: 30,
    secret: OTPAuth.Secret.fromLatin1(seed),
  }).toString();
  const times = [59, 1111111109, 20000000000];
  for (const [index, time] of times.entries()) {
    expect(totpCode(uri, time * 1000).code).toBe(codes[index]);
  }
});

test("expires at the end of the current window including exact boundaries", () => {
  const uri = `otpauth://totp/inbot?secret=${secret}&digits=8`;
  expect(totpCode(uri, 59000)).toEqual({
    code: "94287082",
    period: 30,
    expires_at: "1970-01-01T00:01:00.000Z",
  });
  expect(totpCode(uri, 59999).expires_at).toBe("1970-01-01T00:01:00.000Z");
  expect(totpCode(uri, 60000).expires_at).toBe("1970-01-01T00:01:30.000Z");
  expect(totpCode(`otpauth://totp/inbot?secret=${secret}&period=45`, 59000).expires_at).toBe(
    "1970-01-01T00:01:30.000Z",
  );
});

test("code generation uses only the caller's timestamp", () => {
  const clock = vi.spyOn(Date, "now").mockImplementation(() => {
    throw new Error("The system clock must not be read.");
  });
  try {
    const uri = normalizeTotp(`otpauth://totp/inbot?secret=${secret}&digits=8`);
    expect(totpCode(uri, 59000).code).toBe("94287082");
  } finally {
    clock.mockRestore();
  }
});

test("normalizes lowercase spaced base32 with the inbot label and no issuer", () => {
  const uri = normalizeTotp(" gezd gnbv gy3t qojq gezd gnbv gy3t qojq ");
  expect(uri).toBe(`otpauth://totp/inbot?secret=${secret}&algorithm=SHA1&digits=6&period=30`);
  expect(normalizeTotp(uri)).toBe(uri);
});

test("normalizes a padded base32 secret", () => {
  expect(normalizeTotp("my======")).toBe(
    "otpauth://totp/inbot?secret=MY&algorithm=SHA1&digits=6&period=30",
  );
});

test.each([
  `otpauth://totp/Example:alice%40example.com?secret=${secret}&issuer=Example&algorithm=SHA256&digits=7&period=15`,
  `otpauth://totp/alice%40example.com?secret=${secret}&issuer=Example&algorithm=SHA512&digits=8&period=120`,
  `otpauth://totp/Example:alice%40example.com?secret=${secret}`,
  `otpauth://totp/alice%40example.com?secret=${secret}`,
])("preserves the URI issuer and account label", (input) => {
  const before = OTPAuth.URI.parse(input);
  const normalized = normalizeTotp(input);
  const after = OTPAuth.URI.parse(normalized);
  expect(after).toBeInstanceOf(OTPAuth.TOTP);
  expect(after.label).toBe("alice@example.com");
  expect(after.issuer).toBe(before.issuer);
  expect(normalizeTotp(normalized)).toBe(normalized);
});

test.each([
  "",
  "   ",
  "not-base32!",
  "1234567890",
  "A",
  "ABC",
  "MZ",
  "MY=",
  "MY==============",
  `otpauth://hotp/inbot?secret=${secret}&counter=0`,
  `otpauth://totp/inbot?secret=${secret}&digits=5`,
  `otpauth://totp/inbot?secret=${secret}&digits=9`,
  `otpauth://totp/inbot?secret=${secret}&period=14`,
  `otpauth://totp/inbot?secret=${secret}&period=121`,
  `otpauth://totp/inbot?secret=${secret}&period=30.5`,
  `otpauth://totp/inbot?secret=${secret}&algorithm=SHA224`,
  `otpauth://totp/inbot?secret=${secret}&algorithm=SHA384`,
  `otpauth://totp/inbot?secret=${secret}&algorithm=SHA3-256`,
  "otpauth://totp/inbot",
  "otpauth://totp/inbot?secret=%INVALID_SECRET",
])("rejects invalid input with a safe TotpError", (input) => {
  expect(() => normalizeTotp(input)).toThrow(TotpError);
  try {
    normalizeTotp(input);
  } catch (error) {
    expect(error).toBeInstanceOf(TotpError);
    if (!(error instanceof TotpError)) throw error;
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("%INVALID_SECRET");
    expect(error.cause).toBeUndefined();
  }
});

test("code generation also rejects unsupported URI settings", () => {
  expect(() => totpCode(`otpauth://totp/inbot?secret=${secret}&digits=9`, 59000)).toThrow(
    TotpError,
  );
  expect(() => totpCode(`otpauth://hotp/inbot?secret=${secret}&counter=0`, 59000)).toThrow(
    TotpError,
  );
});

test.each([-1, NaN, Infinity, 9e15])(
  "invalid timestamps fail without exposing secrets: %s",
  (nowMs) => {
    expect(() => totpCode(normalizeTotp(secret), nowMs)).toThrow(TotpError);
  },
);
