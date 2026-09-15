import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.GH_PAGES ? '/venus-veil/' : '/',
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  worker: { format: 'es' },
  server: {
    // local projector service (npm run projector)
    proxy: { '/projector': { target: 'http://127.0.0.1:5193', changeOrigin: true, rewrite: path => path.replace(/^\/projector/, '') } },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  assetsInclude: ['**/*.hdr'],
});
