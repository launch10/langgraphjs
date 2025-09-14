import { Metadata } from "./metadata.mjs";
import { RunnableConfig } from "./runnableConfig.mjs";

export interface AssistantVersion {
  assistant_id: string;
  version: number;
  graph_id: string;
  config: RunnableConfig;
  metadata: Metadata;
  created_at: Date;
  name: string | undefined;
}