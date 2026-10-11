import { readFile } from "node:fs/promises";

export async function packageVersion(entry = import.meta.url): Promise<string> {
  const manifest: unknown = JSON.parse(
    await readFile(new URL("../../../package.json", entry), "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return readFile(new URL("../../../../package.json", entry), "utf8");
      throw error;
    }),
  );
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  )
    throw new Error("The package manifest must contain a version.");
  return manifest.version;
}
