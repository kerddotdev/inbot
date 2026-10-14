import { Resolver } from "node:dns/promises";
import { Context, Effect, Layer, Schema } from "effect";
import type { VerificationRecord } from "../../../../packages/contracts/src/domains.js";
import type { DnsRecord } from "./cloudflare-api.js";
import { unavailable } from "./errors.js";

const ResponseSchema = Schema.Struct({
  Status: Schema.Int,
  Answer: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.Int, data: Schema.String })),
  ),
});
const dnsTypes = { TXT: 16, MX: 15, CNAME: 5 };
export function normalizeDns(value: string, type: string) {
  if (type === "TXT") {
    const chunks = Array.from(value.matchAll(/"((?:[^"\\]|\\.)*)"/g), (match) => match[1] ?? "");
    return (chunks.length ? chunks.join("") : value).replace(/\\(["\\])/g, "$1");
  }
  return value.toLowerCase().replace(/\.$/, "");
}
export function apexRecords(records: readonly DnsRecord[], apex: string) {
  return records
    .filter(
      (record) =>
        (record.name.toLowerCase() === apex &&
          (record.type === "MX" ||
            (record.type === "TXT" &&
              /^v=spf1(?:\s|$)/i.test(normalizeDns(record.content, "TXT"))))) ||
        record.name.toLowerCase() === `_dmarc.${apex}`,
    )
    .map((record) =>
      JSON.stringify([
        record.id,
        record.name.toLowerCase(),
        record.type,
        normalizeDns(record.content, record.type),
        record.priority,
        record.ttl,
      ]),
    )
    .sort();
}
export function verificationRecords(records: readonly DnsRecord[]): VerificationRecord[] {
  return records.flatMap((record) => {
    if (record.type !== "TXT" && record.type !== "CNAME" && record.type !== "MX") return [];
    return [
      {
        type: record.type,
        name: record.name,
        value: record.content,
        status: "UNKNOWN",
        ...(record.priority === undefined ? {} : { priority: record.priority }),
      },
    ];
  });
}
export type DnsResolver = Pick<
  Resolver,
  "resolveNs" | "resolveTxt" | "resolveMx" | "resolveCname" | "setServers" | "cancel"
> & {
  resolve4: (hostname: string) => Promise<string[]>;
  resolve6: (hostname: string) => Promise<string[]>;
};

const makeResolver = (): DnsResolver => new Resolver({ timeout: 2000, tries: 1 });

function withResolver<A>(
  createResolver: () => DnsResolver,
  run: (resolver: DnsResolver) => Promise<A>,
) {
  return Effect.tryPromise({
    try: async (signal) => {
      const resolver = createResolver();
      const cancel = () => resolver.cancel();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        signal.throwIfAborted();
        return await run(resolver);
      } finally {
        signal.removeEventListener("abort", cancel);
        resolver.cancel();
      }
    },
    catch: () => unavailable(),
  }).pipe(
    Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(unavailable()) }),
  );
}

function noRecords(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENODATA" || error.code === "ENOTFOUND")
  );
}

function recordResult(record: VerificationRecord, answers: readonly string[]): VerificationRecord {
  const { reason: _reason, ...current } = record;
  const expected =
    record.type === "MX"
      ? `${record.priority ?? 0} ${normalizeDns(record.value, "MX")}`
      : normalizeDns(record.value, record.type);
  return {
    ...current,
    status: answers.includes(expected) ? "VALID" : answers.length ? "INVALID" : "MISSING",
  };
}

export class PublicDns extends Context.Service<
  PublicDns,
  {
    readonly check: (
      records: readonly VerificationRecord[],
      zone: string,
    ) => Effect.Effect<readonly VerificationRecord[], import("./errors.js").ProvisionError>;
  }
>()("inbot/PublicDns") {
  static live(
    fetch: typeof globalThis.fetch = globalThis.fetch,
    createResolver: () => DnsResolver = makeResolver,
  ) {
    return Layer.succeed(PublicDns, {
      check: (records, zone) =>
        Effect.gen(function* () {
          if (records.length === 0) return [];
          const servers = yield* withResolver(createResolver, async (resolver) => {
            const names = await resolver.resolveNs(zone);
            const addresses = await Promise.allSettled(
              names.flatMap((name) => [resolver.resolve4(name), resolver.resolve6(name)]),
            );
            const ips = addresses.flatMap((result) =>
              result.status === "fulfilled" ? result.value : [],
            );
            if (ips.length === 0) throw unavailable();
            return ips;
          }).pipe(Effect.catch(() => Effect.succeed(undefined)));
          return yield* Effect.forEach(
            records,
            (record) => {
              if (record.value === "") return Effect.succeed(record);
              const authoritative = withResolver(createResolver, async (resolver) => {
                if (servers === undefined) throw unavailable();
                resolver.setServers(servers);
                try {
                  const answers =
                    record.type === "TXT"
                      ? (await resolver.resolveTxt(record.name)).map((chunks) => chunks.join(""))
                      : record.type === "MX"
                        ? (await resolver.resolveMx(record.name)).map(
                            (mx) => `${mx.priority} ${normalizeDns(mx.exchange, "MX")}`,
                          )
                        : (await resolver.resolveCname(record.name)).map((name) =>
                            normalizeDns(name, "CNAME"),
                          );
                  return recordResult(record, answers);
                } catch (error) {
                  if (noRecords(error)) return recordResult(record, []);
                  throw error;
                }
              });
              const fallback = Effect.tryPromise({
                try: async (signal): Promise<VerificationRecord> => {
                  const params = new URLSearchParams({ name: record.name, type: record.type });
                  const response = await fetch(`https://cloudflare-dns.com/dns-query?${params}`, {
                    signal,
                    redirect: "error",
                    headers: { Accept: "application/dns-json" },
                  });
                  if (!response.ok) throw unavailable();
                  const result = Schema.decodeUnknownSync(ResponseSchema)(await response.json());
                  if (result.Status !== 0) throw unavailable();
                  const answers = (result.Answer ?? [])
                    .filter(
                      (answer) =>
                        answer.type === dnsTypes[record.type] &&
                        normalizeDns(answer.name, "CNAME") === normalizeDns(record.name, "CNAME"),
                    )
                    .map((answer) => normalizeDns(answer.data, record.type));
                  // A recursive negative answer may predate provisioning. It cannot prove absence.
                  if (answers.length === 0) throw unavailable();
                  return recordResult(record, answers);
                },
                catch: () => unavailable(),
              }).pipe(
                Effect.timeoutOrElse({
                  duration: "5 seconds",
                  orElse: () => Effect.fail(unavailable()),
                }),
              );
              return authoritative.pipe(
                Effect.catch(() => fallback),
                Effect.catch(() =>
                  Effect.succeed({
                    ...record,
                    status: "UNKNOWN" as const,
                    reason:
                      "DNS could not be verified. Check DNS connectivity and retry verification.",
                  }),
                ),
              );
            },
            { concurrency: 4 },
          );
        }),
    });
  }
}

export function bindRecord(record: VerificationRecord) {
  if (record.value === "")
    return `; ${record.name}. IN ${record.type} - value assigned during apply`;
  let value: string;
  if (record.type === "TXT") {
    const chunks: string[] = [];
    let chunk = "";
    for (const character of normalizeDns(record.value, "TXT")) {
      if (Buffer.byteLength(chunk + character) > 255) {
        chunks.push(chunk);
        chunk = "";
      }
      chunk += character;
    }
    chunks.push(chunk);
    value = chunks
      .map(
        (part) =>
          `"${part.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\010").replace(/\r/g, "\\013")}"`,
      )
      .join(" ");
  } else
    value = `${record.priority === undefined ? "" : `${record.priority} `}${record.value.replace(/\.$/, "")}.`;
  return `${record.name.replace(/\.$/, "")}. 300 IN ${record.type} ${value}`;
}
