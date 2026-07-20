import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const webSrc = fileURLToPath(new URL('./web/src', import.meta.url));

// Two projects share one runner:
//  - server: Node env for unit + in-process integration tests.
//  - web: jsdom env with testing-library, React plugin, and the `@` alias.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          setupFiles: ['./server/test/setup.ts'],
          include: [
            'server/src/**/*.test.ts',
            'server/test/integration/**/*.test.ts',
          ],
        },
      },
      {
        plugins: [react()],
        resolve: {
          alias: { '@': webSrc },
        },
        test: {
          name: 'web',
          environment: 'jsdom',
          globals: true,
          include: ['web/src/**/*.test.{ts,tsx}'],
          setupFiles: ['./web/src/test/setup.ts'],
        },
      },
    ],
  },
});
