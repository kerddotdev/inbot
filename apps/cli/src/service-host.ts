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
  const child = spawn(process.execPath, args, {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", stdout.fd, stderr.fd],
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
