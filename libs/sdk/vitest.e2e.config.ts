import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/react/__tests__/e2e.test.tsx"],
    testTimeout: 90000,
    hookTimeout: 60000,
  },
});
