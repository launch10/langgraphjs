/**
 * PostgreSQL Operations Implementation for LangGraph API
 *
 * This module implements the `Ops` interface using PostgreSQL as the storage
 * backend, providing persistent storage for assistants, threads, and runs.
 *
 * ## Key Components
 *
 * - **PostgresOps**: Main class implementing the `Ops` interface
 * - **PostgresAssistants**: CRUD operations for assistants with versioning
 * - **PostgresThreads**: Thread management with state tracking
 * - **PostgresRuns**: Run queue management with streaming support
 * - **PostgresThreadsState**: Thread state with checkpoint integration
 * - **PostgresRunsStream**: Server-Sent Events streaming for runs
 *
 * ## Database Schema
 *
 * The module creates the following tables on setup:
 *
 * - `assistants` - Assistant configurations and metadata
 * - `assistant_versions` - Version history for assistants
 * - `threads` - Conversation threads with status tracking
 * - `runs` - Execution runs with kwargs and status
 *
 * Additional tables are created by the checkpoint package:
 * - `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`
 *
 * ## Integration with Checkpointer
 *
 * The module integrates with `@langchain/langgraph-checkpoint-postgres` for
 * checkpoint storage. Each PostgresOps instance lazily creates a PostgresSaver
 * that shares the connection pool.
 *
 * ## Thread Safety
 *
 * All database operations use transactions where appropriate. The StreamManager
 * provides run-level locking to prevent concurrent execution on the same run.
 *
 * @module storage/postgres/ops
 */

import type { StateSnapshot as LangGraphStateSnapshot } from "@langchain/langgraph";
import { HTTPException } from "hono/http-exception";
import { v4 as uuid4 } from "uuid";
import type { Pool as PoolType } from "pg";
import { handleAuthEvent, isAuthMatching } from "../../auth/index.mjs";
import type { AuthContext } from "../../auth/index.mjs";
import { getLangGraphCommand, type RunCommand } from "../../command.mjs";
import { getGraph } from "../../graph/load.mjs";
import { logger } from "../../logging.mjs";
import { serializeError } from "../../utils/serde.mjs";
import { poolManager, type PostgresConfig as BasePostgresConfig } from "./pool.mjs";
import { PostgresNotifier } from "./notifier.mjs";
import type {
  Metadata,
  ThreadStatus,
  RunStatus,
  MultitaskStrategy,
  OnConflictBehavior,
  IfNotExists,
  RunnableConfig,
  Assistant,
  AssistantVersion,
  RunKwargs,
  Run,
  Message,
  Thread,
  CheckpointPayload,
  Ops,
  AssistantsRepo,
  RunsRepo,
  RunsStreamRepo,
  ThreadsRepo,
  ThreadsStateRepo,
  ThreadSelectField,
  AssistantSelectField,
  StreamManager,
  StreamQueue,
  StreamAbortController,
} from "../types.mjs";

/**
 * Extended PostgresConfig with optional stream manager for horizontal scaling.
 */
export interface PostgresOpsConfig extends BasePostgresConfig {
  /**
   * Optional stream manager for horizontal scaling.
   * If not provided, uses in-memory stream manager (single instance only).
   * For horizontal scaling, use RedisStreamManager.
   *
   * @example
   * ```typescript
   * import { RedisStreamManager } from "@langchain/langgraph-api/storage/redis";
   *
   * const redisStream = new RedisStreamManager(process.env.REDIS_URL!);
   * await redisStream.connect();
   *
   * const ops = new PostgresOps({
   *   uri: process.env.DATABASE_URL!,
   *   streamManager: redisStream,
   * });
   * ```
   */
  streamManager?: StreamManager;
}

class TimeoutError extends Error {}
class AbortError extends Error {}

class InMemoryQueue implements StreamQueue {
  private log: Message[] = [];
  private listeners: ((idx: number) => void)[] = [];
  private nextId = 0;
  private resumable = false;

  constructor(options: { resumable: boolean }) {
    this.resumable = options.resumable;
  }

  push(item: Message): void {
    this.log.push(item);
    for (const listener of this.listeners) listener(this.nextId);
    this.nextId += 1;
  }

  async get(options: {
    timeout: number;
    lastEventId?: string;
    signal?: AbortSignal;
  }): Promise<[id: string, message: Message]> {
    if (this.resumable) {
      const lastEventId = options.lastEventId;
      let targetId = lastEventId != null ? +lastEventId + 1 : null;
      if (
        targetId == null ||
        isNaN(targetId) ||
        targetId < 0 ||
        targetId >= this.log.length
      ) {
        targetId = null;
      }
      if (targetId != null) return [String(targetId), this.log[targetId]];
    } else {
      if (this.log.length) {
        const nextId = this.nextId - this.log.length;
        const nextItem = this.log.shift()!;
        return [String(nextId), nextItem];
      }
    }

    let timeout: NodeJS.Timeout | undefined = undefined;
    let resolver: ((idx: number) => void) | undefined = undefined;
    const clean = new AbortController();

    return await new Promise<number>((resolve, reject) => {
      timeout = setTimeout(() => reject(new TimeoutError()), options.timeout);
      resolver = resolve;
      options.signal?.addEventListener(
        "abort",
        () => reject(new AbortError()),
        { signal: clean.signal }
      );
      this.listeners.push(resolver);
    })
      .then((idx) => {
        if (this.resumable) {
          return [String(idx), this.log[idx]] as [string, Message];
        }
        const nextId = this.nextId - this.log.length;
        const nextItem = this.log.shift()!;
        return [String(nextId), nextItem] as [string, Message];
      })
      .finally(() => {
        this.listeners = this.listeners.filter((l) => l !== resolver);
        clearTimeout(timeout);
        clean.abort();
      });
  }
}

class CancellationAbortController extends AbortController implements StreamAbortController {
  abort(reason: "rollback" | "interrupt") {
    super.abort(reason);
  }
}

class InMemoryStreamManager implements StreamManager {
  private readers: Record<string, InMemoryQueue> = {};
  private control: Record<string, CancellationAbortController> = {};

  getQueue(
    runId: string,
    options: { ifNotFound: "create"; resumable: boolean }
  ): StreamQueue {
    if (this.readers[runId] == null) {
      this.readers[runId] = new InMemoryQueue(options);
    }
    return this.readers[runId];
  }

  getControl(runId: string): StreamAbortController | undefined {
    if (this.control[runId] == null) return undefined;
    return this.control[runId];
  }

  isLocked(runId: string): boolean {
    return this.control[runId] != null;
  }

  lock(runId: string): AbortSignal {
    if (this.control[runId] != null) {
      logger.warn("Run already locked", { run_id: runId });
    }
    this.control[runId] = new CancellationAbortController();
    return this.control[runId].signal;
  }

  unlock(runId: string): void {
    delete this.control[runId];
  }
}

const defaultStreamManager = new InMemoryStreamManager();

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const isJsonbContained = (
  superset: Record<string, unknown> | undefined,
  subset: Record<string, unknown> | undefined
): boolean => {
  if (superset == null || subset == null) return true;
  for (const [key, value] of Object.entries(subset)) {
    if (superset[key] == null) return false;
    if (isObject(value) && isObject(superset[key])) {
      if (!isJsonbContained(superset[key], value)) return false;
    } else if (superset[key] !== value) {
      return false;
    }
  }
  return true;
};

/**
 * PostgreSQL implementation of the LangGraph Ops interface.
 *
 * Provides persistent storage for assistants, threads, and runs using PostgreSQL.
 * Integrates with the checkpoint and store packages for full graph state persistence.
 *
 * @example
 * ```typescript
 * import { PostgresOps, poolManager } from "./storage/postgres/index.mjs";
 *
 * // Configure pool first
 * poolManager.configure({ uri: "postgresql://localhost:5432/db" });
 *
 * // Create and setup ops
 * const ops = new PostgresOps({ uri: "postgresql://localhost:5432/db" });
 * await ops.setup();
 *
 * // Use the ops interface
 * const assistant = await ops.assistants.put("my-assistant", {
 *   graph_id: "agent",
 *   config: {},
 *   context: {},
 *   if_exists: "do_nothing",
 * }, undefined);
 *
 * // Cleanup on shutdown
 * await ops.shutdown();
 * ```
 */
export class PostgresOps implements Ops {
  private readonly config: PostgresOpsConfig;
  private checkpointerInstance:
    | import("@langchain/langgraph-checkpoint-postgres").PostgresSaver
    | null = null;
  private storeInstance: import("@langchain/langgraph").BaseStore | null = null;
  private notifierInstance: PostgresNotifier | null = null;

  /** Stream manager for run streams and control signals */
  readonly streamManager: StreamManager;

  /** Repository for assistant operations */
  readonly assistants: PostgresAssistants;
  /** Repository for run operations */
  readonly runs: PostgresRuns;
  /** Repository for thread operations */
  readonly threads: PostgresThreads;

  /**
   * Create a new PostgresOps instance.
   *
   * @param config - PostgreSQL configuration including URI, optional schema, and optional stream manager
   */
  constructor(config: PostgresOpsConfig) {
    this.config = config;
    this.streamManager = config.streamManager ?? defaultStreamManager;
    this.assistants = new PostgresAssistants(this);
    this.runs = new PostgresRuns(this);
    this.threads = new PostgresThreads(this);
  }

  getConfig(): PostgresOpsConfig {
    return this.config;
  }

  async getPool(): Promise<PoolType> {
    return poolManager.getPool();
  }

  async getNotifier(): Promise<PostgresNotifier> {
    if (this.notifierInstance == null) {
      this.notifierInstance = new PostgresNotifier(this.config.uri);
      await this.notifierInstance.connect();
    }
    return this.notifierInstance;
  }

  getNotificationChannel(): string {
    const schema = this.config.schema ?? "public";
    return schema === "public" ? "new_run" : `${schema}_new_run`;
  }

  async getCheckpointer(): Promise<
    import("@langchain/langgraph-checkpoint-postgres").PostgresSaver
  > {
    if (this.checkpointerInstance == null) {
      const { PostgresSaver } = await import(
        "@langchain/langgraph-checkpoint-postgres"
      );
      this.checkpointerInstance = PostgresSaver.fromConnString(
        this.config.uri,
        {
          schema: this.config.schema ?? "public",
        }
      );
      await this.checkpointerInstance.setup();
    }
    return this.checkpointerInstance;
  }

  async getStore(): Promise<
    import("@langchain/langgraph").BaseStore | undefined
  > {
    if (this.storeInstance == null) {
      try {
        // @ts-expect-error - PostgresStore may not be installed
        const { PostgresStore } = await import("@langchain/langgraph-postgres");
        const pool = await this.getPool();
        this.storeInstance = new PostgresStore({ pool });
        await (this.storeInstance as any).setup?.();
      } catch {
        logger.warn("PostgresStore not available, store operations disabled");
        return undefined;
      }
    }
    return this.storeInstance ?? undefined;
  }

  async setup(): Promise<void> {
    const pool = await this.getPool();
    const schema = this.config.schema ?? "public";

    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.assistants (
          assistant_id TEXT PRIMARY KEY,
          graph_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          config JSONB NOT NULL DEFAULT '{}',
          context JSONB,
          metadata JSONB NOT NULL DEFAULT '{}',
          version INTEGER NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.assistant_versions (
          assistant_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          graph_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          config JSONB NOT NULL DEFAULT '{}',
          context JSONB,
          metadata JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (assistant_id, version)
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.threads (
          thread_id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'idle',
          config JSONB NOT NULL DEFAULT '{}',
          metadata JSONB NOT NULL DEFAULT '{}',
          values JSONB,
          interrupts JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.runs (
          run_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          assistant_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          metadata JSONB NOT NULL DEFAULT '{}',
          kwargs JSONB NOT NULL DEFAULT '{}',
          multitask_strategy TEXT NOT NULL DEFAULT 'reject',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_runs_thread_id ON ${schema}.runs(thread_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_runs_status ON ${schema}.runs(status)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_threads_status ON ${schema}.threads(status)
      `);

      await this.getCheckpointer();
    } finally {
      client.release();
    }

    await this.setupRunNotificationTrigger();
  }

  private async setupRunNotificationTrigger(): Promise<void> {
    const pool = await this.getPool();
    const schema = this.config.schema ?? "public";
    const channelName = schema === "public" ? "new_run" : `${schema}_new_run`;

    await pool.query(`
      CREATE OR REPLACE FUNCTION ${schema}.notify_new_run() 
      RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'pending' THEN
          PERFORM pg_notify('${channelName}', NEW.run_id);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await pool.query(`
      DROP TRIGGER IF EXISTS run_insert_notify ON ${schema}.runs;
    `);

    await pool.query(`
      CREATE TRIGGER run_insert_notify
        AFTER INSERT ON ${schema}.runs
        FOR EACH ROW
        EXECUTE FUNCTION ${schema}.notify_new_run();
    `);
  }

  async truncate(flags: {
    runs?: boolean;
    threads?: boolean;
    assistants?: boolean;
    checkpointer?: boolean;
    store?: boolean;
  }): Promise<void> {
    const pool = await this.getPool();
    const schema = this.config.schema ?? "public";

    if (flags.runs) {
      await pool.query(`DELETE FROM ${schema}.runs`);
    }
    if (flags.threads) {
      await pool.query(`DELETE FROM ${schema}.threads`);
    }
    if (flags.assistants) {
      await pool.query(
        `DELETE FROM ${schema}.assistants WHERE NOT (metadata->>'created_by' = 'system')`
      );
      await pool.query(`DELETE FROM ${schema}.assistant_versions`);
    }
    if (flags.checkpointer) {
      await pool.query(`DELETE FROM ${schema}.checkpoints`);
      await pool.query(`DELETE FROM ${schema}.checkpoint_blobs`);
      await pool.query(`DELETE FROM ${schema}.checkpoint_writes`);
    }
    if (flags.store) {
      try {
        await pool.query(`DELETE FROM ${schema}.store`);
      } catch {
        // Store table may not exist
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.notifierInstance != null) {
      await this.notifierInstance.close();
      this.notifierInstance = null;
    }
    if (this.checkpointerInstance != null) {
      await this.checkpointerInstance.end();
    }
    await poolManager.shutdown();
  }
}

class PostgresAssistants implements AssistantsRepo {
  private readonly ops: PostgresOps;

  constructor(ops: PostgresOps) {
    this.ops = ops;
  }

  async *search(
    options: {
      graph_id?: string;
      name?: string;
      metadata?: Metadata;
      limit: number;
      offset: number;
      sort_by?:
        | "assistant_id"
        | "created_at"
        | "updated_at"
        | "name"
        | "graph_id";
      sort_order?: "asc" | "desc";
      select?: AssistantSelectField[];
    },
    auth: AuthContext | undefined
  ): AsyncGenerator<{ assistant: Assistant; total: number }> {
    const [filters] = await handleAuthEvent(auth, "assistants:search", {
      graph_id: options.graph_id,
      metadata: options.metadata,
      limit: options.limit,
      offset: options.offset,
    });

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";
    const params: unknown[] = [];
    const wheres: string[] = [];

    if (options.graph_id != null) {
      params.push(options.graph_id);
      wheres.push(`graph_id = $${params.length}`);
    }
    if (options.name != null) {
      params.push(`%${options.name.toLowerCase()}%`);
      wheres.push(`LOWER(name) LIKE $${params.length}`);
    }
    if (options.metadata != null) {
      params.push(JSON.stringify(options.metadata));
      wheres.push(`metadata @> $${params.length}::jsonb`);
    }

    const whereClause =
      wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
    const sortBy = options.sort_by ?? "created_at";
    const sortOrder = options.sort_order ?? "desc";

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM ${schema}.assistants ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total, 10);

    params.push(options.limit, options.offset);
    const result = await pool.query(
      `SELECT * FROM ${schema}.assistants ${whereClause} ORDER BY ${sortBy} ${sortOrder} LIMIT $${
        params.length - 1
      } OFFSET $${params.length}`,
      params
    );

    for (const row of result.rows) {
      const assistant = this.rowToAssistant(row);
      if (!isAuthMatching(assistant.metadata, filters)) continue;
      yield { assistant, total };
    }
  }

  async get(
    assistant_id: string,
    auth: AuthContext | undefined
  ): Promise<Assistant> {
    const [filters] = await handleAuthEvent(auth, "assistants:read", {
      assistant_id,
    });

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";

    const result = await pool.query(
      `SELECT * FROM ${schema}.assistants WHERE assistant_id = $1`,
      [assistant_id]
    );

    if (result.rows.length === 0) {
      throw new HTTPException(404, { message: "Assistant not found" });
    }

    const assistant = this.rowToAssistant(result.rows[0]);
    if (!isAuthMatching(assistant.metadata, filters)) {
      throw new HTTPException(404, { message: "Assistant not found" });
    }

    return assistant;
  }

  async put(
    assistant_id: string,
    options: {
      config: RunnableConfig;
      context: unknown;
      graph_id: string;
      metadata?: Metadata;
      if_exists: OnConflictBehavior;
      name?: string;
      description?: string;
    },
    auth: AuthContext | undefined
  ): Promise<Assistant> {
    const [filters, mutable] = await handleAuthEvent(
      auth,
      "assistants:create",
      {
        assistant_id,
        config: options.config,
        context: options.context,
        graph_id: options.graph_id,
        metadata: options.metadata,
        if_exists: options.if_exists,
        name: options.name,
        description: options.description,
      }
    );

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const existing = await client.query(
        `SELECT * FROM ${schema}.assistants WHERE assistant_id = $1`,
        [assistant_id]
      );

      if (existing.rows.length > 0) {
        const existingAssistant = this.rowToAssistant(existing.rows[0]);
        if (!isAuthMatching(existingAssistant.metadata, filters)) {
          throw new HTTPException(409, { message: "Assistant already exists" });
        }
        if (options.if_exists === "raise") {
          throw new HTTPException(409, { message: "Assistant already exists" });
        }
        await client.query("COMMIT");
        return existingAssistant;
      }

      const metadata = mutable.metadata ?? {};
      const name = options.name || options.graph_id;

      await client.query(
        `INSERT INTO ${schema}.assistants (assistant_id, graph_id, name, description, config, context, metadata, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
        [
          assistant_id,
          options.graph_id,
          name,
          options.description ?? null,
          JSON.stringify(options.config ?? {}),
          JSON.stringify(options.context ?? {}),
          JSON.stringify(metadata),
        ]
      );

      await client.query(
        `INSERT INTO ${schema}.assistant_versions (assistant_id, version, graph_id, name, description, config, context, metadata)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7)`,
        [
          assistant_id,
          options.graph_id,
          name,
          options.description ?? null,
          JSON.stringify(options.config ?? {}),
          JSON.stringify(options.context ?? {}),
          JSON.stringify(metadata),
        ]
      );

      await client.query("COMMIT");
      return this.get(assistant_id, auth);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async patch(
    assistantId: string,
    options: {
      config?: RunnableConfig;
      context?: unknown;
      graph_id?: string;
      metadata?: Metadata;
      name?: string;
      description?: string;
    },
    auth: AuthContext | undefined
  ): Promise<Assistant> {
    const [filters, mutable] = await handleAuthEvent(
      auth,
      "assistants:update",
      {
        assistant_id: assistantId,
        graph_id: options?.graph_id,
        config: options?.config,
        metadata: options?.metadata,
        name: options?.name,
        description: options?.description,
      }
    );

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const existing = await client.query(
        `SELECT * FROM ${schema}.assistants WHERE assistant_id = $1`,
        [assistantId]
      );

      if (existing.rows.length === 0) {
        throw new HTTPException(404, { message: "Assistant not found" });
      }

      const assistant = this.rowToAssistant(existing.rows[0]);
      if (!isAuthMatching(assistant.metadata, filters)) {
        throw new HTTPException(404, { message: "Assistant not found" });
      }

      const updates: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (options?.graph_id != null) {
        updates.push(`graph_id = $${paramIdx++}`);
        params.push(options.graph_id);
      }
      if (options?.config != null) {
        updates.push(`config = $${paramIdx++}`);
        params.push(JSON.stringify(options.config));
      }
      if (options?.context != null) {
        updates.push(`context = $${paramIdx++}`);
        params.push(JSON.stringify(options.context));
      }
      if (options?.name != null) {
        updates.push(`name = $${paramIdx++}`);
        params.push(options.name);
      }
      if (options?.description != null) {
        updates.push(`description = $${paramIdx++}`);
        params.push(options.description);
      }
      if (mutable.metadata != null) {
        updates.push(`metadata = metadata || $${paramIdx++}::jsonb`);
        params.push(JSON.stringify(mutable.metadata));
      }

      const maxVersionResult = await client.query(
        `SELECT COALESCE(MAX(version), 0) as max_version FROM ${schema}.assistant_versions WHERE assistant_id = $1`,
        [assistantId]
      );
      const newVersion = maxVersionResult.rows[0].max_version + 1;

      updates.push(`version = $${paramIdx++}`);
      params.push(newVersion);
      updates.push(`updated_at = NOW()`);

      params.push(assistantId);
      await client.query(
        `UPDATE ${schema}.assistants SET ${updates.join(
          ", "
        )} WHERE assistant_id = $${paramIdx}`,
        params
      );

      const updated = await client.query(
        `SELECT * FROM ${schema}.assistants WHERE assistant_id = $1`,
        [assistantId]
      );
      const updatedAssistant = this.rowToAssistant(updated.rows[0]);

      await client.query(
        `INSERT INTO ${schema}.assistant_versions (assistant_id, version, graph_id, name, description, config, context, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          assistantId,
          newVersion,
          updatedAssistant.graph_id,
          updatedAssistant.name,
          updatedAssistant.description,
          JSON.stringify(updatedAssistant.config),
          JSON.stringify(updatedAssistant.context),
          JSON.stringify(updatedAssistant.metadata),
        ]
      );

      await client.query("COMMIT");
      return updatedAssistant;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async delete(
    assistant_id: string,
    auth: AuthContext | undefined
  ): Promise<string[]> {
    const [filters] = await handleAuthEvent(auth, "assistants:delete", {
      assistant_id,
    });

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const existing = await client.query(
        `SELECT * FROM ${schema}.assistants WHERE assistant_id = $1`,
        [assistant_id]
      );

      if (existing.rows.length === 0) {
        throw new HTTPException(404, { message: "Assistant not found" });
      }

      const assistant = this.rowToAssistant(existing.rows[0]);
      if (!isAuthMatching(assistant.metadata, filters)) {
        throw new HTTPException(404, { message: "Assistant not found" });
      }

      await client.query(
        `DELETE FROM ${schema}.assistant_versions WHERE assistant_id = $1`,
        [assistant_id]
      );
      await client.query(`DELETE FROM ${schema}.runs WHERE assistant_id = $1`, [
        assistant_id,
      ]);
      await client.query(
        `DELETE FROM ${schema}.assistants WHERE assistant_id = $1`,
        [assistant_id]
      );

      await client.query("COMMIT");
      return [assistant_id];
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async count(
    options: { graph_id?: string; name?: string; metadata?: Metadata },
    auth: AuthContext | undefined
  ): Promise<number> {
    await handleAuthEvent(auth, "assistants:search", {
      graph_id: options.graph_id,
      metadata: options.metadata,
      limit: 0,
      offset: 0,
    });

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";
    const params: unknown[] = [];
    const wheres: string[] = [];

    if (options.graph_id != null) {
      params.push(options.graph_id);
      wheres.push(`graph_id = $${params.length}`);
    }
    if (options.name != null) {
      params.push(`%${options.name.toLowerCase()}%`);
      wheres.push(`LOWER(name) LIKE $${params.length}`);
    }
    if (options.metadata != null) {
      params.push(JSON.stringify(options.metadata));
      wheres.push(`metadata @> $${params.length}::jsonb`);
    }

    const whereClause =
      wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT COUNT(*) as total FROM ${schema}.assistants ${whereClause}`,
      params
    );

    return parseInt(result.rows[0].total, 10);
  }

  async setLatest(
    assistant_id: string,
    version: number,
    auth: AuthContext | undefined
  ): Promise<Assistant> {
    const [filters] = await handleAuthEvent(auth, "assistants:update", {
      assistant_id,
      version,
    });

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const existing = await client.query(
        `SELECT * FROM ${schema}.assistants WHERE assistant_id = $1`,
        [assistant_id]
      );

      if (existing.rows.length === 0) {
        throw new HTTPException(404, { message: "Assistant not found" });
      }

      const assistant = this.rowToAssistant(existing.rows[0]);
      if (!isAuthMatching(assistant.metadata, filters)) {
        throw new HTTPException(404, { message: "Assistant not found" });
      }

      const versionResult = await client.query(
        `SELECT * FROM ${schema}.assistant_versions WHERE assistant_id = $1 AND version = $2`,
        [assistant_id, version]
      );

      if (versionResult.rows.length === 0) {
        throw new HTTPException(404, {
          message: "Assistant version not found",
        });
      }

      const ver = versionResult.rows[0];
      await client.query(
        `UPDATE ${schema}.assistants SET config = $1, metadata = $2, version = $3, name = $4, updated_at = NOW() WHERE assistant_id = $5`,
        [ver.config, ver.metadata, version, ver.name, assistant_id]
      );

      await client.query("COMMIT");
      return this.get(assistant_id, auth);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async getVersions(
    assistant_id: string,
    options: {
      limit: number;
      offset: number;
      metadata?: Metadata;
    },
    auth: AuthContext | undefined
  ): Promise<AssistantVersion[]> {
    const [filters] = await handleAuthEvent(auth, "assistants:read", {
      assistant_id,
    });

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";
    const params: unknown[] = [assistant_id];
    const wheres: string[] = [`assistant_id = $1`];

    if (options.metadata != null) {
      params.push(JSON.stringify(options.metadata));
      wheres.push(`metadata @> $${params.length}::jsonb`);
    }

    params.push(options.limit, options.offset);
    const result = await pool.query(
      `SELECT * FROM ${schema}.assistant_versions WHERE ${wheres.join(
        " AND "
      )} ORDER BY version DESC LIMIT $${params.length - 1} OFFSET $${
        params.length
      }`,
      params
    );

    return result.rows
      .map((row) => this.rowToAssistantVersion(row))
      .filter((v) => isAuthMatching(v.metadata, filters));
  }

  private rowToAssistant(row: any): Assistant {
    return {
      assistant_id: row.assistant_id,
      graph_id: row.graph_id,
      name: row.name ?? row.graph_id,
      description: row.description ?? null,
      config:
        typeof row.config === "string" ? JSON.parse(row.config) : row.config,
      context:
        typeof row.context === "string" ? JSON.parse(row.context) : row.context,
      metadata:
        typeof row.metadata === "string"
          ? JSON.parse(row.metadata)
          : row.metadata,
      version: row.version,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }

  private rowToAssistantVersion(row: any): AssistantVersion {
    return {
      assistant_id: row.assistant_id,
      version: row.version,
      graph_id: row.graph_id,
      name: row.name ?? row.graph_id,
      description: row.description ?? null,
      config:
        typeof row.config === "string" ? JSON.parse(row.config) : row.config,
      context:
        typeof row.context === "string" ? JSON.parse(row.context) : row.context,
      metadata:
        typeof row.metadata === "string"
          ? JSON.parse(row.metadata)
          : row.metadata,
      created_at: new Date(row.created_at),
    };
  }
}

class PostgresThreads implements ThreadsRepo {
  private readonly ops: PostgresOps;
  public readonly state: ThreadsStateRepo;

  constructor(ops: PostgresOps) {
    this.ops = ops;
    this.state = new PostgresThreadsState(ops, this);
  }

  async *search(
    options: {
      metadata?: Metadata;
      ids?: string[];
      status?: ThreadStatus;
      values?: Record<string, unknown>;
      limit: number;
      offset: number;
      sort_by?: "thread_id" | "status" | "created_at" | "updated_at";
      sort_order?: "asc" | "desc";
      select?: ThreadSelectField[];
    },
    auth: AuthContext | undefined
  ): AsyncGenerator<{ thread: Thread; total: number }> {
    const [filters] = await handleAuthEvent(auth, "threads:search", {
      metadata: options.metadata,
      ids: options.ids,
      status: options.status,
      values: options.values,
      limit: options.limit,
      offset: options.offset,
    });

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";
    const params: unknown[] = [];
    const wheres: string[] = [];

    if (options.ids != null && options.ids.length > 0) {
      params.push(options.ids);
      wheres.push(`thread_id = ANY($${params.length})`);
    }
    if (options.metadata != null) {
      params.push(JSON.stringify(options.metadata));
      wheres.push(`metadata @> $${params.length}::jsonb`);
    }
    if (options.status != null) {
      params.push(options.status);
      wheres.push(`status = $${params.length}`);
    }
    if (options.values != null) {
      params.push(JSON.stringify(options.values));
      wheres.push(`values @> $${params.length}::jsonb`);
    }

    const whereClause =
      wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
    const sortBy = options.sort_by ?? "created_at";
    const sortOrder = options.sort_order ?? "desc";

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM ${schema}.threads ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total, 10);

    params.push(options.limit, options.offset);
    const result = await pool.query(
      `SELECT * FROM ${schema}.threads ${whereClause} ORDER BY ${sortBy} ${sortOrder} LIMIT $${
        params.length - 1
      } OFFSET $${params.length}`,
      params
    );

    for (const row of result.rows) {
      const thread = this.rowToThread(row);
      if (!isAuthMatching(thread.metadata, filters)) continue;
      yield { thread, total };
    }
  }

  async get(thread_id: string, auth: AuthContext | undefined): Promise<Thread> {
    const [filters] = await handleAuthEvent(auth, "threads:read", {
      thread_id,
    });

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";

    const result = await pool.query(
      `SELECT * FROM ${schema}.threads WHERE thread_id = $1`,
      [thread_id]
    );

    if (result.rows.length === 0) {
      throw new HTTPException(404, {
        message: `Thread with ID ${thread_id} not found`,
      });
    }

    const thread = this.rowToThread(result.rows[0]);
    if (!isAuthMatching(thread.metadata, filters)) {
      throw new HTTPException(404, {
        message: `Thread with ID ${thread_id} not found`,
      });
    }

    return thread;
  }

  async put(
    thread_id: string,
    options: {
      metadata?: Metadata;
      if_exists: OnConflictBehavior;
    },
    auth: AuthContext | undefined
  ): Promise<Thread> {
    const [filters, mutable] = await handleAuthEvent(auth, "threads:create", {
      thread_id,
      metadata: options.metadata,
      if_exists: options.if_exists,
    });

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";

    const existing = await pool.query(
      `SELECT * FROM ${schema}.threads WHERE thread_id = $1`,
      [thread_id]
    );

    if (existing.rows.length > 0) {
      const existingThread = this.rowToThread(existing.rows[0]);
      if (!isAuthMatching(existingThread.metadata, filters)) {
        throw new HTTPException(409, { message: "Thread already exists" });
      }
      if (options.if_exists === "raise") {
        throw new HTTPException(409, { message: "Thread already exists" });
      }
      return existingThread;
    }

    const metadata = mutable?.metadata ?? {};
    await pool.query(
      `INSERT INTO ${schema}.threads (thread_id, status, metadata, config) VALUES ($1, 'idle', $2, '{}')`,
      [thread_id, JSON.stringify(metadata)]
    );

    return this.get(thread_id, auth);
  }

  async patch(
    threadId: string,
    options: { metadata?: Metadata },
    auth: AuthContext | undefined
  ): Promise<Thread> {
    const [filters, mutable] = await handleAuthEvent(auth, "threads:update", {
      thread_id: threadId,
      metadata: options.metadata,
    });

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";

    const existing = await pool.query(
      `SELECT * FROM ${schema}.threads WHERE thread_id = $1`,
      [threadId]
    );

    if (existing.rows.length === 0) {
      throw new HTTPException(404, { message: "Thread not found" });
    }

    const thread = this.rowToThread(existing.rows[0]);
    if (!isAuthMatching(thread.metadata, filters)) {
      throw new HTTPException(404, { message: "Thread not found" });
    }

    if (mutable.metadata != null) {
      await pool.query(
        `UPDATE ${schema}.threads SET metadata = metadata || $1::jsonb, updated_at = NOW() WHERE thread_id = $2`,
        [JSON.stringify(mutable.metadata), threadId]
      );
    }

    return this.get(threadId, auth);
  }

  async setStatus(
    threadId: string,
    options: {
      checkpoint?: CheckpointPayload;
      exception?: Error;
    }
  ): Promise<void> {
    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";

    let hasNext = false;
    if (options.checkpoint != null) {
      hasNext = options.checkpoint.next.length > 0;
    }

    const pendingRunsResult = await pool.query(
      `SELECT COUNT(*) as count FROM ${schema}.runs WHERE thread_id = $1 AND status = 'pending'`,
      [threadId]
    );
    const hasPendingRuns = parseInt(pendingRunsResult.rows[0].count, 10) > 0;

    let status: ThreadStatus = "idle";
    if (options.exception != null) {
      status = "error";
    } else if (hasNext) {
      status = "interrupted";
    } else if (hasPendingRuns) {
      status = "busy";
    }

    const values = options.checkpoint?.values ?? null;
    const interrupts =
      options.checkpoint != null
        ? options.checkpoint.tasks.reduce<Record<string, unknown>>(
            (acc, task) => {
              if (task.interrupts) acc[task.id] = task.interrupts;
              return acc;
            },
            {}
          )
        : null;

    await pool.query(
      `UPDATE ${schema}.threads SET status = $1, values = $2, interrupts = $3, updated_at = NOW() WHERE thread_id = $4`,
      [status, JSON.stringify(values), JSON.stringify(interrupts), threadId]
    );
  }

  async delete(
    thread_id: string,
    auth: AuthContext | undefined
  ): Promise<string[]> {
    const [filters] = await handleAuthEvent(auth, "threads:delete", {
      thread_id,
    });

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const existing = await client.query(
        `SELECT * FROM ${schema}.threads WHERE thread_id = $1`,
        [thread_id]
      );

      if (existing.rows.length === 0) {
        throw new HTTPException(404, {
          message: `Thread with ID ${thread_id} not found`,
        });
      }

      const thread = this.rowToThread(existing.rows[0]);
      if (!isAuthMatching(thread.metadata, filters)) {
        throw new HTTPException(404, {
          message: `Thread with ID ${thread_id} not found`,
        });
      }

      await client.query(`DELETE FROM ${schema}.runs WHERE thread_id = $1`, [
        thread_id,
      ]);
      await client.query(`DELETE FROM ${schema}.threads WHERE thread_id = $1`, [
        thread_id,
      ]);

      const checkpointer = await this.ops.getCheckpointer();
      await checkpointer.deleteThread(thread_id);

      await client.query("COMMIT");
      return [thread_id];
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async copy(
    thread_id: string,
    auth: AuthContext | undefined
  ): Promise<Thread> {
    const [filters] = await handleAuthEvent(auth, "threads:read", {
      thread_id,
    });

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";

    const existing = await pool.query(
      `SELECT * FROM ${schema}.threads WHERE thread_id = $1`,
      [thread_id]
    );

    if (existing.rows.length === 0) {
      throw new HTTPException(409, { message: "Thread not found" });
    }

    const fromThread = this.rowToThread(existing.rows[0]);
    if (!isAuthMatching(fromThread.metadata, filters)) {
      throw new HTTPException(409, { message: "Thread not found" });
    }

    const newThreadId = uuid4();
    const newMetadata = { ...fromThread.metadata, thread_id: newThreadId };
    await handleAuthEvent(auth, "threads:create", {
      thread_id: newThreadId,
      metadata: newMetadata,
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO ${schema}.threads (thread_id, status, config, metadata, values, interrupts)
         VALUES ($1, 'idle', $2, $3, $4, $5)`,
        [
          newThreadId,
          JSON.stringify(fromThread.config ?? {}),
          JSON.stringify(newMetadata),
          JSON.stringify(fromThread.values ?? null),
          JSON.stringify(fromThread.interrupts ?? null),
        ]
      );

      await client.query(
        `INSERT INTO ${schema}.checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
         SELECT $1, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint,
                jsonb_set(metadata, '{thread_id}', to_jsonb($1::text))
         FROM ${schema}.checkpoints
         WHERE thread_id = $2`,
        [newThreadId, thread_id]
      );

      await client.query(
        `INSERT INTO ${schema}.checkpoint_blobs (thread_id, checkpoint_ns, channel, version, type, blob)
         SELECT $1, checkpoint_ns, channel, version, type, blob
         FROM ${schema}.checkpoint_blobs
         WHERE thread_id = $2`,
        [newThreadId, thread_id]
      );

      await client.query(
        `INSERT INTO ${schema}.checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, blob)
         SELECT $1, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, blob
         FROM ${schema}.checkpoint_writes
         WHERE thread_id = $2`,
        [newThreadId, thread_id]
      );

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    return this.get(newThreadId, auth);
  }

  async count(
    options: {
      metadata?: Metadata;
      values?: Record<string, unknown>;
      status?: ThreadStatus;
    },
    auth: AuthContext | undefined
  ): Promise<number> {
    await handleAuthEvent(auth, "threads:search", {
      metadata: options.metadata,
      values: options.values,
      status: options.status,
      limit: 0,
      offset: 0,
    });

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";
    const params: unknown[] = [];
    const wheres: string[] = [];

    if (options.metadata != null) {
      params.push(JSON.stringify(options.metadata));
      wheres.push(`metadata @> $${params.length}::jsonb`);
    }
    if (options.status != null) {
      params.push(options.status);
      wheres.push(`status = $${params.length}`);
    }
    if (options.values != null) {
      params.push(JSON.stringify(options.values));
      wheres.push(`values @> $${params.length}::jsonb`);
    }

    const whereClause =
      wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT COUNT(*) as total FROM ${schema}.threads ${whereClause}`,
      params
    );

    return parseInt(result.rows[0].total, 10);
  }

  private rowToThread(row: any): Thread {
    return {
      thread_id: row.thread_id,
      status: row.status as ThreadStatus,
      config:
        typeof row.config === "string" ? JSON.parse(row.config) : row.config,
      metadata:
        typeof row.metadata === "string"
          ? JSON.parse(row.metadata)
          : row.metadata,
      values:
        row.values != null
          ? typeof row.values === "string"
            ? JSON.parse(row.values)
            : row.values
          : undefined,
      interrupts:
        row.interrupts != null
          ? typeof row.interrupts === "string"
            ? JSON.parse(row.interrupts)
            : row.interrupts
          : undefined,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }
}

class PostgresThreadsState implements ThreadsStateRepo {
  private readonly ops: PostgresOps;
  private readonly threads: PostgresThreads;

  constructor(ops: PostgresOps, threads: PostgresThreads) {
    this.ops = ops;
    this.threads = threads;
  }

  async get(
    config: RunnableConfig,
    options: { subgraphs?: boolean },
    auth: AuthContext | undefined
  ): Promise<LangGraphStateSnapshot> {
    const subgraphs = options.subgraphs ?? false;
    const threadId = config.configurable?.thread_id;
    const thread = threadId
      ? await this.threads.get(threadId, auth)
      : undefined;

    const metadata = thread?.metadata ?? {};
    const graphId = metadata?.graph_id as string | undefined | null;

    if (!thread || graphId == null) {
      return {
        values: {},
        next: [],
        config: {},
        metadata: undefined,
        createdAt: undefined,
        parentConfig: undefined,
        tasks: [],
      };
    }

    const checkpointer = await this.ops.getCheckpointer();
    const store = await this.ops.getStore();
    const graph = await getGraph(graphId, thread.config, {
      checkpointer,
      store,
    });
    const result = await graph.getState(config, { subgraphs });

    if (
      result.metadata != null &&
      "checkpoint_ns" in result.metadata &&
      result.metadata["checkpoint_ns"] === ""
    ) {
      delete result.metadata["checkpoint_ns"];
    }
    return result;
  }

  async post(
    config: RunnableConfig,
    values:
      | Record<string, unknown>[]
      | Record<string, unknown>
      | null
      | undefined,
    asNode: string | undefined,
    auth: AuthContext | undefined
  ): Promise<{ checkpoint: Record<string, unknown> | undefined }> {
    const threadId = config.configurable?.thread_id;
    const [filters] = await handleAuthEvent(auth, "threads:update", {
      thread_id: threadId,
    });

    const thread = threadId
      ? await this.threads.get(threadId, auth)
      : undefined;
    if (!thread) {
      throw new HTTPException(404, { message: `Thread ${threadId} not found` });
    }

    if (!isAuthMatching(thread.metadata, filters)) {
      throw new HTTPException(403);
    }

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";

    const runningResult = await pool.query(
      `SELECT COUNT(*) as count FROM ${schema}.runs WHERE thread_id = $1 AND status IN ('pending', 'running')`,
      [threadId]
    );
    if (parseInt(runningResult.rows[0].count, 10) > 0) {
      throw new HTTPException(409, { message: "Thread is busy" });
    }

    const graphId = thread.metadata?.graph_id as string | undefined | null;
    if (graphId == null) {
      throw new HTTPException(400, {
        message: `Thread ${threadId} has no graph ID`,
      });
    }

    config.configurable ??= {};
    config.configurable.graph_id ??= graphId;

    const checkpointer = await this.ops.getCheckpointer();
    const store = await this.ops.getStore();
    const graph = await getGraph(graphId, thread.config, {
      checkpointer,
      store,
    });

    const updateConfig = structuredClone(config);
    updateConfig.configurable ??= {};
    updateConfig.configurable.checkpoint_ns ??= "";

    const nextConfig = await graph.updateState(updateConfig, values, asNode);
    const state = await this.get(config, { subgraphs: false }, auth);

    await pool.query(
      `UPDATE ${schema}.threads SET values = $1, updated_at = NOW() WHERE thread_id = $2`,
      [JSON.stringify(state.values), threadId]
    );

    return { checkpoint: nextConfig.configurable };
  }

  async bulk(
    config: RunnableConfig,
    supersteps: Array<{
      updates: Array<{
        values?:
          | Record<string, unknown>[]
          | Record<string, unknown>
          | unknown
          | null
          | undefined;
        command?: RunCommand | undefined | null;
        as_node?: string | undefined;
      }>;
    }>,
    auth: AuthContext | undefined
  ): Promise<{ checkpoint: Record<string, unknown> | undefined } | unknown[]> {
    const threadId = config.configurable?.thread_id;
    if (!threadId) return [];

    const [filters] = await handleAuthEvent(auth, "threads:update", {
      thread_id: threadId,
    });

    const thread = await this.threads.get(threadId, auth);
    if (!isAuthMatching(thread.metadata, filters)) {
      throw new HTTPException(403);
    }

    const graphId = thread.metadata?.graph_id as string | undefined | null;
    if (graphId == null) {
      throw new HTTPException(400, {
        message: `Thread ${threadId} has no graph ID`,
      });
    }

    config.configurable ??= {};
    config.configurable.graph_id ??= graphId;

    const checkpointer = await this.ops.getCheckpointer();
    const store = await this.ops.getStore();
    const graph = await getGraph(graphId, thread.config, {
      checkpointer,
      store,
    });

    const updateConfig = structuredClone(config);
    updateConfig.configurable ??= {};
    updateConfig.configurable.checkpoint_ns ??= "";

    const nextConfig = await graph.bulkUpdateState(
      updateConfig,
      supersteps.map((i) => ({
        updates: i.updates.map((j) => ({
          values: j.command != null ? getLangGraphCommand(j.command) : j.values,
          asNode: j.as_node,
        })),
      }))
    );
    const state = await this.get(config, { subgraphs: false }, auth);

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";
    await pool.query(
      `UPDATE ${schema}.threads SET values = $1, updated_at = NOW() WHERE thread_id = $2`,
      [JSON.stringify(state.values), threadId]
    );

    return { checkpoint: nextConfig.configurable };
  }

  async list(
    config: RunnableConfig,
    options: {
      limit?: number;
      before?: string | RunnableConfig;
      metadata?: Metadata;
    },
    auth: AuthContext | undefined
  ): Promise<LangGraphStateSnapshot[]> {
    const threadId = config.configurable?.thread_id;
    if (!threadId) return [];

    const [filters] = await handleAuthEvent(auth, "threads:read", {
      thread_id: threadId,
    });

    const thread = await this.threads.get(threadId, auth);
    if (!isAuthMatching(thread.metadata, filters)) return [];

    const graphId = thread.metadata?.graph_id as string | undefined | null;
    if (graphId == null) return [];

    const checkpointer = await this.ops.getCheckpointer();
    const store = await this.ops.getStore();
    const graph = await getGraph(graphId, thread.config, {
      checkpointer,
      store,
    });
    const before: RunnableConfig | undefined =
      typeof options?.before === "string"
        ? { configurable: { checkpoint_id: options.before } }
        : options?.before;

    const states: LangGraphStateSnapshot[] = [];
    for await (const state of graph.getStateHistory(config, {
      limit: options?.limit ?? 10,
      before,
      filter: options?.metadata,
    })) {
      states.push(state);
    }

    return states;
  }
}

class PostgresRuns implements RunsRepo {
  private readonly ops: PostgresOps;
  private readonly threads: PostgresThreads;
  public readonly stream: RunsStreamRepo;

  constructor(ops: PostgresOps) {
    this.ops = ops;
    this.threads = new PostgresThreads(ops);
    this.stream = new PostgresRunsStream(ops, this);
  }

  async *next(): AsyncGenerator<{
    run: Run;
    attempt: number;
    signal: AbortSignal;
  }> {
    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";

    const now = new Date();
    const result = await pool.query(
      `SELECT * FROM ${schema}.runs WHERE status = 'pending' AND created_at < $1 ORDER BY created_at ASC`,
      [now]
    );

    for (const row of result.rows) {
      const run = this.rowToRun(row);
      if (this.ops.streamManager.isLocked(run.run_id)) continue;

      try {
        const signal = this.ops.streamManager.lockWithControl
          ? await this.ops.streamManager.lockWithControl(run.run_id)
          : this.ops.streamManager.lock(run.run_id);

        const currentResult = await pool.query(
          `SELECT status FROM ${schema}.runs WHERE run_id = $1`,
          [run.run_id]
        );
        if (
          currentResult.rows.length === 0 ||
          currentResult.rows[0].status !== "pending"
        ) {
          continue;
        }

        const threadResult = await pool.query(
          `SELECT * FROM ${schema}.threads WHERE thread_id = $1`,
          [run.thread_id]
        );
        if (threadResult.rows.length === 0) {
          logger.warn(
            `Unexpected missing thread in Runs.next: ${run.thread_id}`
          );
          continue;
        }

        const runningResult = await pool.query(
          `SELECT COUNT(*) as count FROM ${schema}.runs WHERE thread_id = $1 AND status = 'running'`,
          [run.thread_id]
        );
        if (parseInt(runningResult.rows[0].count, 10) > 0) {
          continue;
        }

        const attemptKey = `retry:${run.run_id}`;
        const attemptResult = await pool.query(
          `SELECT metadata->>'${attemptKey}' as attempt FROM ${schema}.runs WHERE run_id = $1`,
          [run.run_id]
        );
        let attempt = parseInt(attemptResult.rows[0]?.attempt || "0", 10) + 1;

        await pool.query(
          `UPDATE ${schema}.runs SET status = 'running', updated_at = NOW(), metadata = metadata || $1::jsonb WHERE run_id = $2`,
          [JSON.stringify({ [attemptKey]: attempt }), run.run_id]
        );

        yield { run, attempt, signal };
      } finally {
        if (this.ops.streamManager.unlockWithControl) {
          await this.ops.streamManager.unlockWithControl(run.run_id);
        } else {
          this.ops.streamManager.unlock(run.run_id);
        }
      }
    }
  }

  async put(
    runId: string,
    assistantId: string,
    kwargs: RunKwargs,
    options: {
      threadId?: string;
      userId?: string;
      status?: RunStatus;
      metadata?: Metadata;
      preventInsertInInflight?: boolean;
      multitaskStrategy?: MultitaskStrategy;
      ifNotExists?: IfNotExists;
      afterSeconds?: number;
    },
    auth: AuthContext | undefined
  ): Promise<Run[]> {
    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";

    const assistantResult = await pool.query(
      `SELECT * FROM ${schema}.assistants WHERE assistant_id = $1`,
      [assistantId]
    );

    if (assistantResult.rows.length === 0) {
      throw new HTTPException(404, {
        message: `No assistant found for "${assistantId}". Make sure the assistant ID is for a valid assistant or a valid graph ID.`,
      });
    }

    const assistantRow = assistantResult.rows[0];
    const assistant = {
      assistant_id: assistantRow.assistant_id,
      graph_id: assistantRow.graph_id,
      config:
        typeof assistantRow.config === "string"
          ? JSON.parse(assistantRow.config)
          : assistantRow.config,
      context:
        typeof assistantRow.context === "string"
          ? JSON.parse(assistantRow.context)
          : assistantRow.context,
      metadata:
        typeof assistantRow.metadata === "string"
          ? JSON.parse(assistantRow.metadata)
          : assistantRow.metadata,
    };

    const ifNotExists = options?.ifNotExists ?? "reject";
    const multitaskStrategy = options?.multitaskStrategy ?? "reject";
    const afterSeconds = options?.afterSeconds ?? 0;
    const status = options?.status ?? "pending";

    let threadId = options?.threadId;

    const [filters, mutable] = await handleAuthEvent(
      auth,
      "threads:create_run",
      {
        thread_id: threadId,
        assistant_id: assistantId,
        run_id: runId,
        status: status,
        metadata: options?.metadata ?? {},
        prevent_insert_if_inflight: options?.preventInsertInInflight,
        multitask_strategy: multitaskStrategy,
        if_not_exists: ifNotExists,
        after_seconds: afterSeconds,
        kwargs,
      }
    );

    const metadata = mutable.metadata ?? {};
    const config: RunnableConfig = kwargs.config ?? {};

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      let existingThread: Thread | null = null;
      if (threadId != null) {
        const threadResult = await client.query(
          `SELECT * FROM ${schema}.threads WHERE thread_id = $1`,
          [threadId]
        );
        if (threadResult.rows.length > 0) {
          const row = threadResult.rows[0];
          existingThread = {
            thread_id: row.thread_id,
            status: row.status,
            config:
              typeof row.config === "string"
                ? JSON.parse(row.config)
                : row.config,
            metadata:
              typeof row.metadata === "string"
                ? JSON.parse(row.metadata)
                : row.metadata,
            created_at: new Date(row.created_at),
            updated_at: new Date(row.updated_at),
          };
        }
      }

      if (existingThread && !isAuthMatching(existingThread.metadata, filters)) {
        throw new HTTPException(404);
      }

      const now = new Date();

      if (!existingThread && (threadId == null || ifNotExists === "create")) {
        threadId ??= uuid4();
        const threadMetadata = {
          graph_id: assistant.graph_id,
          assistant_id: assistantId,
          ...metadata,
        };
        const threadConfig = Object.assign({}, assistant.config, config, {
          configurable: Object.assign(
            {},
            assistant.config?.configurable,
            config?.configurable
          ),
        });

        await client.query(
          `INSERT INTO ${schema}.threads (thread_id, status, metadata, config) VALUES ($1, 'busy', $2, $3)`,
          [
            threadId,
            JSON.stringify(threadMetadata),
            JSON.stringify(threadConfig),
          ]
        );
      } else if (existingThread) {
        if (existingThread.status !== "busy") {
          const updatedMetadata = {
            ...existingThread.metadata,
            graph_id: assistant.graph_id,
            assistant_id: assistantId,
          };
          const updatedConfig = Object.assign(
            {},
            assistant.config,
            existingThread.config,
            config,
            {
              configurable: Object.assign(
                {},
                assistant.config?.configurable,
                existingThread.config?.configurable,
                config?.configurable
              ),
            }
          );

          await client.query(
            `UPDATE ${schema}.threads SET status = 'busy', metadata = $1, config = $2, updated_at = NOW() WHERE thread_id = $3`,
            [
              JSON.stringify(updatedMetadata),
              JSON.stringify(updatedConfig),
              threadId,
            ]
          );
        }
      } else {
        await client.query("COMMIT");
        return [];
      }

      const inflightResult = await client.query(
        `SELECT * FROM ${schema}.runs WHERE thread_id = $1 AND status IN ('pending', 'running')`,
        [threadId]
      );
      const inflightRuns = inflightResult.rows.map((r) => this.rowToRun(r));

      if (options?.preventInsertInInflight) {
        if (inflightRuns.length > 0) {
          await client.query("COMMIT");
          return inflightRuns;
        }
      }

      const configurable = Object.assign(
        {},
        assistant.config?.configurable,
        existingThread?.config?.configurable,
        config?.configurable,
        {
          run_id: runId,
          thread_id: threadId,
          graph_id: assistant.graph_id,
          assistant_id: assistantId,
          user_id:
            config.configurable?.user_id ??
            existingThread?.config?.configurable?.user_id ??
            assistant.config?.configurable?.user_id ??
            options?.userId,
        }
      );

      const mergedMetadata = Object.assign(
        {},
        assistant.metadata,
        existingThread?.metadata,
        metadata
      );

      const runKwargs = Object.assign({}, kwargs, {
        config: Object.assign(
          {},
          assistant.config,
          config,
          { configurable },
          { metadata: mergedMetadata }
        ),
        context:
          typeof assistant.context !== "object" && assistant.context != null
            ? assistant.context ?? kwargs.context
            : Object.assign({}, assistant.context, kwargs.context),
      });

      const createdAt = new Date(now.valueOf() + afterSeconds * 1000);

      await client.query(
        `INSERT INTO ${schema}.runs (run_id, thread_id, assistant_id, status, metadata, kwargs, multitask_strategy, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          runId,
          threadId,
          assistantId,
          status,
          JSON.stringify(mergedMetadata),
          JSON.stringify(runKwargs),
          multitaskStrategy,
          createdAt,
          now,
        ]
      );

      await client.query("COMMIT");

      const newRun: Run = {
        run_id: runId,
        thread_id: threadId!,
        assistant_id: assistantId,
        metadata: mergedMetadata,
        status: status,
        kwargs: runKwargs,
        multitask_strategy: multitaskStrategy,
        created_at: createdAt,
        updated_at: now,
      };

      return [newRun, ...inflightRuns];
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async get(
    runId: string,
    thread_id: string | undefined,
    auth: AuthContext | undefined
  ): Promise<Run | null> {
    const [filters] = await handleAuthEvent(auth, "threads:read", {
      thread_id,
    });

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";

    const result = await pool.query(
      `SELECT * FROM ${schema}.runs WHERE run_id = $1`,
      [runId]
    );

    if (result.rows.length === 0) return null;

    const run = this.rowToRun(result.rows[0]);
    if (thread_id != null && run.thread_id !== thread_id) return null;

    if (filters != null) {
      const threadResult = await pool.query(
        `SELECT metadata FROM ${schema}.threads WHERE thread_id = $1`,
        [run.thread_id]
      );
      if (threadResult.rows.length === 0) return null;
      const threadMetadata =
        typeof threadResult.rows[0].metadata === "string"
          ? JSON.parse(threadResult.rows[0].metadata)
          : threadResult.rows[0].metadata;
      if (!isAuthMatching(threadMetadata, filters)) return null;
    }

    return run;
  }

  async delete(
    run_id: string,
    thread_id: string | undefined,
    auth: AuthContext | undefined
  ): Promise<string | null> {
    const [filters] = await handleAuthEvent(auth, "threads:delete", {
      run_id,
      thread_id,
    });

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";

    const result = await pool.query(
      `SELECT * FROM ${schema}.runs WHERE run_id = $1`,
      [run_id]
    );

    if (result.rows.length === 0) {
      throw new HTTPException(404, { message: "Run not found" });
    }

    const run = this.rowToRun(result.rows[0]);
    if (thread_id != null && run.thread_id !== thread_id) {
      throw new HTTPException(404, { message: "Run not found" });
    }

    if (filters != null) {
      const threadResult = await pool.query(
        `SELECT metadata FROM ${schema}.threads WHERE thread_id = $1`,
        [run.thread_id]
      );
      if (threadResult.rows.length > 0) {
        const threadMetadata =
          typeof threadResult.rows[0].metadata === "string"
            ? JSON.parse(threadResult.rows[0].metadata)
            : threadResult.rows[0].metadata;
        if (!isAuthMatching(threadMetadata, filters)) {
          throw new HTTPException(404, { message: "Run not found" });
        }
      }
    }

    await pool.query(`DELETE FROM ${schema}.runs WHERE run_id = $1`, [run_id]);
    return run_id;
  }

  async wait(
    runId: string,
    threadId: string | undefined,
    auth: AuthContext | undefined
  ) {
    const runStream = this.stream.join(
      runId,
      threadId,
      { ignore404: threadId == null, lastEventId: undefined },
      auth
    );

    const lastChunk = new Promise(async (resolve, reject) => {
      try {
        let lastChunk: unknown = null;
        for await (const { event, data } of runStream) {
          if (event === "values") {
            lastChunk = data as Record<string, unknown>;
          } else if (event === "error") {
            lastChunk = { __error__: serializeError(data) };
          }
        }
        resolve(lastChunk);
      } catch (error) {
        reject(error);
      }
    });

    return lastChunk;
  }

  async join(runId: string, threadId: string, auth: AuthContext | undefined) {
    await this.threads.get(threadId, auth);
    const lastChunk = await this.wait(runId, threadId, auth);
    if (lastChunk != null) return lastChunk;

    const thread = await this.threads.get(threadId, auth);
    return thread.values ?? null;
  }

  async cancel(
    threadId: string | undefined,
    runIds: string[],
    options: { action?: "interrupt" | "rollback" },
    auth: AuthContext | undefined
  ) {
    const action = options.action ?? "interrupt";
    const promises: Promise<unknown>[] = [];

    const [filters] = await handleAuthEvent(auth, "threads:update", {
      thread_id: threadId,
      action,
      metadata: { run_ids: runIds, status: "pending" },
    });

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";

    let foundRunsCount = 0;

    for (const runId of runIds) {
      const result = await pool.query(
        `SELECT * FROM ${schema}.runs WHERE run_id = $1`,
        [runId]
      );
      if (result.rows.length === 0) continue;

      const run = this.rowToRun(result.rows[0]);
      if (threadId != null && run.thread_id !== threadId) continue;

      if (filters != null) {
        const threadResult = await pool.query(
          `SELECT metadata FROM ${schema}.threads WHERE thread_id = $1`,
          [run.thread_id]
        );
        if (threadResult.rows.length > 0) {
          const threadMetadata =
            typeof threadResult.rows[0].metadata === "string"
              ? JSON.parse(threadResult.rows[0].metadata)
              : threadResult.rows[0].metadata;
          if (!isAuthMatching(threadMetadata, filters)) continue;
        }
      }

      foundRunsCount += 1;

      const control = this.ops.streamManager.getControl(runId);
      const cancelAction = options.action ?? "interrupt";
      if (this.ops.streamManager.publishControl) {
        await this.ops.streamManager.publishControl(runId, cancelAction);
      }
      control?.abort(cancelAction);

      if (run.status === "pending") {
        if (control || action !== "rollback") {
          await pool.query(
            `UPDATE ${schema}.runs SET status = 'interrupted', updated_at = NOW() WHERE run_id = $1`,
            [runId]
          );
          await pool.query(
            `UPDATE ${schema}.threads SET status = 'idle', updated_at = NOW() WHERE thread_id = $1`,
            [run.thread_id]
          );
        } else {
          logger.info("Eagerly deleting unscheduled run with rollback action", {
            run_id: runId,
            thread_id: threadId,
          });
          promises.push(this.delete(runId, threadId, auth));
        }
      } else {
        logger.warn("Attempted to cancel non-pending run.", {
          run_id: runId,
          status: run.status,
        });
      }
    }

    await Promise.all(promises);

    if (foundRunsCount !== runIds.length) {
      throw new HTTPException(404, { message: "Run not found" });
    }

    logger.info("Cancelled runs", {
      run_ids: runIds,
      thread_id: threadId,
      action,
    });
  }

  async search(
    threadId: string,
    options: {
      limit?: number | null;
      offset?: number | null;
      status?: string | null;
      metadata?: Metadata | null;
    },
    auth: AuthContext | undefined
  ) {
    const [filters] = await handleAuthEvent(auth, "threads:search", {
      thread_id: threadId,
      metadata: options.metadata,
      status: options.status,
    });

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";
    const params: unknown[] = [threadId];
    const wheres: string[] = [`thread_id = $1`];

    if (options?.status != null) {
      params.push(options.status);
      wheres.push(`status = $${params.length}`);
    }
    if (options?.metadata != null) {
      params.push(JSON.stringify(options.metadata));
      wheres.push(`metadata @> $${params.length}::jsonb`);
    }

    const limit = options?.limit ?? 10;
    const offset = options?.offset ?? 0;
    params.push(limit, offset);

    const result = await pool.query(
      `SELECT * FROM ${schema}.runs WHERE ${wheres.join(" AND ")} LIMIT $${
        params.length - 1
      } OFFSET $${params.length}`,
      params
    );

    const runs: Run[] = [];
    for (const row of result.rows) {
      const run = this.rowToRun(row);
      if (filters != null) {
        const threadResult = await pool.query(
          `SELECT metadata FROM ${schema}.threads WHERE thread_id = $1`,
          [run.thread_id]
        );
        if (threadResult.rows.length > 0) {
          const threadMetadata =
            typeof threadResult.rows[0].metadata === "string"
              ? JSON.parse(threadResult.rows[0].metadata)
              : threadResult.rows[0].metadata;
          if (!isAuthMatching(threadMetadata, filters)) continue;
        }
      }
      runs.push(run);
    }

    return runs;
  }

  async setStatus(runId: string, status: RunStatus) {
    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";

    const result = await pool.query(
      `UPDATE ${schema}.runs SET status = $1, updated_at = NOW() WHERE run_id = $2 RETURNING *`,
      [status, runId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Run ${runId} not found`);
    }
  }

  private rowToRun(row: any): Run {
    return {
      run_id: row.run_id,
      thread_id: row.thread_id,
      assistant_id: row.assistant_id,
      status: row.status as RunStatus,
      metadata:
        typeof row.metadata === "string"
          ? JSON.parse(row.metadata)
          : row.metadata,
      kwargs:
        typeof row.kwargs === "string" ? JSON.parse(row.kwargs) : row.kwargs,
      multitask_strategy: row.multitask_strategy as MultitaskStrategy,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }
}

class PostgresRunsStream implements RunsStreamRepo {
  private readonly ops: PostgresOps;
  private readonly runs: PostgresRuns;

  constructor(ops: PostgresOps, runs: PostgresRuns) {
    this.ops = ops;
    this.runs = runs;
  }

  async *join(
    runId: string,
    threadId: string | undefined,
    options: {
      ignore404?: boolean;
      cancelOnDisconnect?: AbortSignal;
      lastEventId: string | undefined;
    },
    auth: AuthContext | undefined
  ): AsyncGenerator<{ id?: string; event: string; data: unknown }> {
    const signal = options?.cancelOnDisconnect;
    const queue = this.ops.streamManager.getQueue(runId, {
      ifNotFound: "create",
      resumable: options.lastEventId != null,
    });

    const pool = await this.ops.getPool();
    const schema = this.ops.getConfig().schema ?? "public";

    const [filters] = await handleAuthEvent(auth, "threads:read", {
      thread_id: threadId,
    });

    if (filters != null && threadId != null) {
      const threadResult = await pool.query(
        `SELECT metadata FROM ${schema}.threads WHERE thread_id = $1`,
        [threadId]
      );
      if (threadResult.rows.length > 0) {
        const threadMetadata =
          typeof threadResult.rows[0].metadata === "string"
            ? JSON.parse(threadResult.rows[0].metadata)
            : threadResult.rows[0].metadata;
        if (!isAuthMatching(threadMetadata, filters)) {
          yield {
            event: "error",
            data: { error: "Error", message: "404: Thread not found" },
          };
          return;
        }
      }
    }

    let lastEventId = options?.lastEventId;
    while (!signal?.aborted) {
      try {
        const [id, message] = await queue.get({
          timeout: 500,
          signal,
          lastEventId,
        });

        lastEventId = id;

        if (message.topic === `run:${runId}:control`) {
          if (message.data === "done") break;
        } else {
          const streamTopic = message.topic.substring(
            `run:${runId}:stream:`.length
          );
          yield { id, event: streamTopic, data: message.data };
        }
      } catch (error) {
        if (error instanceof AbortError) break;

        const run = await this.runs.get(runId, threadId, auth);
        if (run == null) {
          if (!options?.ignore404) {
            yield { event: "error", data: "Run not found" };
          }
          break;
        } else if (run.status !== "pending" && run.status !== "running") {
          break;
        }
      }
    }

    if (signal?.aborted && threadId != null) {
      await this.runs.cancel(threadId, [runId], { action: "interrupt" }, auth);
    }
  }

  async publish(payload: {
    runId: string;
    event: string;
    data: unknown;
    resumable: boolean;
  }) {
    const queue = this.ops.streamManager.getQueue(payload.runId, {
      ifNotFound: "create",
      resumable: payload.resumable,
    });
    await queue.push({
      topic: `run:${payload.runId}:stream:${payload.event}`,
      data: payload.data,
    });
  }
}

/**
 * Configuration options for createPostgresOps factory.
 */
export interface CreatePostgresOpsOptions {
  /**
   * PostgreSQL connection URI.
   */
  postgresUri: string;

  /**
   * Database schema to use.
   * @default "public"
   */
  schema?: string;

  /**
   * Redis URL for distributed stream management.
   * If provided, RedisStreamManager will be used for horizontal scaling.
   * If not provided, uses in-memory stream manager (single instance only).
   */
  redisUrl?: string;
}

/**
 * Factory function to create a configured PostgresOps instance.
 *
 * This handles the common setup pattern including:
 * - Pool configuration
 * - Optional Redis stream manager setup
 * - Table creation
 *
 * @example
 * ```typescript
 * // Basic usage (in-memory streams, single instance)
 * const ops = await createPostgresOps({
 *   postgresUri: process.env.DATABASE_URL!,
 * });
 *
 * // With Redis for horizontal scaling
 * const ops = await createPostgresOps({
 *   postgresUri: process.env.DATABASE_URL!,
 *   redisUrl: process.env.REDIS_URL,
 * });
 * ```
 */
export async function createPostgresOps(
  options: CreatePostgresOpsOptions
): Promise<PostgresOps> {
  poolManager.configure({ uri: options.postgresUri, schema: options.schema });

  let streamManager: StreamManager | undefined;

  if (options.redisUrl) {
    const { RedisStreamManager } = await import("../redis/stream.mjs");
    const redisStream = new RedisStreamManager(options.redisUrl);
    await redisStream.connect();
    streamManager = redisStream;
    logger.info("Using Redis for stream management (horizontal scaling enabled)");
  } else {
    logger.info("Using in-memory stream manager (single instance mode)");
  }

  const ops = new PostgresOps({
    uri: options.postgresUri,
    schema: options.schema,
    streamManager,
  });

  await ops.setup();

  return ops;
}
