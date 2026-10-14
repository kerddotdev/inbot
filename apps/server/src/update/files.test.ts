import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { atomicWrite } from "./files.js";

test("Windows replacement retries sharing errors while retaining the complete old file", async () => {
  const root = await mkdtemp(join(tmpdir(), "inbot-replace-"));
  const path = join(root, "inbot.cmd");
  try {
    await writeFile(path, "old launcher");
    const codes = ["EPERM", "EBUSY", "EACCES"];
    const replace = vi.fn<typeof rename>(async (from, to) => {
      const code = codes.shift();
      if (code) throw Object.assign(new Error("File is open"), { code });
      await rename(from, to);
    });
    const delay = vi.fn(async () => {
      expect(await readFile(path, "utf8")).toBe("old launcher");
    });
    await atomicWrite(path, "new launcher", 0o755, {
      platform: "win32",
      rename: replace,
      delay,
    });
    expect(delay.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(await readFile(path, "utf8")).toBe("new launcher");
    expect(await readdir(root)).toEqual(["inbot.cmd"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exhausted Windows replacement cleans up its temp file and reports a fix", async () => {
  const root = await mkdtemp(join(tmpdir(), "inbot-replace-"));
  const path = join(root, "inbot.cmd");
  try {
    await writeFile(path, "old launcher");
    const waits: number[] = [];
    await expect(
      atomicWrite(path, "new launcher", 0o755, {
        platform: "win32",
        rename: async () => {
          throw Object.assign(new Error("File is open"), { code: "EPERM" });
        },
        delay: async (milliseconds) => {
          waits.push(milliseconds);
          expect(await readFile(path, "utf8")).toBe("old launcher");
        },
      }),
    ).rejects.toMatchObject({
      code: "action_required",
      message: expect.stringContaining("previous file is unchanged"),
      fix: expect.stringContaining("retry inbot update"),
    });
    expect(waits.reduce((sum, delay) => sum + delay, 0)).toBe(2_000);
    expect(Math.max(...waits)).toBeLessThanOrEqual(250);
    expect(await readFile(path, "utf8")).toBe("old launcher");
    expect(await readdir(root)).toEqual(["inbot.cmd"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["linux", "EPERM"],
  ["darwin", "EBUSY"],
  ["win32", "ENOSPC"],
])("%s replacement fails immediately on %s", async (platform, code) => {
  const root = await mkdtemp(join(tmpdir(), "inbot-replace-"));
  const path = join(root, "launcher");
  try {
    await writeFile(path, "old launcher");
    const error = Object.assign(new Error("Cannot rename"), { code });
    const replace = vi.fn<typeof rename>(async () => {
      throw error;
    });
    const delay = vi.fn(async () => {});
    await expect(
      atomicWrite(path, "new launcher", 0o755, { platform, rename: replace, delay }),
    ).rejects.toBe(error);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe("old launcher");
    expect(await readdir(root)).toEqual(["launcher"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
