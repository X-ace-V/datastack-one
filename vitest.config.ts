import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // The React plugin transforms JSX/TSX for the web component tests; server
  // tests are plain TS and unaffected. Environment is per-file: server tests
  // default to node, web tests opt into jsdom via a `@vitest-environment` docblock.
  plugins: [react()],
  test: {
    include: [
      "tests/**/*.test.ts",
      "server/**/*.test.ts",
      "web/**/*.test.{ts,tsx}",
    ],
    environment: "node",
  },
});
