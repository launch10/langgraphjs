// run the server for CLI
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "dotenv";

const configPath = fileURLToPath(
  new URL(
    process.argv.findLast((arg) => arg.endsWith(".json")) ??
      "./graphs/langgraph.json",
    import.meta.url
  )
);
const config = JSON.parse(await readFile(configPath, "utf-8"));

let env = {} as NodeJS.ProcessEnv;
if (typeof config.env === "string") {
  const targetEnvFile = resolve(dirname(configPath), config.env);
  env = parse(await readFile(targetEnvFile, "utf-8")) as NodeJS.ProcessEnv;
} else if (config.env != null) {
  env = config.env;
}

const storageType = process.env.STORAGE_TYPE ?? "postgres";
const postgresUri =
  storageType === "postgres"
    ? process.env.POSTGRES_URI ??
      "postgres://user:password@127.0.0.1:5434/testdb?sslmode=disable"
    : undefined;

const { spawnServer } = (
  process.argv.includes("--dev")
    ? await import("../src/cli/spawn.mjs")
    : // @ts-ignore May not exist
      await import("../dist/cli/spawn.mjs")
) as typeof import("../src/cli/spawn.mjs");

const server = await spawnServer(
  {
    port: process.env.PORT || "2024",
    nJobsPerWorker: "10",
    host: "localhost",
    ...(postgresUri && { postgresUri }),
  },
  { config, env, hostUrl: "https://smith.langchain.com" },
  { pid: process.pid, projectCwd: dirname(configPath) }
);

process.once("SIGTERM", () => server.kill("SIGTERM"));
