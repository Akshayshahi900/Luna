/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The site is published to GitHub Pages at https://<user>.github.io/Luna/,
// so assets live under /Luna/. SITE_BASE=/ for a custom domain or local root.
export default defineConfig({
  base: process.env.SITE_BASE ?? "/Luna/",
  plugins: [react()],
  server: { port: 5174 },
  test: { environment: "node" },
});
