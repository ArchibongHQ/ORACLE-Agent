import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@oracle/storage": resolve(__dirname, "./src/index.ts"),
    },
  },
});
