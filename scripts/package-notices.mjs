import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const licenseName = /^(?:COPYING|COPYRIGHT|LICEN[CS]E|NOTICE)(?:[._-].*)?$/i;
const supplements = join(dirname(fileURLToPath(import.meta.url)), "licenses");

export async function stagePackageNotices(roots, output) {
  const seen = new Set();
  const notices = new Map();

  async function visit(directory, include = true) {
    directory = await realpath(directory);
    if (seen.has(directory)) return;
    seen.add(directory);
    const manifestPath = join(directory, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const require = createRequire(manifestPath);

    async function locate(name, optional = false) {
      for (const modules of require.resolve.paths(`${name}/package.json`) ?? []) {
        const candidate = join(modules, name);
        try {
          await readFile(join(candidate, "package.json"));
          return candidate;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      if (!optional) throw new Error(`Missing dependency for notices: ${name}`);
    }

    if (include && !manifest.name.startsWith("@inbot/")) {
      const identity = `${manifest.name}@${manifest.version}`;
      const files = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && licenseName.test(entry.name))
        .map((entry) => ({ source: join(directory, entry.name), name: entry.name }));
      if (identity === "isarray@1.0.0")
        files.push({ source: join(directory, "README.md"), name: "README.md" });
      if (identity === "saxes@5.0.1")
        files.push({ source: join(supplements, "saxes-5.0.1-LICENSE"), name: "LICENSE" });
      if (
        (manifest.name === "redis" || manifest.name.startsWith("@redis/")) &&
        manifest.version === "6.3.0"
      )
        files.push({ source: join(supplements, "redis-6.3.0-LICENSE"), name: "LICENSE" });
      if (manifest.name.startsWith("@napi-rs/keyring-")) {
        const parent = await locate("@napi-rs/keyring");
        const parentManifest = JSON.parse(await readFile(join(parent, "package.json"), "utf8"));
        if (parentManifest.version !== manifest.version)
          throw new Error(`Keyring notice version mismatch: ${identity}`);
        files.push({ source: join(parent, "LICENSE"), name: "LICENSE" });
      }
      if (identity === "better-sqlite3-multiple-ciphers@13.0.3")
        for (const kind of ["LICENSE", "NOTICES"])
          files.push({
            source: join(supplements, `sqlite3mc-2.4.0-${kind}`),
            name: `SQLite3MultipleCiphers-${kind}`,
          });
      if (identity === "unpdf@1.8.1")
        files.push({ source: join(supplements, "pdfjs-6.1.200-LICENSE"), name: "PDF.js-LICENSE" });
      for (const [name, version] of [
        ["better-sqlite3-multiple-ciphers", "13.0.3"],
        ["unpdf", "1.8.1"],
      ])
        if (manifest.name === name && manifest.version !== version)
          throw new Error(`Review embedded component licenses for ${identity}`);
      if (files.length === 0 || typeof manifest.license !== "string")
        throw new Error(`Missing license material for ${identity}`);
      const destination = join(output, identity);
      await mkdir(destination, { recursive: true });
      for (const file of files) await copyFile(file.source, join(destination, file.name));
      notices.set(identity, {
        identity,
        license: manifest.license ?? "NOASSERTION",
        files: [...new Set(files.map((file) => file.name))].sort(),
      });
    }

    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    })) {
      const optional =
        name in (manifest.optionalDependencies ?? {}) || name in (manifest.peerDependencies ?? {});
      const dependency = await locate(name, optional);
      if (dependency) await visit(dependency);
    }
  }

  for (const { directory, include = false } of roots) await visit(directory, include);
  await mkdir(output, { recursive: true });
  const entries = [...notices.values()].sort((a, b) => a.identity.localeCompare(b.identity, "en"));
  await writeFile(
    join(output, "INDEX.md"),
    "# Bundled package notices\n\n" +
      "Generated from installed production dependencies and the owner UI dependency tree. Node's upstream notices are in `../runtime/LICENSE`. See `../THIRD_PARTY_NOTICES.md` for supplement provenance.\n\n" +
      "| Package | Declared license | Materials |\n| --- | --- | --- |\n" +
      entries
        .map(
          ({ identity, license, files }) =>
            `| ${identity} | ${license} | ${files.map((name) => `[${name}](${identity}/${name})`).join(", ")} |\n`,
        )
        .join("") +
      "\n## Publication blockers\n\n" +
      "None detected.\n",
  );
  return entries;
}
