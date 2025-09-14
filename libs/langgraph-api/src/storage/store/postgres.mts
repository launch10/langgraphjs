import { PostgresStore as BasePostgresStore } from "@langchain/langgraph-store-postgres";
import { StoreInterface } from "./types.mjs";

export class PostgresStore extends BasePostgresStore implements StoreInterface {
    async initialize(cwd: string): Promise<StoreInterface> {
        await this.setup();
        return this;
    }

    async flush(): Promise<boolean> {
        return true;
    }
}