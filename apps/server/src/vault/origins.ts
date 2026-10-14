import { validationError } from "../mailbox/errors.js";

function parse(input: string) {
  try {
    const url = new URL(input);
    if (
      url.username ||
      url.password ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      )
    )
      throw new Error();
    return url;
  } catch {
    throw validationError(
      "The credential URL or origin is invalid.",
      "Use an HTTPS URL without embedded credentials, or HTTP on localhost, 127.0.0.1, or [::1].",
    );
  }
}

export function credentialOrigins(url: string | undefined, extra: readonly string[]) {
  const origins = new Set(url === undefined ? [] : [parse(url).origin]);
  for (const origin of extra) {
    const parsed = parse(origin);
    if (origin !== parsed.origin)
      throw validationError(
        "Extra credential origins must be bare origins.",
        "Use scheme://host[:port] without a path, trailing slash, query, or fragment.",
      );
    origins.add(parsed.origin);
  }
  if (origins.size > 16)
    throw validationError("A credential can have at most 16 origins.", "Remove an extra origin.");
  return [...origins];
}
