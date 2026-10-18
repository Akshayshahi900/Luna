/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the page comes from Vite (:5173) and the agent socket from
// `uv run luna-web` (:8765). `npm run build` writes dist/, which luna-web serves.
const backend = process.env.LUNA_BACKEND ?? "http://127.0.0.1:8765";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: backend, ws: true },
      "/api": { target: backend },
    },
  },
  build: { chunkSizeWarningLimit: 1500 },
  test: { environment: "node" },
});
