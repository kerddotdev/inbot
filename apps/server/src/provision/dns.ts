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
        status: "MISSING",
        ...(record.priority === undefined ? {} : { priority: record.priority }),
      },
    ];
  });
}
export class PublicDns extends Context.Service<
  PublicDns,
  {
    readonly check: (
      records: readonly VerificationRecord[],
    ) => Effect.Effect<readonly VerificationRecord[], import("./errors.js").ProvisionError>;
  }
>()("inbot/PublicDns") {
  static live(fetch: typeof globalThis.fetch = globalThis.fetch) {
    return Layer.succeed(PublicDns, {
      check: (records) =>
        Effect.forEach(
          records,
          (record) =>
            Effect.tryPromise({
              try: async (signal): Promise<VerificationRecord> => {
                if (record.value === "") return { ...record, status: "MISSING" };
                const params = new URLSearchParams({ name: record.name, type: record.type });
                const response = await fetch(`https://cloudflare-dns.com/dns-query?${params}`, {
                  signal,
                  redirect: "error",
                  headers: { Accept: "application/dns-json" },
                });
                if (!response.ok) throw unavailable();
                const result = Schema.decodeUnknownSync(ResponseSchema)(await response.json());
                if (result.Status !== 0 && result.Status !== 3) throw unavailable();
                const answers = (result.Answer ?? []).filter(
                  (answer) =>
                    answer.type === dnsTypes[record.type] &&
                    normalizeDns(answer.name, "CNAME") === normalizeDns(record.name, "CNAME"),
                );
                const expected =
                  record.type === "MX"
                    ? `${record.priority ?? 0} ${normalizeDns(record.value, "MX")}`
                    : normalizeDns(record.value, record.type);
                const valid =
                  result.Status === 0 &&
                  answers.some((answer) => normalizeDns(answer.data, record.type) === expected);
                return {
                  ...record,
                  status: valid ? "VALID" : answers.length ? "INVALID" : "MISSING",
                };
              },
              catch: () => unavailable(),
            }).pipe(
              Effect.timeoutOrElse({
                duration: "10 seconds",
                orElse: () => Effect.fail(unavailable()),
              }),
            ),
          { concurrency: 4 },
        ),
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
