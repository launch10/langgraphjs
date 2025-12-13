import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as schemas from "../schemas.mjs";
import { HTTPException } from "hono/http-exception";
import { store as storageStore } from "../storage/store.mjs";
import type { Item, BaseStore } from "@langchain/langgraph";
import { handleAuthEvent } from "../auth/index.mjs";
import type { StorageEnv } from "../storage/types.mjs";

const api = new Hono<StorageEnv>();

const getStore = async (c: { var: { LANGGRAPH_OPS: StorageEnv["Variables"]["LANGGRAPH_OPS"] } }): Promise<BaseStore> => {
  const ops = c.var.LANGGRAPH_OPS;
  if (ops.getStore) {
    return ops.getStore();
  }
  return storageStore;
};

const validateNamespace = (namespace: string[]) => {
  if (!namespace || namespace.length === 0) {
    throw new HTTPException(400, { message: "Namespace is required" });
  }

  for (const label of namespace) {
    if (!label || label.includes(".")) {
      throw new HTTPException(422, {
        message:
          "Namespace labels cannot be empty or contain periods. Received: " +
          namespace.join("."),
      });
    }
  }
};

const mapItemsToApi = (item: Item | null) => {
  if (item == null) return null;

  const clonedItem: Record<string, unknown> = { ...item };
  delete clonedItem.createdAt;
  delete clonedItem.updatedAt;

  clonedItem.created_at = item.createdAt;
  clonedItem.updated_at = item.updatedAt;

  return clonedItem;
};

api.post(
  "/store/namespaces",
  zValidator("json", schemas.StoreListNamespaces),
  async (c) => {
    // List Namespaces
    const payload = c.req.valid("json");
    if (payload.prefix) validateNamespace(payload.prefix);
    if (payload.suffix) validateNamespace(payload.suffix);

    await handleAuthEvent(c.var.auth, "store:list_namespaces", {
      namespace: payload.prefix,
      suffix: payload.suffix,
      max_depth: payload.max_depth,
      limit: payload.limit,
      offset: payload.offset,
    });

    const store = await getStore(c);
    return c.json({
      namespaces: await store.listNamespaces({
        limit: payload.limit ?? 100,
        offset: payload.offset ?? 0,
        prefix: payload.prefix,
        suffix: payload.suffix,
        maxDepth: payload.max_depth,
      }),
    });
  }
);

api.post(
  "/store/items/search",
  zValidator("json", schemas.StoreSearchItems),
  async (c) => {
    // Search Items
    const payload = c.req.valid("json");
    if (payload.namespace_prefix) validateNamespace(payload.namespace_prefix);

    await handleAuthEvent(c.var.auth, "store:search", {
      namespace: payload.namespace_prefix,
      filter: payload.filter,
      limit: payload.limit,
      offset: payload.offset,
      query: payload.query,
    });

    const store = await getStore(c);
    const items = await store.search(payload.namespace_prefix, {
      filter: payload.filter,
      limit: payload.limit ?? 10,
      offset: payload.offset ?? 0,
      query: payload.query,
    });

    return c.json({ items: items.map(mapItemsToApi) });
  }
);

api.put("/store/items", zValidator("json", schemas.StorePutItem), async (c) => {
  // Put Item
  const payload = c.req.valid("json");
  if (payload.namespace) validateNamespace(payload.namespace);

  await handleAuthEvent(c.var.auth, "store:put", {
    namespace: payload.namespace,
    key: payload.key,
    value: payload.value,
  });
  const store = await getStore(c);
  await store.put(payload.namespace, payload.key, payload.value);
  return c.body(null, 204);
});

api.delete(
  "/store/items",
  zValidator("json", schemas.StoreDeleteItem),
  async (c) => {
    // Delete Item
    const payload = c.req.valid("json");
    if (payload.namespace) validateNamespace(payload.namespace);

    await handleAuthEvent(c.var.auth, "store:delete", {
      namespace: payload.namespace,
      key: payload.key,
    });
    const store = await getStore(c);
    await store.delete(payload.namespace ?? [], payload.key);
    return c.body(null, 204);
  }
);

api.get(
  "/store/items",
  zValidator("query", schemas.StoreGetItem),
  async (c) => {
    // Get Item
    const payload = c.req.valid("query");

    await handleAuthEvent(c.var.auth, "store:get", {
      namespace: payload.namespace,
      key: payload.key,
    });

    const key = payload.key;
    const namespace = payload.namespace;
    const store = await getStore(c);
    return c.json(mapItemsToApi(await store.get(namespace, key)));
  }
);

export default api;
