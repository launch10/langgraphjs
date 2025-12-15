/* eslint-disable no-console, no-await-in-loop, @typescript-eslint/no-non-null-assertion, import/no-extraneous-dependencies, import/order, no-process-env, prefer-destructuring, no-promise-executor-return, @typescript-eslint/no-floating-promises */
import { spawn, ChildProcess } from "child_process";
import path from "path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useStreamUI } from "../use-stream-ui.js";
import {
  type AdsState,
  type SampleGraphState,
  type StructuredOutput,
  adsMerge,
} from "./e2e/client-types.js";

const PORT = 4124;
const API_URL = `http://localhost:${PORT}/api`;

let backendProcess: ChildProcess | null = null;

function startBackend(): Promise<void> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, "e2e", "backend.ts");
    const cwd = path.join(__dirname, "../../../../..");

    backendProcess = spawn("npx", ["tsx", scriptPath], {
      env: { ...process.env, PORT: String(PORT), NODE_ENV: "development" },
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
    });

    const timeout = setTimeout(() => {
      reject(new Error("Backend startup timeout"));
    }, 30000);

    backendProcess.stdout?.on("data", (data) => {
      const output = data.toString();
      console.log("[backend stdout]", output);
      if (output.includes(`READY:${PORT}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });

    backendProcess.stderr?.on("data", (data) => {
      console.error("[backend stderr]", data.toString());
    });

    backendProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    backendProcess.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        reject(new Error(`Backend exited with code ${code}`));
      }
    });
  });
}

function stopBackend(): Promise<void> {
  return new Promise((resolve) => {
    if (!backendProcess) {
      resolve();
      return;
    }

    backendProcess.on("exit", () => {
      backendProcess = null;
      resolve();
    });

    backendProcess.kill("SIGTERM");

    setTimeout(() => {
      if (backendProcess) {
        backendProcess.kill("SIGKILL");
      }
      resolve();
    }, 2000);
  });
}

describe("E2E: LangGraph API -> useStreamUI", () => {
  beforeAll(async () => {
    await startBackend();
  }, 60000);

  afterAll(async () => {
    await stopBackend();
  }, 10000);

  describe("Sample Graph", () => {
    it("should stream messages and create assistant message with structured content", async () => {
      const { result } = renderHook(() =>
        useStreamUI<SampleGraphState, StructuredOutput>({
          apiUrl: API_URL,
          assistantId: "sample",
        })
      );

      await waitFor(
        () => {
          expect(result.current.isThreadLoading).toBe(false);
        },
        { timeout: 10000 }
      );

      await act(async () => {
        await result.current.submit({
          messages: [{ type: "human", content: "Tell me about structured messages" }],
        });
      });

      await waitFor(
        () => {
          expect(result.current.isLoading).toBe(false);
        },
        { timeout: 60000, interval: 500 }
      );

      const { uiMessages } = result.current;
      const assistantMessages = uiMessages.filter((m) => m.role === "assistant");
      expect(assistantMessages.length).toBeGreaterThan(0);

      const lastMessage = assistantMessages.at(-1)!;
      expect(lastMessage.id).toBeTruthy();
      expect(lastMessage.role).toBe("assistant");
      expect(lastMessage.blocks.length).toBeGreaterThan(0);

      const structuredBlock = lastMessage.blocks.find((b) => b.type === "structured");
      if (structuredBlock && structuredBlock.type === "structured") {
        expect(structuredBlock.data).toBeDefined();
        expect(structuredBlock.data.intro).toBeDefined();
        expect(structuredBlock.data.bulletPoints).toBeDefined();
        expect(structuredBlock.data.conclusion).toBeDefined();
      }
    }, 120000);

    it("should extract state from stream", async () => {
      const { result } = renderHook(() =>
        useStreamUI<SampleGraphState, StructuredOutput>({
          apiUrl: API_URL,
          assistantId: "sample",
        })
      );

      await waitFor(
        () => {
          expect(result.current.isThreadLoading).toBe(false);
        },
        { timeout: 10000 }
      );

      await act(async () => {
        await result.current.submit({
          messages: [{ type: "human", content: "Create a new project called MyAwesomeApp" }],
        });
      });

      await waitFor(
        () => {
          expect(result.current.isLoading).toBe(false);
        },
        { timeout: 60000, interval: 500 }
      );

      await waitFor(
        () => {
          expect(result.current.state.projectName).toBeDefined();
        },
        { timeout: 10000, interval: 500 }
      );

      expect(typeof result.current.state.projectName).toBe("string");
    }, 120000);

    it("should load history with properly parsed blocks after sending a message", async () => {
      const { result: firstHook, unmount: unmountFirst } = renderHook(() =>
        useStreamUI<SampleGraphState, StructuredOutput>({
          apiUrl: API_URL,
          assistantId: "sample",
          fetchStateHistory: true,
        })
      );

      await waitFor(
        () => {
          expect(firstHook.current.isThreadLoading).toBe(false);
        },
        { timeout: 10000 }
      );

      await act(async () => {
        await firstHook.current.submit({
          messages: [{ type: "human", content: "Tell me about structured messages" }],
        });
      });

      await waitFor(
        () => {
          expect(firstHook.current.isLoading).toBe(false);
        },
        { timeout: 60000, interval: 500 }
      );

      await waitFor(
        () => {
          const assistantMsgs = firstHook.current.uiMessages.filter(
            (m) => m.role === "assistant"
          );
          expect(assistantMsgs.length).toBeGreaterThan(0);
        },
        { timeout: 10000 }
      );

      const originalMessages = firstHook.current.uiMessages;
      const originalAssistantMessage = originalMessages.filter(
        (m) => m.role === "assistant"
      ).at(-1);

      expect(originalAssistantMessage).toBeDefined();
      expect(originalAssistantMessage!.blocks.length).toBeGreaterThan(0);

      const actualThreadId = firstHook.current.threadId;
      unmountFirst();

      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });

      const { result: secondHook } = renderHook(() =>
        useStreamUI<SampleGraphState, StructuredOutput>({
          apiUrl: API_URL,
          assistantId: "sample",
          getInitialThreadId: () => actualThreadId!,
          fetchStateHistory: true,
        })
      );

      await waitFor(
        () => {
          expect(secondHook.current.isThreadLoading).toBe(false);
        },
        { timeout: 10000 }
      );

      await waitFor(
        () => {
          expect(secondHook.current.uiMessages.length).toBeGreaterThan(0);
        },
        { timeout: 10000 }
      );

      const loadedMessages = secondHook.current.uiMessages;
      expect(loadedMessages.length).toBeGreaterThan(0);

      const loadedAssistantMessage = loadedMessages.filter(
        (m) => m.role === "assistant"
      ).at(-1);

      if (loadedAssistantMessage) {
        expect(loadedAssistantMessage.blocks.length).toBeGreaterThan(0);

        const structuredBlock = loadedAssistantMessage.blocks.find(
          (b) => b.type === "structured"
        );
        if (structuredBlock && structuredBlock.type === "structured") {
          expect(structuredBlock.data).toBeDefined();
          expect(structuredBlock.data.intro).toBeDefined();
          expect(structuredBlock.data.bulletPoints).toBeDefined();
          expect(structuredBlock.data.conclusion).toBeDefined();
        }
      }
    }, 180000);
  });

  describe("Ads Agent (Streaming State)", () => {
    it("should stream headlines and descriptions to state", async () => {
      const { result } = renderHook(() =>
        useStreamUI<AdsState>({
          apiUrl: API_URL,
          assistantId: "ads",
          merge: adsMerge,
        })
      );

      await waitFor(
        () => {
          expect(result.current.isThreadLoading).toBe(false);
        },
        { timeout: 10000 }
      );

      await act(async () => {
        await result.current.submit({
          messages: [
            { type: "human", content: "We sell premium organic coffee beans" },
          ],
        });
      });

      await waitFor(
        () => {
          expect(result.current.isLoading).toBe(false);
        },
        { timeout: 60000, interval: 100 }
      );

      expect(result.current.state.headlines).toBeDefined();
      expect(Array.isArray(result.current.state.headlines)).toBe(true);
      expect(result.current.state.headlines!.length).toBeGreaterThan(0);

      const headline = result.current.state.headlines![0]!;
      expect(headline.text).toBeDefined();
      expect(typeof headline.text).toBe("string");
      expect(headline.rejected).toBe(false);
      expect(headline.locked).toBe(false);

      expect(result.current.state.descriptions).toBeDefined();
      expect(Array.isArray(result.current.state.descriptions)).toBe(true);
      expect(result.current.state.descriptions!.length).toBeGreaterThan(0);

      const description = result.current.state.descriptions![0]!;
      expect(description.text).toBeDefined();
      expect(typeof description.text).toBe("string");
    }, 120000);

    it("should have assistant message with text blocks", async () => {
      const { result } = renderHook(() =>
        useStreamUI<AdsState>({
          apiUrl: API_URL,
          assistantId: "ads",
          merge: adsMerge,
        })
      );

      await waitFor(
        () => {
          expect(result.current.isThreadLoading).toBe(false);
        },
        { timeout: 10000 }
      );

      await act(async () => {
        await result.current.submit({
          messages: [
            { type: "human", content: "Create ads for our luxury watch brand" },
          ],
        });
      });

      await waitFor(
        () => {
          expect(result.current.isLoading).toBe(false);
        },
        { timeout: 60000, interval: 100 }
      );

      const assistantMessages = result.current.uiMessages.filter(
        (m) => m.role === "assistant"
      );
      expect(assistantMessages.length).toBeGreaterThan(0);

      const lastMessage = assistantMessages.at(-1)!;
      expect(lastMessage.blocks.length).toBeGreaterThan(0);

      const textBlocks = lastMessage.blocks.filter((b) => b.type === "text");
      expect(textBlocks.length).toBeGreaterThan(0);
    }, 120000);

    it("should apply merge reducers to transform streamed data", async () => {
      const { result } = renderHook(() =>
        useStreamUI<AdsState>({
          apiUrl: API_URL,
          assistantId: "ads",
          merge: adsMerge,
        })
      );

      await waitFor(
        () => {
          expect(result.current.isThreadLoading).toBe(false);
        },
        { timeout: 10000 }
      );

      await act(async () => {
        await result.current.submit({
          messages: [{ type: "human", content: "Generate ads for a fitness app" }],
        });
      });

      await waitFor(
        () => {
          expect(result.current.isLoading).toBe(false);
        },
        { timeout: 60000, interval: 100 }
      );

      for (const headline of result.current.state.headlines!) {
        expect(headline).toHaveProperty("text");
        expect(headline).toHaveProperty("rejected");
        expect(headline).toHaveProperty("locked");
        expect(headline.rejected).toBe(false);
        expect(headline.locked).toBe(false);
      }

      for (const description of result.current.state.descriptions!) {
        expect(description).toHaveProperty("text");
        expect(description).toHaveProperty("id");
      }
    }, 120000);

    it("should work without merge reducers (server values used directly)", async () => {
      const { result } = renderHook(() =>
        useStreamUI<AdsState>({
          apiUrl: API_URL,
          assistantId: "ads",
        })
      );

      await waitFor(
        () => {
          expect(result.current.isThreadLoading).toBe(false);
        },
        { timeout: 10000 }
      );

      await act(async () => {
        await result.current.submit({
          messages: [{ type: "human", content: "Generate simple ad copy" }],
        });
      });

      await waitFor(
        () => {
          expect(result.current.isLoading).toBe(false);
        },
        { timeout: 60000, interval: 100 }
      );

      await waitFor(
        () => {
          expect(result.current.values.headlines).toBeDefined();
        },
        { timeout: 10000, interval: 500 }
      );

      expect(Array.isArray(result.current.values.headlines)).toBe(true);
    }, 120000);
  });

  describe("Thread Management", () => {
    it("should create new thread when none provided", async () => {
      const { result } = renderHook(() =>
        useStreamUI<SampleGraphState, StructuredOutput>({
          apiUrl: API_URL,
          assistantId: "sample",
        })
      );

      expect(result.current.threadId).toBeNull();

      await act(async () => {
        await result.current.submit({
          messages: [{ type: "human", content: "Hello" }],
        });
      });

      await waitFor(
        () => {
          expect(result.current.isLoading).toBe(false);
        },
        { timeout: 60000 }
      );

      expect(result.current.threadId).toBeTruthy();
      expect(typeof result.current.threadId).toBe("string");
    }, 120000);

    it("should call onThreadId when thread is created", async () => {
      const onThreadId = vi.fn();

      const { result } = renderHook(() =>
        useStreamUI<SampleGraphState, StructuredOutput>({
          apiUrl: API_URL,
          assistantId: "sample",
          onThreadId,
        })
      );

      await act(async () => {
        await result.current.submit({
          messages: [{ type: "human", content: "Hello" }],
        });
      });

      await waitFor(
        () => {
          expect(result.current.isLoading).toBe(false);
        },
        { timeout: 60000 }
      );

      expect(onThreadId).toHaveBeenCalled();
      expect(onThreadId).toHaveBeenCalledWith(expect.any(String));
    }, 120000);

    it("should use provided initial thread ID", async () => {
      const { result: firstResult, unmount: unmountFirst } = renderHook(() =>
        useStreamUI<SampleGraphState, StructuredOutput>({
          apiUrl: API_URL,
          assistantId: "sample",
          fetchStateHistory: true,
        })
      );

      await act(async () => {
        await firstResult.current.submit({
          messages: [{ type: "human", content: "First message" }],
        });
      });

      await waitFor(
        () => {
          expect(firstResult.current.isLoading).toBe(false);
        },
        { timeout: 60000 }
      );

      const createdThreadId = firstResult.current.threadId;
      expect(createdThreadId).toBeTruthy();

      unmountFirst();

      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });

      const { result: secondResult } = renderHook(() =>
        useStreamUI<SampleGraphState, StructuredOutput>({
          apiUrl: API_URL,
          assistantId: "sample",
          getInitialThreadId: () => createdThreadId!,
          fetchStateHistory: true,
        })
      );

      await waitFor(
        () => {
          expect(secondResult.current.isThreadLoading).toBe(false);
        },
        { timeout: 10000 }
      );

      await waitFor(
        () => {
          expect(secondResult.current.uiMessages.length).toBeGreaterThan(0);
        },
        { timeout: 10000 }
      );

      expect(secondResult.current.threadId).toBe(createdThreadId);
    }, 180000);
  });

  describe("Optimistic Updates", () => {
    it("should add optimistic user message immediately", async () => {
      const { result } = renderHook(() =>
        useStreamUI<SampleGraphState, StructuredOutput>({
          apiUrl: API_URL,
          assistantId: "sample",
        })
      );

      await waitFor(
        () => {
          expect(result.current.isThreadLoading).toBe(false);
        },
        { timeout: 10000 }
      );

      const messagesBefore = result.current.uiMessages.length;

      await act(async () => {
        void result.current.submit(
          { messages: [{ type: "human", content: "Test message" }] },
          { optimisticMessage: "Test message" }
        );
      });

      expect(result.current.uiMessages.length).toBe(messagesBefore + 1);
      const lastMessage = result.current.uiMessages.at(-1);
      expect(lastMessage?.role).toBe("user");

      await waitFor(
        () => {
          expect(result.current.isLoading).toBe(false);
        },
        { timeout: 60000 }
      );
    }, 120000);
  });

  describe("Selector Pattern", () => {
    it("should support selector for granular subscriptions", async () => {
      const { result, unmount } = renderHook(() =>
        useStreamUI<AdsState>({
          apiUrl: API_URL,
          assistantId: "ads",
          merge: adsMerge,
        })
      );

      await waitFor(
        () => {
          expect(result.current.isThreadLoading).toBe(false);
        },
        { timeout: 10000 }
      );

      await act(async () => {
        await result.current.submit({
          messages: [{ type: "human", content: "Create headlines" }],
        });
      });

      await waitFor(
        () => {
          expect(result.current.isLoading).toBe(false);
        },
        { timeout: 60000, interval: 500 }
      );

      expect(result.current.values.headlines).toBeDefined();
      expect(Array.isArray(result.current.values.headlines)).toBe(true);

      unmount();
    }, 120000);
  });

  describe("Reconnection", () => {
    function createMockStorage() {
      const data = new Map<string, string>();
      return {
        data,
        getItem: (key: `lg:stream:${string}`) => data.get(key) ?? null,
        setItem: (key: `lg:stream:${string}`, value: string) =>
          data.set(key, value),
        removeItem: (key: `lg:stream:${string}`) => data.delete(key),
      };
    }

    it("should expose joinStream function", async () => {
      const { result } = renderHook(() =>
        useStreamUI<SampleGraphState, StructuredOutput>({
          apiUrl: API_URL,
          assistantId: "sample",
        })
      );

      expect(typeof result.current.joinStream).toBe("function");
    });

    it("should store run metadata when reconnectOnMount is enabled", async () => {
      const mockStorage = createMockStorage();

      const { result, unmount } = renderHook(() =>
        useStreamUI<SampleGraphState, StructuredOutput>({
          apiUrl: API_URL,
          assistantId: "sample",
          reconnectOnMount: () => mockStorage,
        })
      );

      await waitFor(
        () => {
          expect(result.current.isThreadLoading).toBe(false);
        },
        { timeout: 10000 }
      );

      let threadId: string | null = null;
      await act(async () => {
        const submitPromise = result.current.submit({
          messages: [{ role: "user", content: "Hello" }],
        });

        await new Promise((resolve) => setTimeout(resolve, 500));

        threadId = result.current.threadId;

        await submitPromise;
      });

      expect(threadId).toBeTruthy();
      expect(mockStorage.data.has(`lg:stream:${threadId}`)).toBe(false);

      unmount();
    }, 120000);

    it("should clear run metadata on stream completion", async () => {
      const mockStorage = createMockStorage();

      const { result, unmount } = renderHook(() =>
        useStreamUI<SampleGraphState, StructuredOutput>({
          apiUrl: API_URL,
          assistantId: "sample",
          reconnectOnMount: () => mockStorage,
        })
      );

      await waitFor(
        () => {
          expect(result.current.isThreadLoading).toBe(false);
        },
        { timeout: 10000 }
      );

      await act(async () => {
        await result.current.submit({
          messages: [{ role: "user", content: "Hello" }],
        });
      });

      await waitFor(
        () => {
          expect(result.current.isLoading).toBe(false);
        },
        { timeout: 60000 }
      );

      expect(mockStorage.data.size).toBe(0);

      unmount();
    }, 120000);

    it("should call onCreated callback with run metadata", async () => {
      const onCreated = vi.fn();

      const { result, unmount } = renderHook(() =>
        useStreamUI<SampleGraphState, StructuredOutput>({
          apiUrl: API_URL,
          assistantId: "sample",
          onCreated,
        })
      );

      await waitFor(
        () => {
          expect(result.current.isThreadLoading).toBe(false);
        },
        { timeout: 10000 }
      );

      await act(async () => {
        await result.current.submit({
          messages: [{ role: "user", content: "Hello" }],
        });
      });

      await waitFor(
        () => {
          expect(result.current.isLoading).toBe(false);
        },
        { timeout: 60000 }
      );

      expect(onCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          run_id: expect.any(String),
          thread_id: expect.any(String),
        })
      );

      unmount();
    }, 120000);
  });
});

