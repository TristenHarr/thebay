import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// The Bay app — builds to dist/site/app (served by the Worker at /app/).
// In dev, `vite` proxies /api + /auth to the local wrangler dev worker (:8787).
export default defineConfig({
  root: __dirname,
  base: "/app/",
  plugins: [react()],
  resolve: { alias: { "@": resolve(__dirname, "src"), "@shared": resolve(__dirname, "../shared") } },
  build: { outDir: resolve(__dirname, "../dist/site/app"), emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/auth": "http://localhost:8787",
    },
  },
});
