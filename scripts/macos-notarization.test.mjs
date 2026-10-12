import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { notarizeArchive } from "./macos-notarization.mjs";

for (const status of ["Accepted", "Invalid"]) {
  test(`notarization ${status} fetches the log before deciding whether publication may proceed`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), "inbot-notary-test-"));
    const calls = [];
    try {
      const run = async (_command, args) => {
        calls.push(args);
        if (args[1] === "submit") {
          const stdout = JSON.stringify({ id: "synthetic-submission", status });
          if (status === "Invalid")
            throw Object.assign(new Error("notarytool exited 1"), { stdout });
          return { stdout };
        }
        assert.equal(args[1], "log");
        assert.equal(args[2], "synthetic-submission");
        await writeFile(args.at(-1), JSON.stringify({ status, issues: [] }));
        return { stdout: "" };
      };
      const result = notarizeArchive(
        "payload.zip",
        ["--key", "synthetic.p8"],
        join(temporary, "log.json"),
        run,
      );
      if (status === "Accepted") assert.equal(await result, "synthetic-submission");
      else await assert.rejects(result, /Notarization Invalid: synthetic-submission/);
      assert.equal(calls.length, 2);
      assert.ok(calls[0].includes("--wait"));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
}

test("notarization transport failure cannot be mistaken for acceptance", async () => {
  const failure = new Error("Apple service unavailable");
  await assert.rejects(
    notarizeArchive("payload.zip", [], "unused.json", async () => {
      throw failure;
    }),
    failure,
  );
});
