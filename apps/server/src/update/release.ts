import { Schema } from "effect";
import { UpdateError } from "./errors.js";
import { compareVersions, parseVersion } from "./version.js";

const Release = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
});
const repository = "https://api.github.com/repos/kerddotdev/inbot/releases";

export async function checkRelease(
  current: string,
  version?: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  if (version !== undefined) parseVersion(version);
  const response = await fetcher(
    `${repository}/${version === undefined ? "latest" : `tags/v${encodeURIComponent(version)}`}`,
    {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "inbot-updater" },
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
    },
  );
  if (!response.ok)
    throw new UpdateError(`GitHub release lookup failed (HTTP ${response.status}).`);
  const release = Schema.decodeUnknownSync(Release)(await response.json());
  const latest = release.tag_name.replace(/^v/, "");
  const parsed = parseVersion(latest);
  if (
    release.draft ||
    (version === undefined && (release.prerelease || parsed.prerelease.length)) ||
    (version !== undefined && latest !== version)
  )
    throw new UpdateError("GitHub did not return the requested published release.");
  return { current, latest, update_available: compareVersions(latest, current) > 0 };
}

export function assetUrl(version: string, asset: string) {
  parseVersion(version);
  return `https://github.com/kerddotdev/inbot/releases/download/v${encodeURIComponent(version)}/${asset}`;
}
