import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: { include: ['packages/**/*.test.ts', 'apps/web/**/*.test.ts'], exclude: ['**/node_modules/**'], testTimeout: 20000, setupFiles: ['packages/pos-core/test-setup.ts'], environment: 'node' },
  resolve: { alias: { '@': path.resolve(__dirname, 'apps/web'), '@suqa/shared': path.resolve(__dirname, 'packages/shared/src/index.ts'), '@suqa/pos-core': path.resolve(__dirname, 'packages/pos-core/src/index.ts') } },
});
