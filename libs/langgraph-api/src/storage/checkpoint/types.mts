import { 
    BaseCheckpointSaver,
} from "@langchain/langgraph"
export interface APISaver {
    initialize(cwd: string): Promise<APISaver>;
    clear(): Promise<void> | void;
    delete(threadId: string, runId: string | null | undefined): Promise<void>;
    copy(threadId: string, newThreadId: string): Promise<void> | void;
    getTuple(...args: Parameters<BaseCheckpointSaver["getTuple"]>): ReturnType<BaseCheckpointSaver["getTuple"]>
    list(...args: Parameters<BaseCheckpointSaver["list"]>): ReturnType<BaseCheckpointSaver["list"]>
    putWrites(...args: Parameters<BaseCheckpointSaver["putWrites"]>): ReturnType<BaseCheckpointSaver["putWrites"]>
    put(...args: Parameters<BaseCheckpointSaver["put"]>): ReturnType<BaseCheckpointSaver["put"]>
    toJSON(): string;
}