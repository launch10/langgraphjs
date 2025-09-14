import { Redis } from "ioredis";
import { storageConfig } from "../config.mjs";
import { logger } from "../../logging.mjs";

class RedisConnectionManager {
  private static instance: RedisConnectionManager;
  private mainConnection: Redis | null = null;
  private connectionCount = 0;
  
  private constructor() {}

  static getInstance(): RedisConnectionManager {
    if (!RedisConnectionManager.instance) {
      RedisConnectionManager.instance = new RedisConnectionManager();
    }
    return RedisConnectionManager.instance;
  }

  getConnection(): Redis {
    if (!storageConfig.REDIS_URI_CUSTOM) {
      throw new Error("REDIS_URI_CUSTOM must be set");
    }

    if (!this.mainConnection) {
      logger.info("Creating shared Redis connection");
      this.mainConnection = new Redis(storageConfig.REDIS_URI_CUSTOM, {
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        reconnectOnError(err) {
          const targetError = "READONLY";
          if (err.message.includes(targetError)) {
            return true;
          }
          return false;
        }
      });

      this.mainConnection.on("error", (err) => {
        logger.error("Redis connection error", { error: err });
      });

      this.mainConnection.on("close", () => {
        logger.warn("Redis connection closed");
      });

      this.mainConnection.on("reconnecting", () => {
        logger.info("Redis reconnecting...");
      });

      this.mainConnection.on("connect", () => {
        logger.info("Redis connected");
      });
    }

    this.connectionCount++;
    return this.mainConnection;
  }

  createBlockingConnection(uri: string): Redis {
    return new Redis(uri, {
      maxRetriesPerRequest: 0,
    });
  }

  async disconnect(): Promise<void> {
    if (this.mainConnection) {
      logger.info("Disconnecting shared Redis connection");
      await this.mainConnection.quit();
      this.mainConnection = null;
      this.connectionCount = 0;
    }
  }

  getConnectionCount(): number {
    return this.connectionCount;
  }
}

export const redisConnectionManager = RedisConnectionManager.getInstance();