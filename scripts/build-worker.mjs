import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("dist/worker", { recursive: true });
const result = await build({
  entryPoints: ["apps/worker/src/index.ts"],
  outfile: "dist/worker/inbound.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2024",
  minify: true,
  metafile: true,
});
if (Object.keys(result.metafile.inputs).some((path) => /node_modules\/.*effect\//.test(path))) {
  throw new Error("The inbound Worker must not include Effect.");
}
const bytes = result.metafile.outputs["dist/worker/inbound.js"].bytes;
if (bytes >= 150_000) throw new Error("The inbound Worker exceeds the 150 KB bundle limit.");
console.log(`Inbound Worker: ${bytes} bytes`);
