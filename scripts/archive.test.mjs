import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const release = process.env.INBOT_TEST_RELEASE_DIR;

test(
  "release archives contain the target's Node and both native prebuilds with portable paths",
  { skip: !release },
  async () => {
    const directory = resolve(release);
    const sums = await readFile(join(directory, "SHA256SUMS"), "utf8");
    const archives = (await readdir(directory)).filter((name) =>
      /^inbot-.*\.(tar\.gz|zip)$/.test(name),
    );
    assert.ok(archives.length > 0);
    for (const archive of archives) {
      const target = archive.match(
        /(darwin-arm64|darwin-x64|linux-x64|linux-arm64|win32-x64|win32-arm64)\.(tar\.gz|zip)$/,
      )?.[1];
      assert.ok(target, `Unexpected archive: ${archive}`);
      const checksum = sums.split("\n").filter((line) => line.endsWith(`  ${archive}`));
      assert.equal(checksum.length, 1);
      assert.equal(
        createHash("sha256")
          .update(await readFile(join(directory, archive)))
          .digest("hex"),
        checksum[0].split(" ")[0],
      );
      const windows = target.startsWith("win32-");
      const entries = (
        await exec(
          windows ? "unzip" : "tar",
          windows ? ["-Z1", join(directory, archive)] : ["-tzf", join(directory, archive)],
          { maxBuffer: 16 * 1024 * 1024 },
        )
      ).stdout
        .split("\n")
        .filter(Boolean);
      const native = entries.filter((entry) => entry.endsWith(".node")).sort();
      const keyringTarget = `${target}${target.startsWith("linux-") ? "-gnu" : windows ? "-msvc" : ""}`;
      const sqlite = `inbot/application/node_modules/better-sqlite3-multiple-ciphers/prebuilds/${target}.node`;
      const keyring = `inbot/application/node_modules/@napi-rs/keyring-${keyringTarget}/keyring.${keyringTarget}.node`;
      assert.deepEqual(native, [sqlite, keyring].sort());
      for (const required of [
        "inbot/application/dist/apps/cli/src/main.js",
        "inbot/application/dist/apps/server/src/main.js",
        "inbot/application/dist/worker/inbound.js",
        "inbot/application/web/index.html",
        "inbot/runtime/LICENSE",
        "inbot/LICENSE",
        "inbot/THIRD_PARTY_NOTICES.md",
        "inbot/licenses/INDEX.md",
        "inbot/licenses/better-sqlite3-multiple-ciphers@13.0.3/LICENSE",
        "inbot/licenses/better-sqlite3-multiple-ciphers@13.0.3/SQLite3MultipleCiphers-LICENSE",
        "inbot/licenses/better-sqlite3-multiple-ciphers@13.0.3/SQLite3MultipleCiphers-NOTICES",
        `inbot/licenses/@napi-rs/keyring-${keyringTarget}@2.1.0/LICENSE`,
        "inbot/licenses/react@19.3.0/LICENSE",
        "inbot/licenses/dompurify@3.4.16/LICENSE",
        "inbot/licenses/unpdf@1.8.1/PDF.js-LICENSE",
        "inbot/licenses/unzipper@0.12.5/LICENSE",
        `inbot/inbot${windows ? ".cmd" : ""}`,
      ])
        assert.ok(entries.includes(required), `Missing ${required}`);
      assert.ok(
        entries.every(
          (entry) =>
            !/(^|\/)(\.git|\.env[^/]*)(\/|$)|^inbot\/application\/dist\/.*\.test\.[cm]?js$/.test(
              entry,
            ),
        ),
      );
      const temporary = await mkdtemp(join(tmpdir(), "inbot-archive-"));
      try {
        const runtime = `inbot/runtime/${windows ? "node.exe" : "bin/node"}`;
        const legal = [
          "inbot/LICENSE",
          "inbot/THIRD_PARTY_NOTICES.md",
          "inbot/licenses/INDEX.md",
          "inbot/application/package.json",
        ];
        const manifests = entries.filter((entry) =>
          /^inbot\/application\/node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*\/package\.json$/.test(
            entry,
          ),
        );
        const files = [runtime, sqlite, keyring, "inbot/BUILD.json", ...legal, ...manifests];
        if (windows)
          await exec("unzip", ["-q", join(directory, archive), ...files, "-d", temporary]);
        else await exec("tar", ["-xzf", join(directory, archive), "-C", temporary, ...files]);
        for (const file of [runtime, sqlite, keyring])
          assertArchitecture(await readFile(join(temporary, file)), target);
        const build = JSON.parse(await readFile(join(temporary, "inbot/BUILD.json")));
        assert.equal(build.target, target);
        assert.equal(build.node, "24.21.0");
        assert.equal(
          JSON.parse(await readFile(join(temporary, "inbot/application/package.json"))).license,
          "MIT",
        );
        for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
          assert.equal(
            await readFile(join(temporary, "inbot", file), "utf8"),
            await readFile(new URL(`../${file}`, import.meta.url), "utf8"),
          );
        const notices = await readFile(join(temporary, "inbot/licenses/INDEX.md"), "utf8");
        assert.match(notices, /## Publication blockers\n\nNone detected/);
        assert.doesNotMatch(notices, /\| (?:binary|buffers|chainsaw)@/);
        assert.ok(
          entries.every((entry) => !/node_modules\/(?:binary|buffers|chainsaw)\//.test(entry)),
        );
        for (const file of manifests) {
          const manifest = JSON.parse(await readFile(join(temporary, file), "utf8"));
          assert.ok(
            notices.includes(`| ${manifest.name}@${manifest.version} |`),
            `Missing notice for ${file}`,
          );
        }
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  },
);

function assertArchitecture(bytes, target) {
  if (target.startsWith("linux-")) {
    assert.equal(bytes.subarray(0, 4).toString("hex"), "7f454c46");
    assert.equal(bytes.readUInt16LE(18), target.endsWith("arm64") ? 183 : 62);
  } else if (target.startsWith("darwin-")) {
    assert.equal(bytes.readUInt32LE(0), 0xfeedfacf);
    assert.equal(bytes.readUInt32LE(4), target.endsWith("arm64") ? 0x0100000c : 0x01000007);
  } else {
    assert.equal(bytes.subarray(0, 2).toString(), "MZ");
    const header = bytes.readUInt32LE(0x3c);
    assert.equal(bytes.readUInt32LE(header), 0x4550);
    assert.equal(bytes.readUInt16LE(header + 4), target.endsWith("arm64") ? 0xaa64 : 0x8664);
  }
}

test("packaging refuses mismatched release tags before writing or downloading artifacts", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "inbot-tag-"));
  try {
    const script = join(dirname(fileURLToPath(import.meta.url)), "package.mjs");
    await assert.rejects(
      exec(process.execPath, [script, "--skip-build", "--output", temporary], {
        env: { ...process.env, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v999.999.999" },
      }),
      (error) => /Release tag must be/.test(error.stderr),
    );
    assert.deepEqual(await readdir(temporary), []);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
