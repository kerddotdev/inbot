import { mkdtemp, rm, readFile, writeFile, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, test as base } from "vitest";
import {
  BitwardenExport,
  ImportCredentialsResponse,
} from "../../../packages/contracts/src/bitwarden.js";
import { fixture } from "../../server/src/http/test-fixture.js";
import { runCli, type CliIO } from "./cli.js";

const inbox = "agent@example.test";
const target = "other@example.test";
const secret = "SyntheticBitwardenPassword!";
const test = base.extend<{ api: Awaited<ReturnType<typeof fixture>> }>({
  api: async ({ task: _task }, use) => {
    const home = await mkdtemp(join(tmpdir(), "inbot-cli-bitwarden-"));
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
async function invoke(
  api: Awaited<ReturnType<typeof fixture>>,
  args: string[],
  options: Partial<CliIO> = {},
) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    env: { INBOT_HOME: api.home },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    ...options,
  });
  return { code, stdout, stderr };
}
async function credential(api: Awaited<ReturnType<typeof fixture>>) {
  expect(
    (
      await api.request(`/v0/inboxes/${inbox}/credentials`, {
        method: "POST",
        body: { name: "CLI login", fields: { password: secret } },
      })
    ).status,
  ).toBe(200);
}

test("exports private JSON files, refuses overwrite and tightens permissions with explicit force", async ({
  api,
}) => {
  await credential(api);
  const file = join(api.home, "export.json");
  const args = ["credentials", "export", "--inbox", inbox, "-o", file];
  expect(await invoke(api, args)).toEqual({ code: 0, stdout: "", stderr: "" });
  const json = await readFile(file, "utf8");
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(BitwardenExport))(json).items[0]?.login
      ?.password,
  ).toBe(secret);
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  await writeFile(file, "keep this synthetic file");
  const refused = await invoke(api, args);
  expect(refused.code).toBe(1);
  expect(refused.stdout).toBe("");
  expect(refused.stderr).not.toContain(secret);
  expect(await readFile(file, "utf8")).toBe("keep this synthetic file");
  if (process.platform !== "win32") await chmod(file, 0o644);
  expect((await invoke(api, [...args, "--force"])).code).toBe(0);
  expect(await readFile(file, "utf8")).toBe(json);
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
});

test("prints secrets only with explicit -o - even when stdout is redirected", async ({ api }) => {
  await credential(api);
  for (const extra of [[], ["--json"], ["--json", "-o", "-"], ["--force"]]) {
    const result = await invoke(api, ["credentials", "export", ...extra], { stdoutIsTTY: false });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(secret);
  }
  const printed = await invoke(api, ["credentials", "export", "-o", "-"], { stdoutIsTTY: true });
  expect(printed.code).toBe(0);
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(BitwardenExport))(printed.stdout).items[0]?.login
      ?.password,
  ).toBe(secret);
});

test("imports a file into the required inbox with duplicate options and metadata-only output", async ({
  api,
}) => {
  await credential(api);
  const file = join(api.home, "export.json");
  expect((await invoke(api, ["credentials", "export", "--inbox", inbox, "-o", file])).code).toBe(0);
  const args = ["credentials", "import", "--inbox", target, "--file", file, "--json"];
  for (const [extra, expected] of [
    [[], { imported: 1, skipped: 0 }],
    [[], { imported: 0, skipped: 1 }],
    [["--on-duplicate", "create"], { imported: 1, skipped: 0 }],
  ] as const) {
    const result = await invoke(api, [...args, ...extra]);
    expect(result.code).toBe(0);
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(ImportCredentialsResponse))(result.stdout),
    ).toMatchObject(expected);
    expect(result.stdout).not.toContain(secret);
  }
  for (const invalid of [
    ["credentials", "import", "--file", file],
    ["credentials", "import", "--inbox", target],
    ["credentials", "import", "--inbox", target, "--file", join(api.home, "missing.json")],
    [...args, "--on-duplicate", "replace"],
  ])
    expect((await invoke(api, invalid)).code).toBe(2);
  await writeFile(file, JSON.stringify({ encrypted: true, items: [] }));
  const encrypted = await invoke(api, args);
  expect(encrypted.code).toBe(2);
  expect(encrypted.stderr).toContain("unencrypted JSON");
});

test("rejects agents and prevents plaintext imports to non-loopback connections", async ({
  api,
}) => {
  await credential(api);
  const file = join(api.home, "import.json");
  await writeFile(
    file,
    JSON.stringify({ items: [{ type: 1, name: "Import", login: { password: secret } }] }),
  );
  const key = await api.run(
    api.keys.create({
      inbox_ids: [inbox],
      permissions: { credential_read: true, credential_create: true },
      send_policy: "direct",
    }),
  );
  for (const args of [
    ["credentials", "export", "-o", "-"],
    ["credentials", "import", "--inbox", inbox, "--file", file],
  ]) {
    const denied = await invoke(api, args, {
      env: { INBOT_URL: api.url, INBOT_API_KEY: key.api_key },
    });
    expect(denied.code).toBe(4);
    expect(denied.stdout).toBe("");
    expect(denied.stderr).toContain("missing_permission");
    const remote = await invoke(api, args, {
      env: { INBOT_URL: "https://inbot.example.test", INBOT_API_KEY: key.api_key },
    });
    expect(remote.code).toBe(2);
    expect(remote.stderr).toContain("loopback");
  }
});

test("lists import and export help with the required safety options", async ({ api }) => {
  const help = await invoke(api, ["credentials", "--help"]);
  expect(help.stdout).toContain("credentials export");
  expect(help.stdout).toContain("credentials import");
  const exported = await invoke(api, ["credentials", "export", "--help"]);
  expect(exported.stdout).toContain("--output");
  expect(exported.stdout).toContain("--force");
  expect(exported.stdout).toContain("-o -");
  const imported = await invoke(api, ["credentials", "import", "--help"]);
  expect(imported.stdout).toContain("--inbox");
  expect(imported.stdout).toContain("--file");
  expect(imported.stdout).toContain("--on-duplicate");
});
