import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import { runCommand, type CommandRunner } from "../../../cli/src/service.js";
import { runCli } from "../../../cli/src/cli.js";
import { prepareUpdate, tarProgram } from "./install.js";
import {
  activeBundle,
  bundlePaths,
  detectLayout,
  renderShim,
  type InstalledLayout,
} from "./layout.js";
import { checkRelease } from "./release.js";
import { compareVersions, parseVersion } from "./version.js";

export async function updateFixture(target = `${process.platform}-${process.arch}`) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "inbot-update-")));
  const windows = process.platform === "win32";
  const bundle = join(root, "app", "0.1.0");
  const shim = join(root, "bin", windows ? "inbot.cmd" : "inbot");
  const layout: InstalledLayout = { root, bundle, current: "0.1.0", target, shim, windows };
  const createBundle = async (directory: string, version: string) => {
    const paths = bundlePaths(directory, windows);
    for (const file of [
      paths.executable,
      paths.cli,
      join(directory, windows ? "inbot.cmd" : "inbot"),
    ]) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "synthetic release", { mode: 0o755 });
    }
    await writeFile(join(directory, "BUILD.json"), JSON.stringify({ version, target }));
  };
  await createBundle(bundle, "0.1.0");
  await mkdir(dirname(shim));
  await writeFile(shim, renderShim(bundle, windows));
  await writeFile(join(bundle, ".archive-sha256"), "1".repeat(64));
  await writeFile(join(root, "installation.json"), JSON.stringify({ shim }));
  const stage = join(root, "fixture");
  await createBundle(join(stage, "inbot"), "0.2.0");
  const archive = `inbot-0.2.0-${target}.${windows ? "zip" : "tar.gz"}`;
  const archivePath = join(root, archive);
  const packed = await runCommand(tarProgram, [
    windows ? "-acf" : "-czf",
    archivePath,
    "-C",
    stage,
    "inbot",
  ]);
  if (packed.code) throw new Error(packed.stderr);
  const bytes = await readFile(archivePath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).includes("api.github.com"))
      return Response.json({ tag_name: "v0.2.0", draft: false, prerelease: false });
    if (String(url).endsWith("SHA256SUMS")) return new Response(`${hash}  ${archive}\n`);
    if (String(url).endsWith(archive)) return new Response(new Uint8Array(bytes));
    throw new Error("Unexpected network request");
  });
  const run: CommandRunner = async (program, args) =>
    program.includes("codesign")
      ? { code: 0, stdout: "", stderr: "TeamIdentifier=7LA5DMHTL9\n" }
      : runCommand(program, args);
  return {
    root,
    layout,
    fetcher,
    run,
    hash,
    createBundle,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("semantic versions order numeric components and prerelease identifiers without build metadata", () => {
  const versions = [
    "0.1.0-alpha",
    "0.1.0-alpha.2",
    "0.1.0-alpha.10",
    "0.1.0-beta",
    "0.1.0",
    "0.2.0",
    "0.10.0",
    "1.0.0",
  ];
  for (let i = 1; i < versions.length; i++)
    expect(compareVersions(versions[i - 1] ?? "", versions[i] ?? "")).toBe(-1);
  expect(compareVersions("1.0.0+abc", "1.0.0+def")).toBe(0);
  for (const invalid of ["01.0.0", "1.0", "../1.0.0", "1.0.0-01", "1.0.0-"])
    expect(() => parseVersion(invalid)).toThrow();
});

test("release checks exclude drafts and implicit prereleases and never offer a downgrade", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ tag_name: "v0.2.0-beta.1", draft: false, prerelease: true }),
  );
  await expect(checkRelease("0.1.0", undefined, fetcher)).rejects.toThrow();
  await expect(checkRelease("0.1.0", "0.2.0-beta.1", fetcher)).resolves.toMatchObject({
    update_available: true,
  });
  await expect(checkRelease("1.0.0", "0.2.0-beta.1", fetcher)).resolves.toMatchObject({
    update_available: false,
  });
  fetcher.mockResolvedValue(Response.json({ tag_name: "v0.2.0", draft: true, prerelease: false }));
  await expect(checkRelease("0.1.0", "0.2.0", fetcher)).rejects.toThrow();
});

test("detects installed layouts and refuses source or unknown launchers", async () => {
  const f = await updateFixture();
  try {
    const input = {
      ...bundlePaths(f.layout.bundle, f.layout.windows),
      platform: process.platform,
      arch: process.arch,
      userHome: f.root,
    };
    expect(await detectLayout(input)).toEqual(f.layout);
    await expect(detectLayout({ ...input, executable: process.execPath })).rejects.toMatchObject({
      code: "action_required",
    });
    await writeFile(f.layout.shim, "custom launcher");
    await expect(detectLayout(input)).rejects.toMatchObject({
      fix: expect.stringContaining("install.sh"),
    });
  } finally {
    await f.close();
  }
});

test("verified installation keeps old versions and switches a complete shim atomically", async () => {
  const f = await updateFixture();
  try {
    const old = await readFile(f.layout.shim, "utf8");
    const prepared = await prepareUpdate(f.layout, "0.2.0", f.run, f.fetcher);
    try {
      expect(await readFile(f.layout.shim, "utf8")).toBe(old);
      await expect(prepareUpdate(f.layout, "0.2.0", f.run, f.fetcher)).rejects.toThrow(/progress/);
      const next = renderShim(prepared.destination, f.layout.windows);
      let done = false;
      const observations = new Set<string>();
      await Promise.all([
        prepared.activate().finally(() => {
          done = true;
        }),
        (async () => {
          do {
            observations.add(await readFile(f.layout.shim, "utf8"));
          } while (!done);
        })(),
      ]);
      expect([...observations].every((text) => text === old || text === next)).toBe(true);
      expect(await activeBundle(f.layout)).toBe(prepared.destination);
      expect(await readFile(join(f.layout.bundle, ".archive-sha256"), "utf8")).toBe("1".repeat(64));
    } finally {
      await prepared.close();
    }
    await writeFile(join(f.root, "app", "0.2.0", ".archive-sha256"), "2".repeat(64));
    await expect(prepareUpdate(f.layout, "0.2.0", f.run, f.fetcher)).rejects.toThrow(
      /different archive/,
    );
  } finally {
    await f.close();
  }
});

test("checksum and signature failures leave the old launcher untouched", async () => {
  const f = await updateFixture(`darwin-${process.arch}`);
  try {
    const old = await readFile(f.layout.shim, "utf8");
    const badChecksum: typeof fetch = async (url, init) =>
      String(url).endsWith("SHA256SUMS") ? new Response("bad digest") : f.fetcher(url, init);
    await expect(prepareUpdate(f.layout, "0.2.0", f.run, badChecksum)).rejects.toThrow(/SHA-256/);
    for (const identity of [
      { code: 1, stderr: "" },
      { code: 0, stderr: "TeamIdentifier=WRONG\n" },
    ]) {
      const badSignature: CommandRunner = (program, args) =>
        program.includes("codesign")
          ? Promise.resolve({ ...identity, stdout: "" })
          : f.run(program, args);
      await expect(prepareUpdate(f.layout, "0.2.0", badSignature, f.fetcher)).rejects.toThrow(
        /signature/,
      );
      expect(await readFile(f.layout.shim, "utf8")).toBe(old);
    }
  } finally {
    await f.close();
  }
});

test("CLI check uses fake GitHub without manager calls and rejects agent context", async () => {
  const f = await updateFixture();
  try {
    const run = vi.fn(f.run);
    let stdout = "";
    const io = {
      env: {},
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: () => {},
      updateFetch: f.fetcher,
      serviceRuntime: {
        ...bundlePaths(f.layout.bundle, f.layout.windows),
        platform: process.platform,
        packaged: true,
        userHome: f.root,
        uid: 501,
        username: "synthetic",
        run,
        health: async () => false,
      },
    };
    expect(await runCli(["update", "--check", "--json", "--home", f.root], io)).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      current: "0.1.0",
      latest: "0.2.0",
      update_available: true,
    });
    expect(run).not.toHaveBeenCalled();
    expect(await runCli(["update"], { ...io, env: { INBOT_API_KEY: "synthetic" } })).toBe(4);
  } finally {
    await f.close();
  }
});

test("CLI update reinstalls the service on the new runtime and preserves its port", async () => {
  const f = await updateFixture();
  try {
    const { makeService } = await import("../../../cli/src/service.js");
    const home = join(f.root, "home");
    await mkdir(home);
    await writeFile(
      join(home, "keys.json"),
      JSON.stringify({
        version: 1,
        keychain: { nonce: "00".repeat(12), ciphertext: "00".repeat(32), tag: "00".repeat(16) },
      }),
    );
    let registered = false;
    const managerCalls: string[][] = [];
    const runtime = {
      ...bundlePaths(f.layout.bundle, f.layout.windows),
      platform: process.platform,
      packaged: true,
      userHome: f.root,
      uid: 501,
      username: "synthetic",
      health: async () => registered,
      run: async (program: string, args: readonly string[]) => {
        if (program === tarProgram || program.includes("codesign")) return f.run(program, args);
        managerCalls.push([...args]);
        if (args.includes("bootout") || args.includes("disable") || args.includes("/Delete"))
          registered = false;
        if (
          args.includes("bootstrap") ||
          (args.includes("enable") && args.includes("--now")) ||
          args.includes("/Run")
        )
          registered = true;
        if (args[0] === "print")
          return {
            code: registered ? 0 : 113,
            stdout: registered ? "state = running\npid = 123\n" : "",
            stderr: "",
          };
        if (args.includes("show"))
          return {
            code: 0,
            stdout: registered
              ? "LoadState=loaded\nActiveState=active\nSubState=running\n"
              : "LoadState=not-found\n",
            stderr: "",
          };
        if (program === "powershell.exe")
          return { code: 0, stdout: registered ? "4" : "missing", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const installed = await makeService(runtime, home).install(9123);
    let output = "";
    expect(
      await runCli(["update", "--home", home, "--json"], {
        env: {},
        serviceRuntime: runtime,
        updateFetch: f.fetcher,
        stdout: (value) => {
          output += value;
        },
        stderr: () => {},
      }),
    ).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      installed: "0.2.0",
      service: { port: 9123, running: true, http_healthy: true },
    });
    expect(await readFile(installed.unit_path, "utf8")).toContain("0.2.0");
    expect(
      managerCalls.some(
        (args) => args.includes("bootout") || args.includes("disable") || args.includes("/Delete"),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test.runIf(process.platform !== "win32")(
  "installer roots reached through symlinked directories are recognized",
  async () => {
    const f = await updateFixture();
    try {
      const alias = join(f.root, "alias");
      await symlink(f.root, alias);
      await writeFile(f.layout.shim, renderShim(join(alias, "app", "0.1.0"), false));
      const input = {
        ...bundlePaths(join(alias, "app", "0.1.0"), false),
        platform: process.platform,
        arch: process.arch,
        userHome: f.root,
      };
      expect(await detectLayout(input)).toEqual(f.layout);
      const prepared = await prepareUpdate(f.layout, "0.2.0", f.run, f.fetcher);
      try {
        await prepared.activate();
        expect(await activeBundle(f.layout)).toBe(prepared.destination);
      } finally {
        await prepared.close();
      }
    } finally {
      await f.close();
    }
  },
);
