import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stagePackageNotices } from "./package-notices.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "inbot-notices-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function packageAt(directory, manifest, files = {}) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files))
    await writeFile(join(directory, name), content);
}

test("notices preserve nested dependency versions and upstream texts without build-only packages", async () => {
  await fixture(async (root) => {
    const app = join(root, "application");
    const alpha = join(app, "node_modules/@scope/alpha");
    const beta = join(app, "node_modules/beta");
    const nested = join(alpha, "node_modules/beta");
    await packageAt(app, {
      dependencies: { "@scope/alpha": "1.0.0", beta: "2.0.0", string_decoder: "1.0.0" },
      devDependencies: { missingBuildTool: "1.0.0" },
    });
    await packageAt(
      alpha,
      {
        name: "@scope/alpha",
        version: "1.0.0",
        license: "MIT",
        dependencies: { beta: "1.0.0" },
        optionalDependencies: { unavailablePlatform: "1.0.0" },
      },
      { "LICENSE.md": "original scoped license\n", NOTICE: "additional attribution\n" },
    );
    for (const [directory, version] of [
      [beta, "2.0.0"],
      [nested, "1.0.0"],
    ])
      await packageAt(
        directory,
        { name: "beta", version, license: "ISC" },
        { LICENSE: `original ${version}\n` },
      );
    await packageAt(
      join(app, "node_modules/string_decoder"),
      {
        name: "string_decoder",
        version: "1.0.0",
        license: "MIT",
      },
      { LICENSE: "original package license, separate from the Node builtin\n" },
    );
    const output = join(root, "licenses");
    const entries = await stagePackageNotices([{ directory: app }], output);
    assert.deepEqual(
      entries.map((entry) => entry.identity),
      ["@scope/alpha@1.0.0", "beta@1.0.0", "beta@2.0.0", "string_decoder@1.0.0"],
    );
    assert.equal(
      await readFile(join(output, "@scope/alpha@1.0.0/NOTICE"), "utf8"),
      "additional attribution\n",
    );
    assert.equal(await readFile(join(output, "beta@1.0.0/LICENSE"), "utf8"), "original 1.0.0\n");
    assert.match(await readFile(join(output, "INDEX.md"), "utf8"), /None detected/);
  });
});

test("a declared license alone does not silently clear missing distribution materials", async () => {
  await fixture(async (root) => {
    await packageAt(root, { dependencies: { sample: "1.0.0" } });
    await packageAt(join(root, "node_modules/sample"), {
      name: "sample",
      version: "1.0.0",
      license: "MIT",
    });
    await assert.rejects(
      stagePackageNotices([{ directory: root }], join(root, "licenses")),
      /Missing license material for sample@1.0.0/,
    );
  });
});

test("removed unlicensed helpers fail packaging if reintroduced", async () => {
  for (const [name, version, license] of [
    ["buffers", "0.1.1", undefined],
    ["binary", "0.3.0", "MIT"],
    ["chainsaw", "0.1.0", "MIT/X11"],
  ])
    await fixture(async (root) => {
      await packageAt(root, { dependencies: { [name]: version } });
      await packageAt(
        join(root, "node_modules", name),
        { name, version, license },
        { "README.markdown": "upstream readme\n" },
      );
      await assert.rejects(stagePackageNotices([{ directory: root }], join(root, "licenses")), {
        message: `Missing license material for ${name}@${version}`,
      });
    });
});
