import * as OTPAuth from "otpauth";

export class TotpError extends Error {}

function parseTotp(uri: string): OTPAuth.TOTP {
  try {
    const otp = OTPAuth.URI.parse(uri);
    if (!(otp instanceof OTPAuth.TOTP)) throw new TotpError("Use a TOTP URI, not HOTP.");
    if (!Number.isInteger(otp.digits) || otp.digits < 6 || otp.digits > 8)
      throw new TotpError("TOTP codes must have 6 to 8 digits.");
    if (!Number.isInteger(otp.period) || otp.period < 15 || otp.period > 120)
      throw new TotpError("TOTP periods must be between 15 and 120 seconds.");
    if (!["SHA1", "SHA256", "SHA512"].includes(otp.algorithm))
      throw new TotpError("Use SHA1, SHA256, or SHA512 for TOTP.");
    if (otp.secret.bytes.length === 0) throw new TotpError("Use a non-empty base32 TOTP secret.");
    return otp;
  } catch (error) {
    if (error instanceof TotpError) throw error;
    throw new TotpError("Invalid TOTP URI or secret.");
  }
}

export function normalizeTotp(input: string): string {
  const value = input.trim();
  if (/^otpauth:\/\//i.test(value)) return parseTotp(value).toString();
  try {
    const base32 = value.replace(/\s/g, "").toUpperCase();
    if (!/^[A-Z2-7]+=*$/.test(base32)) throw new TotpError("Use a valid base32 TOTP secret.");
    const secret = OTPAuth.Secret.fromBase32(base32);
    if (secret.bytes.length === 0) throw new TotpError("Use a non-empty base32 TOTP secret.");
    if (
      secret.base32 !== base32.replace(/=+$/, "") ||
      (base32.includes("=") && base32.length !== Math.ceil(secret.base32.length / 8) * 8)
    )
      throw new TotpError("Use a valid base32 TOTP secret with correct padding.");
    return new OTPAuth.TOTP({ label: "inbot", secret }).toString();
  } catch (error) {
    if (error instanceof TotpError) throw error;
    throw new TotpError("Invalid TOTP secret.");
  }
}

export function totpCode(
  uri: string,
  nowMs: number,
): { readonly code: string; readonly expires_at: string; readonly period: number } {
  const otp = parseTotp(uri);
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new TotpError("Use a valid TOTP timestamp.");
  try {
    const windowMs = otp.period * 1000;
    const expiresAt = (Math.floor(nowMs / windowMs) + 1) * windowMs;
    return {
      code: otp.generate({ timestamp: nowMs }),
      expires_at: new Date(expiresAt).toISOString(),
      period: otp.period,
    };
  } catch {
    throw new TotpError("Could not generate a TOTP code for the supplied timestamp.");
  }
}
