import { AsyncLocalStorage } from "async_hooks";

export interface ParsedStructuredData {
  data: Record<string, unknown>;
}

type ParsingStore = Map<string, ParsedStructuredData>;

export const parsingContext = new AsyncLocalStorage<ParsingStore>();

export function getParsingStore(): ParsingStore | undefined {
  return parsingContext.getStore();
}

export function runWithParsingContext<T>(fn: () => T): T {
  return parsingContext.run(new Map(), fn);
}

export async function runWithParsingContextAsync<T>(fn: () => Promise<T>): Promise<T> {
  return parsingContext.run(new Map(), fn);
}

export function cacheStructuredData(
  messageId: string,
  data: Record<string, unknown>
): Record<string, unknown> {
  const store = getParsingStore();
  if (!store) {
    return data;
  }

  store.set(messageId, { data });
  return data;
}

export function getCachedStructuredData(
  messageId: string
): ParsedStructuredData | undefined {
  const store = getParsingStore();
  return store?.get(messageId);
}
