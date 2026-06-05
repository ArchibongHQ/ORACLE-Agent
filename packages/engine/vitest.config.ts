import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
  },
  resolve: {
    alias: {
      '@oracle/engine':  resolve(__dirname, './src/index.ts'),
      '@oracle/storage': resolve(__dirname, '../storage/src/index.ts'),
      '@oracle/llm':     resolve(__dirname, '../llm/src/index.ts'),
    },
  },
});
