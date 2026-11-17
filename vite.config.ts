import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Без @types/node: читаем переменные окружения через безопасный каст.
const nodeEnv = (
  globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }
).process?.env;

// Tauri поднимает dev-сервер на фиксированном порту: адрес зашит в tauri.conf.json.
const host = nodeEnv?.TAURI_DEV_HOST;
const appVersion = nodeEnv?.npm_package_version ?? '0.0.0';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    // WebView на Android 8+ (minSdk 26) — es2022 безопасен.
    target: 'es2022',
    // Vite 8 = Rolldown: минификация через oxc, esbuild отдельно не нужен.
    minify: 'oxc',
    sourcemap: false,
  },
});
