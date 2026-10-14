export const REVEAL_TIMEOUT_MS = 60_000;

type Expiring = { readonly expires_at: string };

const isLive = (item: Expiring, now: number) => Date.parse(item.expires_at) > now;

export function approvalsCount(
  drafts: readonly unknown[],
  credentialUse: readonly Expiring[] = [],
  credentialRequests: readonly Expiring[] = [],
  now: number,
) {
  return (
    drafts.length +
    credentialUse.filter((item) => isLive(item, now)).length +
    credentialRequests.filter((item) => isLive(item, now)).length
  );
}

export function exportFilename(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `inbot-credentials-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
}

export function totpSecondsRemaining(expiresAt: string, now: number) {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

export function totpRefreshDelay(expiresAt: string, now: number) {
  return Math.max(1000, Date.parse(expiresAt) - now + 300);
}

const units: readonly { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: "year", ms: 365 * 86_400_000 },
  { unit: "month", ms: 30 * 86_400_000 },
  { unit: "day", ms: 86_400_000 },
  { unit: "hour", ms: 3_600_000 },
  { unit: "minute", ms: 60_000 },
];

export function relativeTime(iso: string, now: number) {
  const diff = Date.parse(iso) - now;
  const match = units.find(({ ms }) => Math.abs(diff) >= ms);
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  return match ? format.format(Math.round(diff / match.ms), match.unit) : "just now";
}

export function urlHost(url: string | undefined) {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
