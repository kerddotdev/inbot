import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

export async function notarizeArchive(zip, authentication, logPath, run = promisify(execFile)) {
  const { stdout } = await run(
    "/usr/bin/xcrun",
    ["notarytool", "submit", zip, ...authentication, "--wait", "--output-format", "json"],
    { timeout: 1_800_000 },
  ).catch((error) => {
    if (error.stdout?.trim()) return { stdout: error.stdout };
    throw error;
  });
  const result = JSON.parse(stdout);
  if (typeof result.id !== "string") throw new Error("Notary service returned no submission ID.");
  await run("/usr/bin/xcrun", ["notarytool", "log", result.id, ...authentication, logPath]);
  const log = await readFile(logPath, "utf8");
  console.log(log);
  if (result.status !== "Accepted") throw new Error(`Notarization ${result.status}: ${result.id}`);
  return result.id;
}
