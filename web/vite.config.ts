import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The dev script runs `vite --config web/vite.config.ts` from the repo root, so
// pin the app root to this directory (where index.html lives) rather than cwd.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Proxy API calls to the Fastify backend so the browser talks to one origin.
    proxy: { "/api": "http://localhost:3001" },
  },
});
