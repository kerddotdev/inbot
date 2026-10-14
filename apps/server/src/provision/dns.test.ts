import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import type { VerificationRecord } from "../../../../packages/contracts/src/domains.js";
import { PublicDns, type DnsResolver } from "./dns.js";

const zone = "example.test";
const txt: VerificationRecord = {
  type: "TXT",
  name: "agents.example.test",
  value: "v=spf1 -all",
  status: "UNKNOWN",
};
const mx: VerificationRecord = {
  type: "MX",
  name: txt.name,
  value: "mail.example.test",
  priority: 10,
  status: "UNKNOWN",
};
const cname: VerificationRecord = {
  type: "CNAME",
  name: "dkim.agents.example.test",
  value: "key.example.test",
  status: "UNKNOWN",
};
const dnsError = (code: string) => Object.assign(new Error(code), { code });
async function fixture() {
  const resolver = {
    resolveNs: vi.fn(async () => ["ns.example.test"]),
    resolve4: vi.fn(async () => ["192.0.2.53"]),
    resolve6: vi.fn(async (): Promise<string[]> => []),
    resolveTxt: vi.fn(async () => [["v=spf1 ", "-all"]]),
    resolveMx: vi.fn(async () => [{ exchange: "MAIL.example.test.", priority: 10 }]),
    resolveCname: vi.fn(async () => ["KEY.example.test."]),
    setServers: vi.fn<(servers: readonly string[]) => void>(),
    cancel: vi.fn<() => void>(),
  } satisfies DnsResolver;
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ Status: 0, Answer: [] }),
  );
  const dns = await Effect.runPromise(
    PublicDns.pipe(Effect.provide(PublicDns.live(fetch, () => resolver))),
  );
  const check = (records: readonly VerificationRecord[] = [txt]) =>
    Effect.runPromise(dns.check(records, zone));
  return { resolver, fetch, check };
}

test("authoritative TXT chunks, MX priority and CNAME verify despite recursive negative caching", async () => {
  const f = await fixture();
  expect((await f.check([txt, mx, cname])).map((r) => r.status)).toEqual([
    "VALID",
    "VALID",
    "VALID",
  ]);
  expect(f.resolver.resolveNs).toHaveBeenCalledExactlyOnceWith(zone);
  expect(f.resolver.setServers).toHaveBeenCalledWith(["192.0.2.53"]);
  expect(f.fetch).not.toHaveBeenCalled();
});

test.each(["ENODATA", "ENOTFOUND"])(
  "an authoritative %s is missing without consulting recursive DNS",
  async (code) => {
    const f = await fixture();
    f.resolver.resolveTxt.mockRejectedValue(dnsError(code));
    expect((await f.check())[0]?.status).toBe("MISSING");
    expect(f.fetch).not.toHaveBeenCalled();
  },
);

test("wrong authoritative values and MX priorities are invalid", async () => {
  const f = await fixture();
  f.resolver.resolveTxt.mockResolvedValue([["v=spf1 ~all"]]);
  f.resolver.resolveMx.mockResolvedValue([{ exchange: mx.value, priority: 20 }]);
  expect((await f.check([txt, mx])).map((r) => r.status)).toEqual(["INVALID", "INVALID"]);
});

test.each(["discovery", "addresses", "query"])("%s failure falls back to DoH", async (stage) => {
  const f = await fixture();
  if (stage === "discovery") f.resolver.resolveNs.mockRejectedValue(dnsError("ESERVFAIL"));
  if (stage === "addresses") f.resolver.resolve4.mockRejectedValue(dnsError("ETIMEOUT"));
  if (stage === "query") f.resolver.resolveTxt.mockRejectedValue(dnsError("ECONNREFUSED"));
  f.fetch.mockResolvedValue(
    Response.json({
      Status: 0,
      Answer: [{ name: `${txt.name}.`, type: 16, data: '"v=spf1 -all"' }],
    }),
  );
  expect((await f.check([{ ...txt, reason: "Old failure" }]))[0]).toEqual({
    ...txt,
    status: "VALID",
  });
  expect(f.fetch).toHaveBeenCalledOnce();
});

test.each(["network", "http", "servfail", "nxdomain", "nodata", "malformed"])(
  "failed authority and %s fallback remain unknown",
  async (failure) => {
    const f = await fixture();
    f.resolver.resolveTxt.mockRejectedValue(dnsError("ETIMEOUT"));
    if (failure === "network") f.fetch.mockRejectedValue(new Error("Offline"));
    if (failure === "http") f.fetch.mockResolvedValue(new Response(null, { status: 503 }));
    if (failure === "servfail") f.fetch.mockResolvedValue(Response.json({ Status: 2 }));
    if (failure === "nxdomain") f.fetch.mockResolvedValue(Response.json({ Status: 3 }));
    if (failure === "malformed") f.fetch.mockResolvedValue(Response.json({}));
    const [record] = await f.check([{ ...txt, status: "VALID" }]);
    expect(record?.status).toBe("UNKNOWN");
    expect(record?.reason).toContain("retry verification");
  },
);

test("fallback rejects wrong owner names, record types and MX priorities", async () => {
  const f = await fixture();
  f.resolver.resolveNs.mockRejectedValue(dnsError("ESERVFAIL"));
  f.fetch.mockImplementation(async () =>
    Response.json({
      Status: 0,
      Answer: [
        { name: `${txt.name}.`, type: 15, data: "20 mail.example.test." },
        { name: "wrong.example.test.", type: 16, data: '"v=spf1 -all"' },
      ],
    }),
  );
  expect((await f.check([mx, txt])).map((r) => r.status)).toEqual(["INVALID", "UNKNOWN"]);
});

test("IPv6 nameservers work when IPv4 resolution fails", async () => {
  const f = await fixture();
  f.resolver.resolve4.mockRejectedValue(dnsError("ENODATA"));
  f.resolver.resolve6.mockResolvedValue(["2001:db8::53"]);
  expect((await f.check())[0]?.status).toBe("VALID");
  expect(f.resolver.setServers).toHaveBeenCalledWith(["2001:db8::53"]);
});

test("a stalled authoritative query is canceled and falls back within the deadline", async () => {
  vi.useFakeTimers();
  try {
    const f = await fixture();
    f.resolver.resolveTxt.mockImplementation(() => new Promise(() => {}));
    f.fetch.mockResolvedValue(
      Response.json({ Status: 0, Answer: [{ name: txt.name, type: 16, data: '"v=spf1 -all"' }] }),
    );
    const result = f.check();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await result)[0]?.status).toBe("VALID");
    expect(f.resolver.cancel).toHaveBeenCalledTimes(2);
    expect(f.fetch).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
