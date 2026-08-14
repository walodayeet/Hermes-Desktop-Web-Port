import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Same-origin proxy target for /api + /auth. The SPA is served by Vite (dev)
// or the Node proxy (prod); both forward to the hermes serve backend so the
// cookie session + WS ticket flow stays same-origin (no CORS, no mixed content).
const target = process.env.HERMES_TARGET || 'http://127.0.0.1:9119'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Hermes Desktop Web',
        short_name: 'Hermes',
        description: 'Mobile-first chat client for Hermes',
        theme_color: '#0f1115',
        background_color: '#0f1115',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
      },
    }),
  ],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target, changeOrigin: true, ws: true },
      '/auth': { target, changeOrigin: true },
      '/health': { target, changeOrigin: true },
    },
  },
})
