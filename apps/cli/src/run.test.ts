import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { build } from "esbuild";
import { Effect } from "effect";
import { CurrentPrincipal } from "../../../packages/contracts/src/security.js";
import { expect, test as base, vi } from "vitest";
import { fixture } from "../../server/src/http/test-fixture.js";
import { makeVault } from "../../server/src/vault/vault.js";
import { runCli, type CliIO } from "./cli.js";
import { collectRunEnvironment, credentialMask } from "./run.js";

const ref = `inbot://credentials/${"a".repeat(32)}/password`;
const otherRef = `inbot://credentials/${"b".repeat(32)}/api_key`;
const secret = "synthetic-run-password";
const test = base.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-run-test-"));
    try {
      const api = await fixture(home);
      try {
        await use(api);
      } finally {
        await api.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
});

async function invoke(args: readonly string[], overrides: Partial<CliIO> = {}) {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const code = await runCli(args, {
    env: {},
    stdout: (text) => {
      stdout.push(Buffer.from(text));
    },
    stderr: (text) => {
      stderr.push(Buffer.from(text));
    },
    stdoutBinary: async (bytes) => {
      stdout.push(Buffer.from(bytes));
    },
    stderrBinary: async (bytes) => {
      stderr.push(Buffer.from(bytes));
    },
    ...overrides,
  });
  return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

async function account(api: Awaited<ReturnType<typeof fixture>>) {
  const created = await api.run(
    makeVault(api.store)
      .create(
        { name: "Run account", fields: { password: secret, api_key: "synthetic-api-value" } },
        "agent@example.test",
      )
      .pipe(Effect.provideService(CurrentPrincipal, { kind: "owner" })),
  );
  const key = await api.run(
    api.keys.create({
      inbox_ids: ["agent@example.test"],
      permissions: { credential_run: true },
      send_policy: "read_only",
      use_policy: "direct",
    }),
  );
  return {
    ref: `inbot://credentials/${created.credential_id}/password`,
    apiRef: `inbot://credentials/${created.credential_id}/api_key`,
    env: { INBOT_URL: api.url, INBOT_API_KEY: key.api_key },
  };
}

async function masked(values: readonly string[], chunks: readonly Buffer[]) {
  const result: Buffer[] = [];
  for await (const chunk of Readable.from(chunks).pipe(credentialMask(values))) {
    const value: unknown = chunk;
    if (!Buffer.isBuffer(value)) throw new Error("Expected bytes");
    result.push(value);
  }
  return Buffer.concat(result);
}

test("collects exact ambient refs, overrides targets with flags and deduplicates requests", () => {
  const result = collectRunEnvironment(
    { AMBIENT: ref, OVERRIDE: otherRef, PARTIAL: `${ref} extra`, PLAIN: "keep" },
    [`OVERRIDE=${ref}`, `EXPLICIT=${otherRef}`],
  );
  expect(result.refs).toEqual([ref, otherRef]);
  expect(result.targets).toEqual([
    { name: "AMBIENT", ref },
    { name: "OVERRIDE", ref },
    { name: "EXPLICIT", ref: otherRef },
  ]);
  expect(result.env.PLAIN).toBe("keep");
  const prototypeName = collectRunEnvironment({}, [`__proto__=${ref}`]);
  expect(Object.entries(prototypeName.env)).toEqual([["__proto__", ref]]);
  expect(prototypeName.refs).toEqual([ref]);
  for (const name of [
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_FUTURE",
    "NODE_OPTIONS",
    "BASH_ENV",
    "ENV",
    "PATH",
    "A-B",
    "1A",
    "",
  ]) {
    expect(() => collectRunEnvironment({}, [`${name}=${ref}`])).toThrow();
    expect(() => collectRunEnvironment({ [name]: ref }, [])).toThrow();
  }
  for (const assignment of ["NO_EQUALS", "X=bad", `X=${ref}/extra`])
    expect(() => collectRunEnvironment({}, [assignment])).toThrow();
  expect(() => collectRunEnvironment({}, [])).toThrow("No credential references found");
  expect(() =>
    collectRunEnvironment(
      {},
      Array.from(
        { length: 33 },
        (_, index) => `V${index}=inbot://credentials/${"a".repeat(32)}/field_${index}`,
      ),
    ),
  ).toThrow("32");
});

test("masks split, adjacent and overlapping secrets on bytes while preserving unmatched binary data", async () => {
  expect(
    (
      await masked(
        ["abcd", "abcdef", "bcde", "tiny"],
        [Buffer.from("prefix ab"), Buffer.from("cdefabcdti"), Buffer.from("ny suffix")],
      )
    ).toString(),
  ).toBe("prefix <concealed by inbot><concealed by inbot><concealed by inbot> suffix");
  const bytes = Buffer.from([0xff, 0x00, 0xc3, 0xa9, 0x80]);
  expect(await masked([secret], [bytes.subarray(0, 2), bytes.subarray(2)])).toEqual(bytes);
  expect(
    (
      await masked(
        ["abc", "", "password"],
        [Buffer.from("abc pass"), Buffer.from("word password pass")],
      )
    ).toString(),
  ).toBe("abc <concealed by inbot> <concealed by inbot> pass");
  const unicode = "s\u00e9cret\u00df";
  const encoded = Buffer.from(`before ${unicode} after`);
  for (let split = 1; split < encoded.length; split++)
    expect(
      (await masked([unicode], [encoded.subarray(0, split), encoded.subarray(split)])).toString(),
    ).toBe("before <concealed by inbot> after");
});

test("rejects remote origins, missing references and dangerous targets before any request", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    for (const url of [
      "https://remote.test",
      "http://127.0.0.2:8025",
      "http://localhost.evil.test",
    ]) {
      const result = await invoke(
        ["run", "--env", `X=${ref}`, "--", process.execPath, "-e", "process.exit(99)"],
        { env: { INBOT_URL: url, INBOT_API_KEY: "synthetic" } },
      );
      expect(result.code).toBe(4);
      expect(result.stderr.toString()).toContain("local-only");
    }
    const missing = await invoke(["run", "--", process.execPath]);
    expect(missing.code).toBe(2);
    expect(missing.stderr.toString()).toContain("No credential references found");
    expect((await invoke(["run", "--env", `PATH=${ref}`, "--", process.execPath])).code).toBe(2);
    expect((await invoke(["run", process.execPath])).code).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

test("injects ambient and explicit values without a shell and masks both streams, preserving exit codes", async ({
  api,
}) => {
  const credentials = await account(api);
  const result = await invoke(
    [
      "run",
      "--env",
      `EXPLICIT=${credentials.apiRef}`,
      "--",
      process.execPath,
      "-e",
      `if (process.env.AMBIENT !== ${JSON.stringify(secret)} || process.env.EXPLICIT !== 'synthetic-api-value' || process.argv[1] !== 'literal $(echo data)') process.exit(99); process.stdout.write(process.env.AMBIENT); process.stderr.write(process.env.EXPLICIT); process.exitCode = 23;`,
      "literal $(echo data)",
    ],
    { env: { ...credentials.env, AMBIENT: credentials.ref } },
  );
  expect(result.code).toBe(23);
  expect(result.stdout.toString()).toBe("<concealed by inbot>");
  expect(result.stderr.toString()).toBe("<concealed by inbot>");
  const owner = await invoke([
    "run",
    "--home",
    api.home,
    "--env",
    `X=${credentials.ref}`,
    "--",
    process.execPath,
    "-e",
    "process.stdout.write(process.env.X)",
  ]);
  expect(owner.code).toBe(0);
  expect(owner.stdout.toString()).toBe("<concealed by inbot>");
  const binary = await invoke(
    [
      "run",
      "--env",
      `X=${credentials.ref}`,
      "--",
      process.execPath,
      "-e",
      "process.stdout.write(Buffer.from([255, 0, 195, 169, 128])); process.stderr.write(Buffer.from([254, 0]));",
    ],
    { env: credentials.env },
  );
  expect(binary.stdout).toEqual(Buffer.from([255, 0, 195, 169, 128]));
  expect(binary.stderr).toEqual(Buffer.from([254, 0]));
  if (process.platform !== "win32") {
    const signal = await invoke(
      [
        "run",
        "--env",
        `X=${credentials.ref}`,
        "--",
        process.execPath,
        "-e",
        "process.kill(process.pid, 'SIGTERM')",
      ],
      { env: credentials.env },
    );
    expect(signal.code).toBe(128 + constants.signals.SIGTERM);
  }
  const unavailable = await invoke(
    ["run", "--env", `X=${credentials.ref}`, "--", join(api.home, "missing-command")],
    { env: credentials.env },
  );
  expect(unavailable.code).toBe(1);
  expect(unavailable.stderr.toString()).toContain("Could not start");
});

async function wrapper(api: Awaited<ReturnType<typeof fixture>>) {
  const entry = join(api.home, "run-cli.mjs");
  await symlink(join(process.cwd(), "node_modules"), join(api.home, "node_modules"), "junction");
  const bundled = await build({
    stdin: {
      contents: `import { runCli } from './apps/cli/src/cli.ts'; process.exitCode = await runCli(process.argv.slice(2), { env: process.env, stdout: t => process.stdout.write(t), stderr: t => process.stderr.write(t) });`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    write: false,
  });
  const output = bundled.outputFiles[0];
  if (output === undefined) throw new Error("Expected CLI bundle");
  await writeFile(entry, output.contents);
  return entry;
}

async function runWrapped(
  entry: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  signal?: NodeJS.Signals,
) {
  const child = spawn(process.execPath, [entry, "run", ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let signaled = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
    if (signal !== undefined && !signaled && Buffer.concat(stdout).includes(Buffer.from("ready"))) {
      signaled = true;
      child.kill(signal);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), signaled };
}

test("no-mask inherits both streams and forwards SIGINT/SIGTERM to the captured child", async ({
  api,
}) => {
  const credentials = await account(api);
  const entry = await wrapper(api);
  const env = { ...credentials.env, X: credentials.ref };
  const raw = await runWrapped(entry, env, [
    "--no-mask",
    "--",
    process.execPath,
    "-e",
    "process.stdout.write(process.env.X); process.stderr.write(process.env.X); process.exitCode = 17;",
  ]);
  expect(raw.code, raw.stderr.toString()).toBe(17);
  expect(raw.stdout.toString()).toBe(secret);
  expect(raw.stderr.toString()).toBe(secret);
  if (process.platform === "win32") return;
  for (const signal of ["SIGINT", "SIGTERM"] satisfies NodeJS.Signals[]) {
    const result = await runWrapped(
      entry,
      env,
      [
        "--no-mask",
        "--",
        process.execPath,
        "-e",
        `process.on('${signal}', () => { process.stdout.write('forwarded'); process.exit(31); }); process.stdout.write('ready'); setTimeout(() => process.exit(99), 3000);`,
      ],
      signal,
    );
    expect(result.signaled).toBe(true);
    expect(result.code, result.stderr.toString()).toBe(31);
    expect(result.stdout.toString()).toBe("readyforwarded");
  }
});
