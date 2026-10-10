import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { validationError } from "../mailbox/errors.js";
import type { Principal } from "../../../../packages/contracts/src/security.js";

export type ResolveTarget = (
  hostname: string,
) => Promise<readonly { address: string; family: number }[]>;
export const resolveTarget: ResolveTarget = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

export function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) === 6) {
    const [firstHex = "0", secondHex = "0"] = address.toLowerCase().split(":");
    const first = Number.parseInt(firstHex, 16);
    const second = Number.parseInt(secondHex || "0", 16);
    return (
      first >= 0x2000 &&
      first <= 0x3fff &&
      first !== 0x2002 &&
      first !== 0x3fff &&
      !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8))
    );
  }
  return false;
}

export function webhookUrl(input: string, principal: Principal) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw validationError("A valid webhook URL is required.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const local = principal.kind === "owner" && url.protocol === "http:";
  if (
    url.username ||
    url.password ||
    url.hash ||
    input.length > 2048 ||
    (local && isIP(hostname) !== 0 && hostname !== "127.0.0.1") ||
    (!local && (url.protocol !== "https:" || (isIP(hostname) !== 0 && !publicAddress(hostname))))
  )
    throw validationError(
      "Webhooks require public HTTPS targets. Only owners can use HTTP receivers resolving exclusively to 127.0.0.1.",
    );
  return { url, local };
}

export async function checkedTarget(
  input: string,
  principal: Principal,
  resolve: ResolveTarget = resolveTarget,
) {
  const { url, local } = webhookUrl(input, principal);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses =
    local && ["127.0.0.1", "localhost"].includes(hostname)
      ? [{ address: "127.0.0.1", family: 4 }]
      : isIP(hostname) !== 0
        ? [{ address: hostname, family: isIP(hostname) }]
        : await resolve(hostname);
  if (
    addresses.length === 0 ||
    addresses.some((item) =>
      local ? item.address !== "127.0.0.1" || item.family !== 4 : !publicAddress(item.address),
    )
  )
    throw validationError("The webhook target resolves to a private or reserved network.");
  const address = addresses[0];
  if (address === undefined) throw validationError("The webhook target has no address.");
  return { url, address };
}

export interface WebhookRequest {
  readonly signal: AbortSignal;
  readonly url: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly principal: Principal;
}
export type WebhookSender = (request: WebhookRequest) => Promise<number>;

export function webhookSender(resolve: ResolveTarget = resolveTarget): WebhookSender {
  return async (input) => {
    const { url, address } = await checkedTarget(input.url, input.principal, resolve);
    input.signal.throwIfAborted();
    return new Promise<number>((accept, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: "POST",
          agent: false,
          signal: input.signal,
          headers: input.headers,
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          },
        },
        (response) => {
          accept(response.statusCode ?? 0);
          response.destroy();
        },
      );
      request.on("error", reject);
      request.end(input.body);
    });
  };
}
