import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";

export async function atomicWrite(path: string, content: string, mode = 0o600) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", mode);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
