import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { atomicWrite } from "./files.js";
import { bundlePaths, renderShim } from "./layout.js";

test("Windows installer and updater emit the same replacement-safe launcher", async () => {
  const bundle = join("installation", "app", "0.2.0");
  const shim = renderShim(bundle, true);
  const invocation = shim.split("\r\n").find((line) => line.includes(" %*"));
  expect(invocation).toMatch(/ %\* & .*exit \/b %%INBOT_EXIT_CODE%%$/);
  expect(shim.trimEnd().endsWith(invocation ?? "missing invocation")).toBe(true);
  const installer = await readFile(new URL("../../../../install.ps1", import.meta.url), "utf8");
  const template = installer.match(/\$ShimContent = @"\r?\n([\s\S]+?)\r?\n"@/)?.[1];
  const { executable, cli } = bundlePaths(bundle, true);
  expect(
    template
      ?.replace("$Destination\\runtime\\node.exe", executable)
      .replace("$Destination\\application\\dist\\apps\\cli\\src\\main.js", cli)
      .replaceAll("\r\n", "\n"),
  ).toBe(shim.replaceAll("\r\n", "\n").trimEnd());
});

test.skipIf(process.platform !== "win32").each([0, 37])(
  "running Windows launcher survives replacement and returns Node exit code %s",
  async (code) => {
    const root = await mkdtemp(join(tmpdir(), "inbot-shim-"));
    const shim = join(root, "inbot.cmd");
    const paths = bundlePaths(join(root, "app with spaces \u00e9", "0.2.0"), true);
    try {
      await mkdir(dirname(paths.executable), { recursive: true });
      await mkdir(dirname(paths.cli), { recursive: true });
      await cp(process.execPath, paths.executable);
      await writeFile(
        paths.cli,
        `process.stdin.once("data", () => process.exit(${code})); console.log("READY " + JSON.stringify(process.argv.slice(2)));`,
      );
      await writeFile(shim, renderShim(join(root, "app with spaces \u00e9", "0.2.0"), true));
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          'chcp 437 > $null; & $env:INBOT_TEST_SHIM "literal!argument" "two words"; $code = $LASTEXITCODE; chcp; exit $code',
        ],
        { env: { ...process.env, INBOT_TEST_SHIM: shim, INBOT_HOME: join(root, "home") } },
      );
      try {
        let stdout = "";
        let stderr = "";
        const ready = Promise.withResolvers<void>();
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
          if (stdout.includes("READY ")) ready.resolve();
        });
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        const finished = new Promise<number | null>((resolve, reject) => {
          child.once("error", (error) => {
            ready.reject(error);
            reject(error);
          });
          child.once("close", (exitCode) => {
            ready.reject(new Error(`Launcher exited before Node was ready: ${stderr}`));
            resolve(exitCode);
          });
        });
        await ready.promise;
        // Any further read at the old batch offset executes a trap instead of cleanup.
        const replacement = "echo UNEXPECTED_BATCH_READ & exit /b 99\r\n".repeat(1_000);
        await atomicWrite(shim, replacement);
        child.stdin.end("continue\n");
        expect(await finished, stderr).toBe(code);
        expect(stdout).toContain('READY ["literal!argument","two words"]');
        expect(stdout).toContain("437");
        expect(stdout).not.toContain("UNEXPECTED_BATCH_READ");
        expect(await readFile(shim, "utf8")).toBe(replacement);
      } finally {
        if (child.exitCode === null) child.kill();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
