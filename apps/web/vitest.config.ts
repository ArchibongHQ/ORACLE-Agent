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
      '@oracle/engine':  resolve(__dirname, '../../packages/engine/src/index.ts'),
      '@oracle/storage': resolve(__dirname, '../../packages/storage/src/index.ts'),
      '@oracle/runtime': resolve(__dirname, '../../packages/runtime/src/index.ts'),
    },
  },
});
