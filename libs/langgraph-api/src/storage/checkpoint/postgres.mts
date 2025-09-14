import { PostgresSaver as CorePostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { APISaver } from "./types.mjs";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  type Checkpoint,
  type CheckpointMetadata,
} from "@langchain/langgraph";
import type { ChannelVersions } from "@langchain/langgraph-checkpoint";

const TABLES = [
    "checkpoints",
    "checkpoint_blobs",
    "checkpoint_writes",
    "checkpoint_migrations"
]

const EXCLUDED_KEYS = ["checkpoint_ns", "checkpoint_id", "run_id", "thread_id"];

export class PostgresSaver extends CorePostgresSaver implements APISaver {
    async initialize(cwd: string): Promise<PostgresSaver> {
        await this.setup();
        return this;
    }

    async flush() {
        return Promise.resolve(true)
    }

    async clear(): Promise<void> {
        // @ts-ignore - We have access to pool.connect
        const client = await this.pool.connect();
        const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';");
        const existingTables = res.rows.map((t: any) => t.table_name)
        const tables = existingTables.filter((t: string) => TABLES.includes(t))
        // @ts-ignore - We have access to options.schema
        const truncateStatements = tables.map((t: string) => `TRUNCATE TABLE ${this.options.schema}.${t}`)
        await client.query(`
            BEGIN;
            ${truncateStatements.join(";\n")};
            COMMIT;
        `);
        
        client.release();
    }

    async copy(threadId: string, newThreadId: string): Promise<void> {
        // @ts-ignore - We have access to pool.connect
        const client = await this.pool.connect();
        
        try {
            await client.query('BEGIN');
            
            // @ts-ignore - We have access to options.schema
            const schema = this.options.schema;
            
            await client.query(`
                INSERT INTO ${schema}.checkpoints (
                    thread_id, checkpoint_id, run_id, parent_checkpoint_id, 
                    checkpoint, metadata, checkpoint_ns
                )
                SELECT 
                    $2 as thread_id,
                    checkpoint_id,
                    run_id,
                    parent_checkpoint_id,
                    checkpoint,
                    metadata,
                    checkpoint_ns
                FROM ${schema}.checkpoints 
                WHERE thread_id = $1
                ORDER BY checkpoint_id
            `, [threadId, newThreadId]);
            
            await client.query(`
                INSERT INTO ${schema}.checkpoint_blobs (
                    thread_id, channel, version, type, blob, checkpoint_ns
                )
                SELECT 
                    $2 as thread_id,
                    channel,
                    version,
                    type,
                    blob,
                    checkpoint_ns
                FROM ${schema}.checkpoint_blobs 
                WHERE thread_id = $1
                ORDER BY channel, version
            `, [threadId, newThreadId]);
            
            await client.query(`
                INSERT INTO ${schema}.checkpoint_writes (
                    thread_id, checkpoint_id, task_id, idx, channel, type, blob, checkpoint_ns
                )
                SELECT 
                    $2 as thread_id,
                    checkpoint_id,
                    task_id,
                    idx,
                    channel,
                    type,
                    blob,
                    checkpoint_ns
                FROM ${schema}.checkpoint_writes 
                WHERE thread_id = $1
                ORDER BY checkpoint_id, task_id, idx
            `, [threadId, newThreadId]);
            
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async delete(threadId: string, runId: string | null | undefined): Promise<void> {
        // @ts-ignore - We have access to pool.connect
        const client = await this.pool.connect();
        
        try {
            await client.query('BEGIN');
            
            // @ts-ignore - We have access to options.schema
            const schema = this.options.schema;
            
            if (runId != null) {
                // Delete specific run's data
                await client.query(`DELETE FROM ${schema}.checkpoint_writes WHERE thread_id = $1 AND checkpoint_id IN (
                    SELECT checkpoint_id FROM ${schema}.checkpoints WHERE thread_id = $1 AND run_id = $2
                )`, [threadId, runId]);
                
                // For checkpoint_blobs, we need to delete based on thread_id only since it doesn't have checkpoint_id
                await client.query(`DELETE FROM ${schema}.checkpoint_blobs WHERE thread_id = $1`, [threadId]);
                
                await client.query(`DELETE FROM ${schema}.checkpoints WHERE thread_id = $1 AND run_id = $2`, [threadId, runId]);
            } else {
                // Delete all data for the thread
                await client.query(`DELETE FROM ${schema}.checkpoint_writes WHERE thread_id = $1`, [threadId]);
                await client.query(`DELETE FROM ${schema}.checkpoint_blobs WHERE thread_id = $1`, [threadId]);
                await client.query(`DELETE FROM ${schema}.checkpoints WHERE thread_id = $1`, [threadId]);
            }
            
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async put(
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        newVersions: ChannelVersions
    ): Promise<RunnableConfig> {
        // Merge config.metadata with checkpoint metadata, similar to InMemorySaver
        const mergedMetadata = {
            ...Object.fromEntries(
                Object.entries(config.configurable ?? {}).filter(
                    ([key]) => !key.startsWith("__") && !EXCLUDED_KEYS.includes(key),
                ),
            ),
            ...config.metadata,
            ...metadata,
        };

        return await super.put(config, checkpoint, mergedMetadata, newVersions);
    }

    toJSON() {
        return "[PostgresSaver]";
    }
}