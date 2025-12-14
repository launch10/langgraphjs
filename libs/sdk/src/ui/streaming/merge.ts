import type { MergeReducer } from "./types.js";

export const MergeStrategies = {
  replace: <T>(): MergeReducer<T> => {
    return (incoming: T, _current: T | undefined): T => incoming;
  },

  append: <T>(): MergeReducer<T[]> => {
    return (incoming: T[], current: T[] | undefined): T[] => {
      if (current === undefined) return incoming;
      return [...current, ...incoming];
    };
  },

  appendUnique: <T, K extends keyof T>(key: K): MergeReducer<T[]> => {
    return (incoming: T[], current: T[] | undefined): T[] => {
      if (current === undefined) return incoming;

      const map = new Map<T[K], T>();
      for (const item of current) {
        map.set(item[key], item);
      }
      for (const item of incoming) {
        map.set(item[key], item);
      }

      return Array.from(map.values());
    };
  },

  prepend: <T>(): MergeReducer<T[]> => {
    return (incoming: T[], current: T[] | undefined): T[] => {
      if (current === undefined) return incoming;
      return [...incoming, ...current];
    };
  },

  prependUnique: <T, K extends keyof T>(key: K): MergeReducer<T[]> => {
    return (incoming: T[], current: T[] | undefined): T[] => {
      if (current === undefined) return incoming;

      const seen = new Set<T[K]>();
      const result: T[] = [];

      for (const item of incoming) {
        if (!seen.has(item[key])) {
          seen.add(item[key]);
          result.push(item);
        }
      }

      for (const item of current) {
        if (!seen.has(item[key])) {
          seen.add(item[key]);
          result.push(item);
        }
      }

      return result;
    };
  },

  deepMerge: <T extends object>(): MergeReducer<T> => {
    return (incoming: T, current: T | undefined): T => {
      if (current === undefined) return incoming;

      const result = { ...current } as T;

      for (const key in incoming) {
        if (Object.prototype.hasOwnProperty.call(incoming, key)) {
          const incomingValue = incoming[key];
          const currentValue = result[key];

          if (
            typeof incomingValue === "object" &&
            incomingValue !== null &&
            !Array.isArray(incomingValue) &&
            typeof currentValue === "object" &&
            currentValue !== null &&
            !Array.isArray(currentValue)
          ) {
            result[key] = MergeStrategies.deepMerge<object>()(
              incomingValue as object,
              currentValue as object
            ) as T[Extract<keyof T, string>];
          } else {
            result[key] = incomingValue;
          }
        }
      }

      return result;
    };
  },

  appendWithLimit: <T>(limit: number): MergeReducer<T[]> => {
    return (incoming: T[], current: T[] | undefined): T[] => {
      if (current === undefined) {
        return incoming.slice(-limit);
      }
      const combined = [...current, ...incoming];
      return combined.slice(-limit);
    };
  },

  upsert: <T, K extends keyof T>(key: K): MergeReducer<T[]> => {
    return (incoming: T[], current: T[] | undefined): T[] => {
      if (current === undefined) return incoming;

      const incomingMap = new Map<T[K], T>();
      for (const item of incoming) {
        incomingMap.set(item[key], item);
      }

      const result: T[] = [];
      const seen = new Set<T[K]>();

      for (const item of current) {
        const itemKey = item[key];
        if (incomingMap.has(itemKey)) {
          result.push(incomingMap.get(itemKey)!);
          seen.add(itemKey);
        } else {
          result.push(item);
        }
      }

      for (const item of incoming) {
        if (!seen.has(item[key])) {
          result.push(item);
        }
      }

      return result;
    };
  },

  custom: <T>(
    fn: MergeReducer<T>,
    fallback?: (incoming: T) => T
  ): MergeReducer<T> => {
    return (incoming: T, current: T | undefined): T => {
      try {
        return fn(incoming, current);
      } catch (error) {
        console.error("Merge reducer error:", error);
        return fallback ? fallback(incoming) : incoming;
      }
    };
  },
};

export type { MergeReducer, MergeReducers } from "./types.js";
