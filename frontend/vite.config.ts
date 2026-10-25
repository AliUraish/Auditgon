import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  server: {
    host: "127.0.0.1", port: 3000, strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.ARGON_BACKEND_PORT || "8001"}`, changeOrigin: true } },
    watch: { usePolling: process.env.CODEX_SANDBOX === "seatbelt" },
  },
  build: {
    target: "es2022", chunkSizeWarningLimit: 2500,
    rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: "graphics-engine", test: /node_modules[\\/](?:playcanvas|@playcanvas[\\/]supersplat-viewer)[\\/]/ }] } },
    },
  },
});
