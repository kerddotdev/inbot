import assert from "node:assert/strict";
import { test } from "node:test";
import { changelogSection } from "./release-notes.mjs";

test("curated notes select the exact version and keep nested headings", () => {
  const notes =
    "# Changelog\n\n## [Unreleased]\nFuture work\n\n## [0.1.0] - 2026-10-12\n\n### Added\n- Initial release\n\n## 0.0.9\nOld changes\n";
  assert.equal(changelogSection(notes, "0.1.0"), "### Added\n- Initial release");
  assert.equal(changelogSection(notes, "0.0.9"), "Old changes");
  assert.equal(changelogSection(notes, "0.1.1"), "");
});

test("plain and prerelease headings work without a following section", () => {
  assert.equal(changelogSection("## 0.1.0-rc.1\r\n\r\nPreview\r\n", "0.1.0-rc.1"), "Preview");
  assert.equal(changelogSection("## [0.1.0]\n\n", "0.1.0"), "");
  assert.equal(changelogSection("", "0.1.0"), "");
});
