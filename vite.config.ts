import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// base is '/' for local dev; the GitHub Pages build sets VITE_BASE=/nestline/.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        name: 'Nestline',
        short_name: 'Nestline',
        description: 'Markdown と数式を扱える、ブラウザ内保存型のアウトライナー',
        lang: 'ja',
        display: 'standalone',
        theme_color: '#111111',
        background_color: '#f7f7f5',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff,woff2,ttf,png,svg}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
});
