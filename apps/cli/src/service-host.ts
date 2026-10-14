import { homedir } from "node:os";
import { activeBundle, bundlePaths, detectLayout } from "../../server/src/update/layout.js";
import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const args = process.argv.slice(2);
const { values } = parseArgs({
  args,
  allowPositionals: true,
  options: { home: { type: "string" }, port: { type: "string" }, flavor: { type: "string" } },
});
if (!values.home) throw new Error("The service host requires an explicit home.");
const stdout = await open(join(values.home, "logs", "service.log"), "a", 0o600);
const stderr = await open(join(values.home, "logs", "service.err.log"), "a", 0o600);
try {
  const cli = args[0];
  if (!cli) throw new Error("The service host requires the CLI entry point.");
  const layout = await detectLayout({
    executable: process.execPath,
    cli,
    platform: process.platform,
    arch: process.arch,
    userHome: homedir(),
    ...(process.env.PATH === undefined ? {} : { path: process.env.PATH }),
  }).catch(() => undefined);
  const selected = layout
    ? bundlePaths(await activeBundle(layout), layout.windows)
    : { executable: process.execPath, cli };
  const child = spawn(selected.executable, [selected.cli, ...args.slice(1)], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", stdout.fd, stderr.fd, "ipc"],
    env: { ...process.env, INBOT_SERVICE_HOME: values.home },
  });
  process.once("SIGTERM", () => child.kill("SIGTERM"));
  process.once("SIGINT", () => child.kill("SIGINT"));
  process.exitCode = await new Promise<number>((done, reject) => {
    child.once("error", reject);
    child.once("close", (code) => done(code ?? 1));
  });
} finally {
  await stdout.close();
  await stderr.close();
}
