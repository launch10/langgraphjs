import { 
    InMemoryStore as BaseMemoryStore,
    type Operation,
    type OperationResults
} from "@langchain/langgraph";
export interface StoreInterface {
    initialize(cwd: string): Promise<StoreInterface>;
    flush(): Promise<boolean>;
    clear(): Promise<void> | void;
    batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>>;
    get(...args: Parameters<BaseMemoryStore["get"]>): ReturnType<BaseMemoryStore["get"]>;
    search(...args: Parameters<BaseMemoryStore["search"]>): ReturnType<BaseMemoryStore["search"]>;
    put(...args: Parameters<BaseMemoryStore["put"]>): ReturnType<BaseMemoryStore["put"]>;
    delete(...args: Parameters<BaseMemoryStore["delete"]>): ReturnType<BaseMemoryStore["delete"]>;
    listNamespaces(...args: Parameters<BaseMemoryStore["listNamespaces"]>): ReturnType<BaseMemoryStore["listNamespaces"]>;
    start(): void;
    stop(): void;
    end(): void;
}