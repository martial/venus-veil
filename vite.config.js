import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.GH_PAGES ? '/venus-veil/' : '/',
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  assetsInclude: ['**/*.hdr'],
});
