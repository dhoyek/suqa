import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: { include: ['packages/**/*.test.ts', 'apps/web/**/*.test.ts'], environment: 'node' },
  resolve: { alias: { '@': path.resolve(__dirname, 'apps/web'), '@suqa/shared': path.resolve(__dirname, 'packages/shared/src/index.ts') } },
});
