import { Redis } from "ioredis";
import { storageConfig } from "../config.mjs";
import { logger } from "../../logging.mjs";

class StreamRedisConnectionManager {
  private static instance: StreamRedisConnectionManager;
  private mainConnection: Redis | null = null;
  private subscriberConnection: Redis | null = null;
  
  private constructor() {}

  static getInstance(): StreamRedisConnectionManager {
    if (!StreamRedisConnectionManager.instance) {
      StreamRedisConnectionManager.instance = new StreamRedisConnectionManager();
    }
    return StreamRedisConnectionManager.instance;
  }

  getMainConnection(): Redis {
    if (!storageConfig.REDIS_URI_CUSTOM) {
      throw new Error("REDIS_URI_CUSTOM must be set");
    }

    if (!this.mainConnection) {
      logger.info("Creating shared Redis connection for stream manager");
      this.mainConnection = new Redis(storageConfig.REDIS_URI_CUSTOM, {
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
          const delay = Math.min(times * 50, 2000);
          return delay;
        }
      });

      this.mainConnection.on("error", (err) => {
        logger.error("Stream Redis connection error", { error: err });
      });
    }

    return this.mainConnection;
  }

  getSubscriberConnection(): Redis {
    if (!storageConfig.REDIS_URI_CUSTOM) {
      throw new Error("REDIS_URI_CUSTOM must be set");
    }

    if (!this.subscriberConnection) {
      logger.info("Creating shared Redis subscriber connection for stream manager");
      this.subscriberConnection = new Redis(storageConfig.REDIS_URI_CUSTOM, {
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
          const delay = Math.min(times * 50, 2000);
          return delay;
        }
      });

      this.subscriberConnection.on("error", (err) => {
        logger.error("Stream Redis subscriber connection error", { error: err });
      });
    }

    return this.subscriberConnection;
  }

  async disconnect(): Promise<void> {
    const promises: Promise<void>[] = [];
    
    if (this.mainConnection) {
      logger.info("Disconnecting stream Redis main connection");
      promises.push(this.mainConnection.quit().then(() => {
        this.mainConnection = null;
      }));
    }
    
    if (this.subscriberConnection) {
      logger.info("Disconnecting stream Redis subscriber connection");
      promises.push(this.subscriberConnection.quit().then(() => {
        this.subscriberConnection = null;
      }));
    }

    await Promise.all(promises);
  }
}

export const streamRedisConnectionManager = StreamRedisConnectionManager.getInstance();