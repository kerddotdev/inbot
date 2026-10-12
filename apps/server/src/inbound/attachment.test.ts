import { readFile } from "node:fs/promises";
import { extractAttachment } from "agentextract/attachment";
import { expect, test } from "vitest";

test("extracts XLSX attachment text with the overridden ExcelJS dependency", async () => {
  const content = await readFile(new URL("./fixtures/attachment.xlsx", import.meta.url));
  const result = await extractAttachment({
    content,
    filename: "attachment.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  expect(result).toEqual({
    status: "extracted",
    extraction:
      "=== Inventory ===\nItem\tQuantity\nSynthetic attachment\t7\t14\n\n=== Notes ===\nCompatibility fixture",
  });
});
