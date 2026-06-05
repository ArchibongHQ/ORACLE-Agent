import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@oracle/storage': resolve(__dirname, './src/index.ts'),
    },
  },
});
