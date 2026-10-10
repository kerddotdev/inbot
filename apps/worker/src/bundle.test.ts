import { build } from "esbuild";
import { expect, test } from "vitest";

test("builds one ES module without Effect or Node imports", async () => {
  const result = await build({
    entryPoints: ["apps/worker/src/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2024",
    minify: true,
    metafile: true,
    write: false,
  });
  expect(result.outputFiles).toHaveLength(1);
  expect(result.outputFiles[0]?.contents.byteLength).toBeLessThan(150_000);
  expect(
    Object.keys(result.metafile.inputs).some((path) => /node_modules\/.*effect\//.test(path)),
  ).toBe(false);
  expect(result.outputFiles[0]?.text).not.toContain("node:");
  expect(result.outputFiles[0]?.text).toContain("export{");
});
