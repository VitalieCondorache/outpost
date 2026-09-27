import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // We ship our own service worker (`src/pwa/sw.ts`) instead of letting the
      // plugin generate one, because the offline strategy is part of the product:
      // the API is never cached (the client owns offline writes via its outbox).
      strategies: 'injectManifest',
      srcDir: 'src/pwa',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
      },
      manifest: {
        name: 'Outpost — offline-first notes',
        short_name: 'Outpost',
        description:
          'Notes that survive dead zones: local-first writes, outbox sync, explicit conflict resolution.',
        theme_color: '#0b0d12',
        background_color: '#0b0d12',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: API_TARGET, changeOrigin: true } },
  },
  preview: {
    // Explicit IPv4 host: `localhost` resolves to ::1 on some machines, and the
    // end-to-end suite probes 127.0.0.1 (as CI does).
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    proxy: { '/api': { target: API_TARGET, changeOrigin: true } },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
