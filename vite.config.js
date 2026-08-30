import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// The client lives in client/, but imports the simulation from shared/ at the
// repo root — so the dev server has to be allowed to read one level up.
export default defineConfig({
  root: 'client',
  server: {
    port: 5173,
    fs: { allow: ['..'] },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Signed identity is prepared before the network and menu are constructed. The game
    // already requires WebCrypto, WebGL2 and modern modules, so keeping top-level await is
    // more honest than shipping a legacy bundle that cannot provide its account proof.
    target: 'es2022',
    rollupOptions: {
      input: {
        game: resolve('client/index.html'),
        review: resolve('client/review.html'),
      },
    },
  },
});
