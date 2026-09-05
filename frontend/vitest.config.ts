import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Mirrors the `@/*` path alias from tsconfig.json.
    alias: { '@': path.resolve(__dirname, '.') },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './vitest.setup.ts',
    include: ['{app,lib,components}/**/*.{test,spec}.{ts,tsx}'],
    // `e2e/` holds Playwright specs, which must not be run by Vitest.
    exclude: ['node_modules/**', '.next/**', 'e2e/**'],
    testTimeout: 20_000,
  },
});
