import { v7 as uuid } from "uuid";
import { createBridge } from "@langchain/langgraph-api/utils";

export type Asset = {
  id: string;
  text: string;
  locked: boolean;
  rejected: boolean;
};

export type Headline = Asset;
export type Description = Asset;

export type AdsState = {
  headlines: Headline[];
  descriptions: Description[];
};

export const toHeadline = (headline: string): Headline => ({
  id: uuid(),
  text: headline,
  locked: false,
  rejected: false,
});

export const toDescription = (description: string): Description => ({
  id: uuid(),
  text: description,
  locked: false,
  rejected: false,
});

export const transformHeadlines = (raw: unknown): Headline[] => {
  return (raw as string[]).map(toHeadline);
};

export const transformDescriptions = (raw: unknown): Description[] => {
  return (raw as string[]).map(toDescription);
};

export const adsBridge = createBridge<AdsState>({
  jsonTarget: "state",
  transforms: {
    headlines: transformHeadlines,
    descriptions: transformDescriptions,
  },
});
