import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// The browser always opens `ws://${location.host}/ws`. In dev, Vite proxies that
// path to the Node server on 127.0.0.1:8787 so the WS URL resolves identically in
// dev and prod (see docs/ARCHITECTURE.md — one process serves web + WS in prod).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(rootDir, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:8787',
        ws: true,
      },
    },
  },
});
