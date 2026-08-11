import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_PORT = process.env.PORT || 3838;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  // ビルド成果物を Express の静的配信先へ直接出す
  build: { outDir: path.resolve(import.meta.dirname, '../public'), emptyOutDir: true },
  // 開発時は API だけ Express に転送する
  server: {
    port: 5173,
    open: true,
    proxy: {
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: true },
    },
  },
});
