import { configDefaults, defineConfig } from "vitest/config";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig((env) => {
  /** @type {import("vitest/config").UserConfigExport} */
  const common = {
    test: {
      hideSkippedTests: true,
      testTimeout: 30_000,
      fileParallelism: false,
      exclude: ["**/*.int.test.ts", ...configDefaults.exclude],
    },
  };

  if (env.mode === "int") {
    return {
      test: {
        ...common.test,
        testTimeout: 120_000,
        maxConcurrency: 5,
        fileParallelism: false,
        pool: "forks",
        poolOptions: {
          forks: {
            singleFork: true,
          },
        },
        onConsoleLog(log) {
          if (log.includes("testcontainers") || log.includes("docker")) {
            return false;
          }
        },
        exclude: configDefaults.exclude,
        include: ["**/*.int.test.ts"],
        name: "int",
        environment: "node",
      },
    };
  }

  return common;
});
