import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["**/e2e.test.tsx", "**/e2e/**"],
    testTimeout: 120000,
    hookTimeout: 90000,
  },
});
