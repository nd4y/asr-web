import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// VITE_BASE lets the same build be served from a sub-path (GitHub Pages: /asr-web/).
const base = process.env.VITE_BASE ?? "/";

export default defineConfig({
    base,
    plugins: [
        react(),
        VitePWA({
            registerType: "autoUpdate",
            // Model weights and the sherpa/ORT binaries are cached by the app itself
            // (Cache API), so the service worker only precaches the shell.
            workbox: {
                globPatterns: ["**/*.{js,css,html,svg,png,ico,json}"],
                globIgnores: ["models/**", "wasm/**", "ort/**"],
                maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
                navigateFallbackDenylist: [/^\/(models|wasm|ort)\//],
            },
            manifest: {
                name: "asr-web",
                short_name: "asr-web",
                description: "Speech recognition in your browser: Whisper and GigaAM with speaker diarization",
                theme_color: "#4f46e5",
                background_color: "#ffffff",
                display: "standalone",
                icons: [
                    { src: "icon-192.png", sizes: "192x192", type: "image/png" },
                    { src: "icon-512.png", sizes: "512x512", type: "image/png" },
                    { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
                ],
            },
        }),
    ],
    worker: {
        format: "es",
    },
    build: {
        target: "es2022",
        chunkSizeWarningLimit: 3000,
    },
    optimizeDeps: {
        exclude: ["@huggingface/transformers"],
    },
    server: {
        headers: {
            // Not required today (single-threaded WASM); enables threads if a build ever uses them.
        },
    },
});
