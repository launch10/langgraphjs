/**
 * Generates a stable hash string from any value.
 * Same input always produces same output, making it suitable
 * for generating deterministic IDs during streaming.
 */
export function stableHash(value: unknown): string {
  const str = stableStringify(value);
  return simpleHash(str);
}

/**
 * Creates a deterministic string representation of a value.
 * Objects have their keys sorted to ensure consistent output.
 */
function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys.map(
      (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`
    );
    return "{" + pairs.join(",") + "}";
  }
  return String(value);
}

/**
 * Simple hash function that produces a short hex string.
 * Based on djb2 algorithm - fast and good distribution.
 */
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Creates a function that generates stable IDs for items based on specified fields.
 * Useful in transforms to create deterministic IDs from content.
 */
export function createStableId<T extends Record<string, unknown>>(
  ...fields: (keyof T)[]
): (item: T) => string {
  return (item: T) => {
    if (fields.length === 0) {
      return stableHash(item);
    }
    const subset: Record<string, unknown> = {};
    for (const field of fields) {
      subset[field as string] = item[field];
    }
    return stableHash(subset);
  };
}

/**
 * Creates a function that generates stable IDs with a prefix.
 */
export function createPrefixedStableId<T extends Record<string, unknown>>(
  prefix: string,
  ...fields: (keyof T)[]
): (item: T) => string {
  const getId = createStableId<T>(...fields);
  return (item: T) => `${prefix}-${getId(item)}`;
}
