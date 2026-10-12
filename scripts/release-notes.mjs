import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function changelogSection(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const heading = line.match(/^##\s+(?:\[([^\]]+)\]|(\S+))(?:\s.*)?$/);
    return (heading?.[1] ?? heading?.[2]) === version;
  });
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && /^#{1,2}\s/.test(line));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, output, ...extra] = process.argv.slice(2);
  if (!version || !output || extra.length)
    throw new Error("Usage: node scripts/release-notes.mjs VERSION OUTPUT");
  const changelog = await readFile("CHANGELOG.md", "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  await writeFile(output, changelogSection(changelog, version));
}
