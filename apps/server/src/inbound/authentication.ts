export type Authentication = "pass" | "unauthenticated";

function clauses(header: string) {
  const parts: string[] = [];
  let part = "";
  let commentDepth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of header) {
    if (escaped) {
      if (commentDepth === 0) part += character;
      escaped = false;
    } else if (character === "\\" && (quoted || commentDepth > 0)) {
      if (commentDepth === 0) part += character;
      escaped = true;
    } else if (character === '"' && commentDepth === 0) {
      quoted = !quoted;
      part += character;
    } else if (character === "(" && !quoted) {
      if (commentDepth === 0) part += " ";
      commentDepth++;
    } else if (character === ")" && !quoted) {
      if (commentDepth === 0) return [];
      commentDepth--;
    } else if (commentDepth > 0) {
      continue;
    } else if (character === ";" && !quoted) {
      parts.push(part.trim());
      part = "";
    } else {
      part += character;
    }
  }
  if (commentDepth > 0 || quoted || escaped) return [];
  parts.push(part.trim());
  return parts;
}

export function authenticateInbound(
  headers: readonly string[],
  trustedAuthservIds: readonly string[] = [],
): Authentication {
  const trusted = new Set(trustedAuthservIds.map((id) => id.toLowerCase()));
  const candidates = trusted.size === 0 ? headers.slice(0, 1) : headers;
  for (const header of candidates) {
    const [service, ...results] = clauses(header);
    const authservId = service?.match(/^(?:"([^"\\]+)"|([^\s";]+))(?:\s+\d+)?$/);
    const id = authservId?.[1] ?? authservId?.[2];
    if (id === undefined || (trusted.size > 0 && !trusted.has(id.toLowerCase()))) continue;
    if (results.some((result) => /^(?:spf|dkim|dmarc)(?:\/\d+)?\s*=\s*pass(?:\s|$)/i.test(result)))
      return "pass";
  }
  return "unauthenticated";
}
