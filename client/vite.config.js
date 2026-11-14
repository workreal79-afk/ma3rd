import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// الخادم الخلفي يعمل افتراضيًا على المنفذ 4000 (PORT أو SHOWROOM_API_PORT يغيّر ذلك).
const apiTarget = process.env.SHOWROOM_API_TARGET || `http://127.0.0.1:${process.env.SHOWROOM_API_PORT || 4000}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: Number(process.env.PORT || 5173),
    // يسمح بالنطاق المحلي ونطاق المعاينة، لا أسماء نطاقات عشوائية (حماية من DNS rebinding).
    allowedHosts: ["localhost", ".localhost", ".e2b.app"],
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: false,
        xfwd: true,
        ws: false,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: Number(process.env.PORT || 4173),
    allowedHosts: ["localhost", ".localhost", ".e2b.app"],
    proxy: {
      "/api": { target: apiTarget, changeOrigin: false, xfwd: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
