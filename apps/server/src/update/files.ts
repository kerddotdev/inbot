import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { UpdateError } from "./errors.js";

export async function atomicWrite(
  path: string,
  content: string,
  mode = 0o600,
  io: {
    platform?: string;
    rename?: typeof rename;
    delay?: (milliseconds: number) => Promise<void>;
  } = {},
) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", mode);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        await (io.rename ?? rename)(temporary, path);
        break;
      } catch (error) {
        if (
          (io.platform ?? process.platform) !== "win32" ||
          !(error instanceof Error && "code" in error) ||
          !["EPERM", "EBUSY", "EACCES"].includes(String(error.code))
        )
          throw error;
        if (waited >= 2_000)
          throw new UpdateError(
            `Windows could not replace ${path}; the previous file is unchanged.`,
            "Close programs holding this file open, check its permissions, and retry inbot update. If antivirus is scanning it, wait for the scan to finish.",
          );
        const delay = Math.min(25 * 2 ** attempt, 250, 2_000 - waited);
        await (io.delay ?? setTimeout)(delay);
        waited += delay;
      }
    }
  } finally {
    await rm(temporary, { force: true, maxRetries: 3, retryDelay: 50, recursive: true });
  }
}
