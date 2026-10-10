import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { packagedArguments } from "./packaged.js";

test("packaged commands share the production home and serve the bundled UI with explicit overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "inbot-packaged-"));
  try {
    const entry = pathToFileURL(join(root, "application/dist/apps/cli/src/main.js")).href;
    const web = join(root, "application/web") + sep;
    await mkdir(join(root, "application/dist/apps/cli/src"), { recursive: true });
    expect(packagedArguments(["serve"], entry)).toEqual(["serve"]);
    await writeFile(join(root, "BUILD.json"), "{}");
    expect(packagedArguments(["serve"], entry)).toEqual([
      "serve",
      "--flavor",
      "production",
      "--web-root",
      web,
    ]);
    expect(packagedArguments(["inboxes", "list"], entry)).toEqual([
      "inboxes",
      "list",
      "--flavor",
      "production",
    ]);
    const args = ["serve", "--flavor", "development", "--web-root=/custom/web"];
    expect(packagedArguments(args, entry)).toEqual(args);
    const equals = ["serve", "--flavor=development", "--web-root", "/custom/web"];
    expect(packagedArguments(equals, entry)).toEqual(equals);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
