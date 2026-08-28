import { defineConfig } from 'vite';

// The client lives in client/, but imports the simulation from shared/ at the
// repo root — so the dev server has to be allowed to read one level up.
export default defineConfig({
  root: 'client',
  server: {
    port: 5173,
    fs: { allow: ['..'] },
  },
  build: { outDir: '../dist', emptyOutDir: true },
});
