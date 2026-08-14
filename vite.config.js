import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
export default defineConfig(function (_a) {
    var mode = _a.mode;
    var env = loadEnv(mode, process.cwd(), '');
    return {
        plugins: [
            react(),
            VitePWA({
                registerType: 'autoUpdate',
                injectRegister: null,
                filename: 'sw.js',
                strategies: 'generateSW',
                includeAssets: ['favicon.svg', 'robots.txt', 'meta/*.json'],
                manifest: false,
                workbox: {
                    globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
                    navigateFallback: '/index.html',
                    navigateFallbackDenylist: [/^\/api/, /^\/upload/],
                    cleanupOutdatedCaches: true,
                    skipWaiting: true,
                    clientsClaim: true,
                    runtimeCaching: [
                        {
                            urlPattern: function (_a) {
                                var url = _a.url;
                                return url.pathname.startsWith('/analytics');
                            },
                            handler: 'NetworkFirst',
                            options: {
                                cacheName: 'api-analytics-cache',
                                expiration: { maxAgeSeconds: 120 },
                                networkTimeoutSeconds: 5,
                                cacheableResponse: { statuses: [0, 200] },
                            },
                        },
                        {
                            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
                            handler: 'CacheFirst',
                            options: {
                                cacheName: 'google-fonts-cache',
                                expiration: { maxAgeSeconds: 60 * 60 * 24 * 365, maxEntries: 10 },
                                cacheableResponse: { statuses: [0, 200] },
                            },
                        },
                    ],
                },
                devOptions: {
                    enabled: true,
                    type: 'module',
                },
            }),
        ],
        resolve: {
            alias: {
                '@': path.resolve(__dirname, './src'),
            },
        },
        define: {
            __APP_VERSION__: JSON.stringify(env.VITE_APP_VERSION || 'local'),
        },
        build: {
            target: 'esnext',
            sourcemap: mode !== 'production',
            rollupOptions: {
                output: {
                    manualChunks: {
                        'react-vendor': ['react', 'react-dom', 'react-router-dom'],
                        'charts': ['recharts'],
                        'query': ['@tanstack/react-query'],
                        'icons': ['lucide-react'],
                    },
                },
            },
        },
        server: {
            port: 3000,
            proxy: {
                '/upload': { target: env.VITE_API_BASE_URL, changeOrigin: true },
                '/analytics': { target: env.VITE_API_BASE_URL, changeOrigin: true },
                '/email': { target: env.VITE_API_BASE_URL, changeOrigin: true },
            },
        },
    };
});
