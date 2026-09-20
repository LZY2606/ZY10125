import { defineConfig } from 'vite';

/**
 * In dev the server boots Vite in middleware mode together with the Express
 * API on the SAME port (default 5325). The proxy block is a convenience for
 * standalone `vite` usage and points at the API-only fallback port.
 */
export default defineConfig({
  root: 'src/web',
  publicDir: false,
  build: {
    outDir: '../../dist',
    emptyOutDir: true
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5326',
        changeOrigin: true
      }
    }
  }
});
