import { describe, it, expect, beforeEach } from "vitest";
import { SharedChatRegistry } from "../registry.js";
import { MergeStrategies } from "../merge.js";

interface RawHeadline {
  id: string;
  text: string;
  status?: string;
}

interface Headline {
  id: string;
  text: string;
  locked: boolean;
  rejected: boolean;
}

interface RawDescription {
  id: string;
  text: string;
}

interface Description {
  id: string;
  text: string;
}

interface AdsState {
  headlines: Headline[];
  descriptions: Description[];
  count: number;
}

const toHeadline = (raw: RawHeadline): Headline => ({
  id: raw.id,
  text: raw.text,
  locked: false,
  rejected: raw.status === "rejected",
});

const toDescription = (raw: RawDescription): Description => ({
  id: raw.id,
  text: raw.text,
});

describe("Transform -> Merge Flow", () => {
  beforeEach(() => {
    SharedChatRegistry.clearAll();
  });

  describe("basic transforms", () => {
    it("transforms raw data before applying merge", () => {
      const registry = SharedChatRegistry.getOrCreate<AdsState>({
        apiUrl: "http://localhost:2024",
        transform: {
          headlines: (raw: RawHeadline[]) => raw.map(toHeadline),
        },
        merge: {
          headlines: MergeStrategies.appendUnique("id"),
        },
      });

      registry.loadFromHistory([], {
        headlines: [{ id: "h1", text: "Existing", locked: true, rejected: false }],
      });
      registry.resetForStream();

      registry.updateState("headlines", [
        { id: "h2", text: "New Headline", status: "pending" },
      ] as unknown as Headline[]);

      const state = registry.getState();
      expect(state.headlines).toHaveLength(2);
      expect(state.headlines?.[0]).toEqual({
        id: "h1",
        text: "Existing",
        locked: true,
        rejected: false,
      });
      expect(state.headlines?.[1]).toEqual({
        id: "h2",
        text: "New Headline",
        locked: false,
        rejected: false,
      });
    });

    it("applies transform then merge in correct order", () => {
      const registry = SharedChatRegistry.getOrCreate<AdsState>({
        apiUrl: "http://localhost:2024",
        transform: {
          headlines: (raw: RawHeadline[]) => raw.map(toHeadline),
        },
        merge: {
          headlines: MergeStrategies.appendUnique("id"),
        },
      });

      registry.loadFromHistory([], {
        headlines: [
          { id: "h1", text: "First", locked: false, rejected: false },
          { id: "h2", text: "Second", locked: false, rejected: false },
        ],
      });
      registry.resetForStream();

      registry.updateState("headlines", [
        { id: "h3", text: "Third", status: "pending" },
        { id: "h4", text: "Fourth", status: "rejected" },
      ] as unknown as Headline[]);

      const state = registry.getState();
      expect(state.headlines).toHaveLength(4);
      expect(state.headlines?.find((h) => h.id === "h4")?.rejected).toBe(true);
    });

    it("works without transform when only merge is provided", () => {
      const registry = SharedChatRegistry.getOrCreate<AdsState>({
        apiUrl: "http://localhost:2024",
        merge: {
          headlines: MergeStrategies.appendUnique("id"),
        },
      });

      registry.loadFromHistory([], {
        headlines: [{ id: "h1", text: "First", locked: false, rejected: false }],
      });
      registry.resetForStream();

      registry.updateState("headlines", [
        { id: "h2", text: "Second", locked: false, rejected: false },
      ]);

      const state = registry.getState();
      expect(state.headlines).toHaveLength(2);
    });

    it("works without merge when only transform is provided", () => {
      const registry = SharedChatRegistry.getOrCreate<AdsState>({
        apiUrl: "http://localhost:2024",
        transform: {
          headlines: (raw: RawHeadline[]) => raw.map(toHeadline),
        },
      });

      registry.loadFromHistory([], {
        headlines: [{ id: "h1", text: "First", locked: false, rejected: false }],
      });
      registry.resetForStream();

      registry.updateState("headlines", [
        { id: "h2", text: "Second", status: "rejected" },
      ] as unknown as Headline[]);

      const state = registry.getState();
      expect(state.headlines).toHaveLength(1);
      expect(state.headlines?.[0]).toEqual({
        id: "h2",
        text: "Second",
        locked: false,
        rejected: true,
      });
    });
  });

  describe("transform adds UUIDs", () => {
    it("transform can add unique IDs to incoming data", () => {
      let idCounter = 0;
      const registry = SharedChatRegistry.getOrCreate<AdsState>({
        apiUrl: "http://localhost:2024",
        transform: {
          headlines: (raw: Array<{ text: string }>) =>
            raw.map((r) => ({
              id: `generated-${(idCounter += 1)}`,
              text: r.text,
              locked: false,
              rejected: false,
            })),
        },
        merge: {
          headlines: MergeStrategies.append(),
        },
      });

      registry.loadFromHistory([], { headlines: [] });
      registry.resetForStream();

      registry.updateState("headlines", [
        { text: "First" },
        { text: "Second" },
      ] as unknown as Headline[]);

      const state = registry.getState();
      expect(state.headlines).toHaveLength(2);
      expect(state.headlines?.[0].id).toBe("generated-1");
      expect(state.headlines?.[1].id).toBe("generated-2");
    });

    it("append strategy accumulates transformed items across updates", () => {
      let idCounter = 0;
      const registry = SharedChatRegistry.getOrCreate<AdsState>({
        apiUrl: "http://localhost:2024",
        transform: {
          headlines: (raw: Array<{ text: string }>) =>
            raw.map((r) => ({
              id: `gen-${(idCounter += 1)}`,
              text: r.text,
              locked: false,
              rejected: false,
            })),
        },
        merge: {
          headlines: MergeStrategies.append(),
        },
      });

      registry.loadFromHistory([], {
        headlines: [{ id: "existing", text: "Existing", locked: false, rejected: false }],
      });
      registry.resetForStream();

      registry.updateState("headlines", [{ text: "New1" }] as unknown as Headline[]);

      const state = registry.getState();
      expect(state.headlines).toHaveLength(2);
      expect(state.headlines?.[0].id).toBe("existing");
      expect(state.headlines?.[1].id).toBe("gen-1");
    });
  });

  describe("multiple keys with transforms", () => {
    it("applies different transforms to different keys", () => {
      const registry = SharedChatRegistry.getOrCreate<AdsState>({
        apiUrl: "http://localhost:2024",
        transform: {
          headlines: (raw: RawHeadline[]) => raw.map(toHeadline),
          descriptions: (raw: RawDescription[]) => raw.map(toDescription),
        },
        merge: {
          headlines: MergeStrategies.appendUnique("id"),
          descriptions: MergeStrategies.replace(),
        },
      });

      registry.loadFromHistory([], {
        headlines: [],
        descriptions: [],
      });
      registry.resetForStream();

      registry.updateState("headlines", [
        { id: "h1", text: "Headline", status: "pending" },
      ] as unknown as Headline[]);

      registry.updateState("descriptions", [
        { id: "d1", text: "Description" },
      ] as unknown as Description[]);

      const state = registry.getState();
      expect(state.headlines?.[0]).toEqual({
        id: "h1",
        text: "Headline",
        locked: false,
        rejected: false,
      });
      expect(state.descriptions?.[0]).toEqual({
        id: "d1",
        text: "Description",
      });
    });
  });

  describe("transform with appendUnique prevents duplicate IDs", () => {
    it("incoming items with same ID replace existing after transform", () => {
      const registry = SharedChatRegistry.getOrCreate<AdsState>({
        apiUrl: "http://localhost:2024",
        transform: {
          headlines: (raw: RawHeadline[]) => raw.map(toHeadline),
        },
        merge: {
          headlines: MergeStrategies.appendUnique("id"),
        },
      });

      registry.loadFromHistory([], {
        headlines: [
          { id: "h1", text: "Original", locked: false, rejected: false },
        ],
      });
      registry.resetForStream();

      registry.updateState("headlines", [
        { id: "h1", text: "Updated", status: "pending" },
      ] as unknown as Headline[]);

      const state = registry.getState();
      expect(state.headlines).toHaveLength(1);
      expect(state.headlines?.[0].text).toBe("Updated");
    });
  });

  describe("transform preserves locked items via merge", () => {
    it("locked items from preStreamState are preserved via appendUnique", () => {
      const registry = SharedChatRegistry.getOrCreate<AdsState>({
        apiUrl: "http://localhost:2024",
        transform: {
          headlines: (raw: RawHeadline[]) => raw.map(toHeadline),
        },
        merge: {
          headlines: MergeStrategies.appendUnique("id"),
        },
      });

      registry.loadFromHistory([], {
        headlines: [
          { id: "h1", text: "Locked Item", locked: true, rejected: false },
          { id: "h2", text: "Unlocked Item", locked: false, rejected: false },
        ],
      });
      registry.resetForStream();

      registry.updateState("headlines", [
        { id: "h3", text: "New Item", status: "pending" },
      ] as unknown as Headline[]);

      const state = registry.getState();
      expect(state.headlines).toHaveLength(3);
      expect(state.headlines?.find((h) => h.id === "h1")?.locked).toBe(true);
    });

    it("custom merge can filter locked items", () => {
      const preserveLockedMerge = (
        incoming: Headline[],
        current: Headline[] | undefined
      ): Headline[] => {
        const locked = (current ?? []).filter((h) => h.locked);
        const incomingIds = new Set(incoming.map((h) => h.id));
        const nonConflictingLocked = locked.filter((h) => !incomingIds.has(h.id));
        return [...nonConflictingLocked, ...incoming];
      };

      const registry = SharedChatRegistry.getOrCreate<AdsState>({
        apiUrl: "http://localhost:2024",
        transform: {
          headlines: (raw: RawHeadline[]) => raw.map(toHeadline),
        },
        merge: {
          headlines: preserveLockedMerge,
        },
      });

      registry.loadFromHistory([], {
        headlines: [
          { id: "h1", text: "Locked", locked: true, rejected: false },
          { id: "h2", text: "Unlocked", locked: false, rejected: false },
        ],
      });
      registry.resetForStream();

      registry.updateState("headlines", [
        { id: "h3", text: "New", status: "pending" },
      ] as unknown as Headline[]);

      const state = registry.getState();
      expect(state.headlines).toHaveLength(2);
      expect(state.headlines?.map((h) => h.id)).toEqual(["h1", "h3"]);
    });
  });

  describe("streaming behavior with transforms", () => {
    it("each streaming update is transformed then merged with preStreamState", () => {
      const registry = SharedChatRegistry.getOrCreate<AdsState>({
        apiUrl: "http://localhost:2024",
        transform: {
          headlines: (raw: RawHeadline[]) => raw.map(toHeadline),
        },
        merge: {
          headlines: MergeStrategies.appendUnique("id"),
        },
      });

      registry.loadFromHistory([], {
        headlines: [{ id: "h1", text: "Existing", locked: false, rejected: false }],
      });
      registry.resetForStream();

      registry.updateState("headlines", [
        { id: "h2", text: "First Update" },
      ] as unknown as Headline[]);

      registry.updateState("headlines", [
        { id: "h2", text: "First Update" },
        { id: "h3", text: "Second Update" },
      ] as unknown as Headline[]);

      const state = registry.getState();
      expect(state.headlines).toHaveLength(3);
      expect(state.headlines?.map((h) => h.id)).toEqual(["h1", "h2", "h3"]);
    });
  });

  describe("non-array transforms", () => {
    it("transforms work with non-array values", () => {
      interface ConfigState {
        settings: { theme: string; fontSize: number };
        rawConfig: string;
      }

      const registry = SharedChatRegistry.getOrCreate<ConfigState>({
        apiUrl: "http://localhost:2024",
        transform: {
          settings: (raw: { t: string; fs: number }) => ({
            theme: raw.t,
            fontSize: raw.fs,
          }),
        },
      });

      registry.updateState("settings", { t: "dark", fs: 14 } as unknown as ConfigState["settings"]);

      const state = registry.getState();
      expect(state.settings).toEqual({ theme: "dark", fontSize: 14 });
    });
  });
});
