import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 閉域環境（論点36）で任意のパスに置いても動くよう、生成される参照はすべて相対にする。
// 外部ホストからの取得は行わない。CDN・Webフォント・外部APIを追加しないこと（論点39）。
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@domain': fileURLToPath(new URL('./src/domain', import.meta.url)),
      '@application': fileURLToPath(new URL('./src/application', import.meta.url)),
      '@ports': fileURLToPath(new URL('./src/ports', import.meta.url)),
      '@infrastructure': fileURLToPath(new URL('./src/infrastructure', import.meta.url)),
      '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
    },
  },
  worker: {
    // ML Worker は単一（論点19）。ES module 形式でバンドルする。
    format: 'es',
  },
  build: {
    target: 'es2022',
    // 閉域では成果物を目視・grep で確認するため、難読化しても文字列は残す前提。
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
});
