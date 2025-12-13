/**
 * PostgreSQL Storage Backend for LangGraph API
 *
 * This module provides PostgreSQL-backed storage for the LangGraph development
 * server, enabling persistent storage of assistants, threads, runs, and
 * checkpoints without requiring Docker.
 *
 * ## Architecture
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    LangGraph Dev Server                      │
 * ├─────────────────────────────────────────────────────────────┤
 * │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
 * │  │ PostgresOps │  │ Checkpointer│  │   Store     │         │
 * │  │ (Assistants,│  │ (PostgreSQL │  │ (Optional   │         │
 * │  │  Threads,   │  │   Saver)    │  │  Postgres)  │         │
 * │  │  Runs)      │  │             │  │             │         │
 * │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘         │
 * │         └────────────────┼────────────────┘                 │
 * │                          │                                  │
 * │                ┌─────────▼─────────┐                        │
 * │                │  Pool Manager     │                        │
 * │                │  (Shared Pool)    │                        │
 * │                └─────────┬─────────┘                        │
 * └──────────────────────────┼──────────────────────────────────┘
 *                            │
 *                            ▼
 *                     ┌──────────────┐
 *                     │  PostgreSQL  │
 *                     │   Database   │
 *                     └──────────────┘
 * ```
 *
 * ## Usage
 *
 * ### CLI Usage
 *
 * ```bash
 * npx langgraph dev --postgres-uri "postgresql://user:pass@localhost:5432/db"
 * ```
 *
 * ### Programmatic Usage
 *
 * ```typescript
 * import { PostgresOps, poolManager } from "@langchain/langgraph-api/storage/postgres";
 *
 * // Configure the shared pool
 * poolManager.configure({ uri: "postgresql://localhost:5432/db" });
 *
 * // Create ops instance
 * const ops = new PostgresOps({ uri: "postgresql://localhost:5432/db" });
 *
 * // Setup creates tables
 * await ops.setup();
 *
 * // Use ops for storage operations
 * const assistant = await ops.assistants.get("my-assistant", undefined);
 *
 * // Cleanup on shutdown
 * await ops.shutdown();
 * ```
 *
 * ## Required Dependencies
 *
 * - `pg` - PostgreSQL client (included)
 * - `@langchain/langgraph-checkpoint-postgres` - For checkpointing (peer dependency)
 * - `@langchain/langgraph-postgres` - For BaseStore (optional peer dependency)
 *
 * @module storage/postgres
 */

export { poolManager, type PostgresConfig } from "./pool.mjs";
export {
  PostgresOps,
  createPostgresOps,
  type PostgresOpsConfig,
  type CreatePostgresOpsOptions,
} from "./ops.mjs";
export { PostgresNotifier } from "./notifier.mjs";
