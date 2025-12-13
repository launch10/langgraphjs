/**
 * PostgreSQL Connection Pool Manager for LangGraph API
 *
 * This module provides a singleton pool manager that maintains a single shared
 * PostgreSQL connection pool across all components (Ops, Checkpointer, Store).
 *
 * Key design decisions:
 * - Single pool instance prevents connection exhaustion
 * - Lazy initialization - pool created on first getPool() call
 * - Configuration must be set before pool creation
 * - Clean shutdown support for graceful server termination
 *
 * @example
 * ```typescript
 * import { poolManager } from "./pool.mjs";
 *
 * // Configure before use
 * poolManager.configure({ uri: "postgresql://localhost:5432/db" });
 *
 * // Get pool (creates on first call)
 * const pool = await poolManager.getPool();
 *
 * // Use pool for queries
 * const result = await pool.query("SELECT 1");
 *
 * // Shutdown on server exit
 * await poolManager.shutdown();
 * ```
 *
 * @module storage/postgres/pool
 */

import type { Pool as PoolType } from "pg";
import * as pg from "pg";

const { Pool } = pg.default ?? pg;

/**
 * Configuration options for PostgreSQL connection.
 */
export interface PostgresConfig {
  /**
   * PostgreSQL connection URI.
   * @example "postgresql://user:pass@localhost:5432/database"
   */
  uri: string;

  /**
   * Database schema to use for tables.
   * @default "public"
   */
  schema?: string;
}

/**
 * Singleton manager for PostgreSQL connection pool.
 *
 * Ensures a single pool is shared across all components to prevent
 * connection exhaustion and provide consistent connection management.
 */
class PostgresPoolManager {
  private pool: PoolType | null = null;
  private config: PostgresConfig | null = null;

  /**
   * Configure the pool manager with connection settings.
   * Must be called before getPool().
   *
   * @param config - PostgreSQL configuration
   * @throws Error if pool is already initialized
   */
  configure(config: PostgresConfig): void {
    if (this.pool != null) {
      throw new Error("Pool already initialized. Call shutdown() first.");
    }
    this.config = config;
  }

  /**
   * Get the PostgreSQL connection pool, creating it if necessary.
   *
   * The pool is created lazily on first call. Subsequent calls return
   * the same pool instance.
   *
   * @returns Promise resolving to the pg.Pool instance
   * @throws Error if not configured
   */
  async getPool(): Promise<PoolType> {
    if (this.pool != null) {
      return this.pool;
    }

    if (this.config == null) {
      throw new Error(
        "PostgresPoolManager not configured. Call configure() first."
      );
    }

    this.pool = new Pool({
      connectionString: this.config.uri,
    });

    this.pool.on("error", (err) => {
      console.error("Unexpected error on idle PostgreSQL client", err);
    });

    return this.pool;
  }

  /**
   * Get the current configuration.
   *
   * @returns The PostgresConfig object
   * @throws Error if not configured
   */
  getConfig(): PostgresConfig {
    if (this.config == null) {
      throw new Error(
        "PostgresPoolManager not configured. Call configure() first."
      );
    }
    return this.config;
  }

  /**
   * Check if the pool manager has been configured.
   *
   * @returns true if configure() has been called
   */
  isConfigured(): boolean {
    return this.config != null;
  }

  /**
   * Gracefully shutdown the connection pool.
   *
   * Waits for all active queries to complete, then closes all connections.
   * Safe to call multiple times or when pool hasn't been created.
   */
  async shutdown(): Promise<void> {
    if (this.pool != null) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

/**
 * Singleton instance of the PostgreSQL pool manager.
 *
 * Import and use this instance throughout the application:
 * ```typescript
 * import { poolManager } from "./storage/postgres/pool.mjs";
 * ```
 */
export const poolManager = new PostgresPoolManager();
