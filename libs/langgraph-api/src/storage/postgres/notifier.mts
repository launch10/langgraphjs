import { EventEmitter } from "events";
import type { Pool, Client, Notification } from "pg";
import * as pg from "pg";

const { Client: PgClient } = (pg as any).default ?? pg;

export class PostgresNotifier extends EventEmitter {
  private connectionString: string;
  private client: Client | null = null;
  private connected = false;
  private channelListeners: Map<string, Set<(payload: string) => void>> =
    new Map();
  private activeChannels: Set<string> = new Set();

  constructor(connectionString: string) {
    super();
    this.connectionString = connectionString;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const client = new PgClient({ connectionString: this.connectionString });
    this.client = client;

    client.on("notification", (msg: Notification) => {
      this.handleNotification(msg);
    });

    client.on("error", (err: Error) => {
      this.emit("error", err);
    });

    client.on("end", () => {
      this.connected = false;
      this.activeChannels.clear();
    });

    await client.connect();
    this.connected = true;
  }

  async close(): Promise<void> {
    if (!this.client) return;

    try {
      for (const channel of this.activeChannels) {
        await this.client.query(`UNLISTEN ${this.escapeIdentifier(channel)}`);
      }
    } catch {
      // Ignore errors during cleanup
    }

    this.activeChannels.clear();
    this.channelListeners.clear();

    try {
      await this.client.end();
    } catch {
      // Ignore errors during cleanup
    }

    this.client = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private escapeIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  private handleNotification(msg: Notification): void {
    const { channel, payload } = msg;
    const listeners = this.channelListeners.get(channel);

    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(payload ?? "");
        } catch (err) {
          this.emit("error", err);
        }
      }
    }
  }

  async listen(
    channel: string,
    callback: (payload: string) => void
  ): Promise<() => void> {
    if (!this.client || !this.connected) {
      throw new Error("Not connected. Call connect() first.");
    }

    if (!this.channelListeners.has(channel)) {
      this.channelListeners.set(channel, new Set());
    }

    this.channelListeners.get(channel)!.add(callback);

    if (!this.activeChannels.has(channel)) {
      await this.client.query(`LISTEN ${this.escapeIdentifier(channel)}`);
      this.activeChannels.add(channel);
    }

    return () => {
      const listeners = this.channelListeners.get(channel);
      if (listeners) {
        listeners.delete(callback);
        if (listeners.size === 0) {
          this.channelListeners.delete(channel);
          this.activeChannels.delete(channel);
          if (this.client && this.connected) {
            this.client
              .query(`UNLISTEN ${this.escapeIdentifier(channel)}`)
              .catch(() => {});
          }
        }
      }
    };
  }

  async waitForNotification(
    channel: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let timeoutId: NodeJS.Timeout | undefined;
      let unsubscribe: (() => void) | undefined;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (unsubscribe) unsubscribe();
      };

      const onAbort = () => {
        cleanup();
        reject(new Error("Aborted"));
      };

      signal?.addEventListener("abort", onAbort, { once: true });

      timeoutId = setTimeout(() => {
        cleanup();
        signal?.removeEventListener("abort", onAbort);
        reject(new Error("Timeout waiting for notification"));
      }, timeoutMs);

      this.listen(channel, (payload) => {
        cleanup();
        signal?.removeEventListener("abort", onAbort);
        resolve(payload);
      })
        .then((unsub) => {
          unsubscribe = unsub;
        })
        .catch((err) => {
          cleanup();
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        });
    });
  }

  async setupRunTrigger(pool: Pool, schema: string = "public"): Promise<void> {
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
}
