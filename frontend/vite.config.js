import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        generation: fileURLToPath(
          new URL('./generation.html', import.meta.url),
        ),
      },
    },
  },
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api/': {
        target: 'https://emomix-backend.vercel.app',
        changeOrigin: true,
      },
    },
  },
});
