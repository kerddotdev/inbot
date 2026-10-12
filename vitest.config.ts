import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    // The Windows CI guest is markedly slower at process and file system work.
    testTimeout: process.platform === "win32" ? 20_000 : 5_000,
  },
});
