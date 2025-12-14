import type { Message } from "@langchain/langgraph-sdk";
import type { MergeReducers } from "../../../../ui/streaming/types.js";

export interface Headline {
  id: string;
  text: string;
  locked: boolean;
  rejected: boolean;
}

export interface Description {
  id: string;
  text: string;
}

export interface AdsState {
  messages: Message[];
  headlines: Headline[];
  descriptions: Description[];
}

export interface StructuredOutput {
  intro: string;
  bulletPoints: string[];
  conclusion: string;
}

export interface SampleGraphState {
  messages: Message[];
  projectName?: string;
}

export const adsMerge: MergeReducers<AdsState> = {
  headlines: (incoming, _current) => {
    if (!Array.isArray(incoming)) return _current ?? [];
    return incoming.map((h) => ({
      id: h.id ?? `h-${Math.random().toString(36).slice(2)}`,
      text: h.text ?? "",
      locked: h.locked ?? false,
      rejected: h.rejected ?? false,
    }));
  },
  descriptions: (incoming, _current) => {
    if (!Array.isArray(incoming)) return _current ?? [];
    return incoming.map((d) => ({
      id: d.id ?? `d-${Math.random().toString(36).slice(2)}`,
      text: d.text ?? "",
    }));
  },
};
