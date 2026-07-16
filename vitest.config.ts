import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "server/**/*.test.ts"],
    environment: "node",
  },
});
