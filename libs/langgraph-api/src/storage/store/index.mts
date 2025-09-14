export * from "./types.mjs";
import { storageConfig } from "../config.mjs";
import { PostgresStore } from "./postgres.mjs";
import { InMemoryStore } from "./memory.mjs";
import { StoreInterface } from "./types.mjs";
import { logger } from "../../logging.mjs";
import { type Operation, type OperationResults } from "@langchain/langgraph";

export class Store implements StoreInterface {
  private adapters: Record<string, StoreInterface> = {};

  async initialize(...args: Parameters<StoreInterface["initialize"]>): ReturnType<StoreInterface["initialize"]> {
    const adapter = await this.adapter();
    this.log("initialize");
    return adapter.initialize(...args);
  }

  async flush(...args: Parameters<StoreInterface["flush"]>): ReturnType<StoreInterface["flush"]> {
    const adapter = this.adapter();
    this.log("flush");
    return adapter.flush(...args);
  }

  async clear(...args: Parameters<StoreInterface["clear"]>): Promise<void> {
    const adapter = this.adapter();
    this.log("clear");
    return adapter.clear(...args);
  }

  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const adapter = this.adapter();
    this.log("batch");
    return adapter.batch(operations);
  }

  async get(...args: Parameters<StoreInterface["get"]>): ReturnType<StoreInterface["get"]> {
    const adapter = this.adapter();
    this.log("get");
    return adapter.get(...args);
  }

  async search(...args: Parameters<StoreInterface["search"]>): ReturnType<StoreInterface["search"]> {
    const adapter = this.adapter();
    this.log("search");
    return adapter.search(...args);
  }

  async put(...args: Parameters<StoreInterface["put"]>): ReturnType<StoreInterface["put"]> {
    const adapter = this.adapter();
    this.log("put");
    return adapter.put(...args);
  }

  async listNamespaces(...args: Parameters<StoreInterface["listNamespaces"]>): ReturnType<StoreInterface["listNamespaces"]> {
    const adapter = this.adapter();
    this.log("listNamespaces");
    return adapter.listNamespaces(...args);
  }

  async delete(...args: Parameters<StoreInterface["delete"]>): ReturnType<StoreInterface["delete"]> {
    const adapter = this.adapter();
    this.log("delete");
    return adapter.delete(...args);
  }

  start() {
    const adapter = this.adapter();
    return adapter.start();
  }

  stop() {
    const adapter = this.adapter();
    return adapter.stop();
  }

  end() {
    const adapter = this.adapter();
    return adapter.end();
  }

  private implementation(): string {
    if (storageConfig.POSTGRES_URI_CUSTOM) {
        return "postgres";
    } else {
        return "memory";
    }
  }

  private log(method: string) {
    const implName = this.implementation();
    const capitalized = implName.charAt(0).toUpperCase() + implName.slice(1);
    logger.debug(`[${capitalized}Store]#${method}`)
  }

  private adapter(): StoreInterface {
    const impl = this.implementation();

    if (impl == "postgres") {
      if (this.adapters.postgres) return this.adapters.postgres;

      const options = {
        connectionOptions: storageConfig.POSTGRES_URI_CUSTOM,
        schema: storageConfig.POSTGRES_SCHEMA
      }
      this.adapters.postgres = new PostgresStore(options);
      return this.adapters.postgres;
    } else {
      if (this.adapters.memory) return this.adapters.memory; 

      this.adapters.memory = new InMemoryStore();
      return this.adapters.memory;
    }
  }
}