import { createClient, type RedisClientType } from "redis";
import type {
  Message,
  StreamManager,
  StreamQueue,
  StreamAbortController,
} from "../types.mjs";

export type { Message };

class TimeoutError extends Error {
  constructor() {
    super("Timeout waiting for message");
    this.name = "TimeoutError";
  }
}

class AbortError extends Error {
  constructor() {
    super("Operation aborted");
    this.name = "AbortError";
  }
}

class CancellationAbortController extends AbortController implements StreamAbortController {
  abort(reason: "rollback" | "interrupt") {
    super.abort(reason);
  }
}

export class RedisQueue implements StreamQueue {
  private readonly streamManager: RedisStreamManager;
  private readonly resumable: boolean;
  private readonly streamKey: string;
  private lastReadId: string = "0";

  constructor(
    streamManager: RedisStreamManager,
    runId: string,
    options: { resumable: boolean }
  ) {
    this.streamManager = streamManager;
    this.resumable = options.resumable;
    this.streamKey = `langgraph:stream:${runId}`;
  }

  async push(item: Message): Promise<void> {
    const client = this.streamManager.getClient();
    if (!client) {
      throw new Error("Redis client not connected");
    }

    await client.xAdd(this.streamKey, "*", {
      topic: item.topic,
      data: JSON.stringify(item.data),
    });
  }

  async get(options: {
    timeout: number;
    lastEventId?: string;
    signal?: AbortSignal;
  }): Promise<[id: string, message: Message]> {
    const client = this.streamManager.getClient();
    if (!client) {
      throw new Error("Redis client not connected");
    }

    if (options.signal?.aborted) {
      throw new AbortError();
    }

    let startId: string;
    if (this.resumable && options.lastEventId != null) {
      startId = options.lastEventId;
    } else if (this.resumable) {
      startId = "0";
    } else {
      startId = this.lastReadId;
    }

    const startTime = Date.now();
    const blockTime = Math.min(options.timeout, 100);

    while (Date.now() - startTime < options.timeout) {
      if (options.signal?.aborted) {
        throw new AbortError();
      }

      const results = await client.xRead(
        { key: this.streamKey, id: startId },
        { BLOCK: blockTime, COUNT: 1 }
      );

      if (results && results.length > 0) {
        const stream = results[0];
        if (stream.messages.length > 0) {
          const entry = stream.messages[0];
          const id = entry.id;
          const message: Message = {
            topic: entry.message.topic as Message["topic"],
            data: JSON.parse(entry.message.data),
          };

          if (!this.resumable) {
            this.lastReadId = id;
          }

          return [id, message];
        }
      }
    }

    throw new TimeoutError();
  }
}

export type ControlAction = "interrupt" | "rollback";

export class RedisStreamManager implements StreamManager {
  private readonly url: string;
  private client: RedisClientType | null = null;
  private subscriberClient: RedisClientType | null = null;
  private queues: Record<string, RedisQueue> = {};
  private control: Record<string, CancellationAbortController> = {};
  private controlSubscriptions: Record<string, () => Promise<void>> = {};

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    if (this.client) return;

    this.client = createClient({ url: this.url }) as RedisClientType;
    await this.client.connect();

    this.subscriberClient = this.client.duplicate() as RedisClientType;
    await this.subscriberClient.connect();
  }

  async close(): Promise<void> {
    for (const runId of Object.keys(this.controlSubscriptions)) {
      await this.controlSubscriptions[runId]();
    }
    this.controlSubscriptions = {};

    if (this.subscriberClient?.isOpen) {
      await this.subscriberClient.disconnect();
    }
    this.subscriberClient = null;

    if (this.client?.isOpen) {
      await this.client.disconnect();
    }
    this.client = null;
    this.queues = {};
    this.control = {};
  }

  getClient(): RedisClientType | null {
    return this.client;
  }

  getQueue(
    runId: string,
    options: { ifNotFound: "create"; resumable: boolean }
  ): RedisQueue {
    if (this.queues[runId] == null) {
      this.queues[runId] = new RedisQueue(this, runId, {
        resumable: options.resumable,
      });
    }
    return this.queues[runId];
  }

  getControl(runId: string): StreamAbortController | undefined {
    return this.control[runId];
  }

  isLocked(runId: string): boolean {
    return this.control[runId] != null;
  }

  lock(runId: string): AbortSignal {
    if (this.control[runId] != null) {
      console.warn("Run already locked", { run_id: runId });
    }
    this.control[runId] = new CancellationAbortController();
    return this.control[runId].signal;
  }

  unlock(runId: string): void {
    delete this.control[runId];
  }

  private getControlChannel(runId: string): string {
    return `langgraph:control:${runId}`;
  }

  async publishControl(runId: string, action: ControlAction): Promise<void> {
    if (!this.client) {
      throw new Error("Redis client not connected");
    }
    await this.client.publish(this.getControlChannel(runId), action);
  }

  async subscribeControl(
    runId: string,
    callback: (action: ControlAction) => void
  ): Promise<() => Promise<void>> {
    if (!this.subscriberClient) {
      throw new Error("Redis subscriber client not connected");
    }

    const channel = this.getControlChannel(runId);

    await this.subscriberClient.subscribe(channel, (message) => {
      callback(message as ControlAction);
    });

    const unsubscribe = async () => {
      if (this.subscriberClient) {
        await this.subscriberClient.unsubscribe(channel);
      }
    };

    return unsubscribe;
  }

  async lockWithControl(runId: string): Promise<AbortSignal> {
    if (this.control[runId] != null) {
      console.warn("Run already locked", { run_id: runId });
    }

    const controller = new CancellationAbortController();
    this.control[runId] = controller;

    const unsubscribe = await this.subscribeControl(runId, (action) => {
      controller.abort(action);
    });

    this.controlSubscriptions[runId] = unsubscribe;

    return controller.signal;
  }

  async unlockWithControl(runId: string): Promise<void> {
    if (this.controlSubscriptions[runId]) {
      await this.controlSubscriptions[runId]();
      delete this.controlSubscriptions[runId];
    }
    delete this.control[runId];
  }
}
