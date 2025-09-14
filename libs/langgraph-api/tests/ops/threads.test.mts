import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import type { AuthContext } from "../../src/auth/index.mjs";
import { randomUUID } from 'crypto';
import path from "path";
import { fileURLToPath } from "url";
import { truncate, Threads, Runs, Assistants } from "../../src/storage/ops.mjs"
import { PersistenceType, PersistenceTypes, persistence } from "../../src/storage/config.mjs";
import { stubPersistence } from "../utils.mjs"
import { checkpointer } from "../../src/storage/checkpoint.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper function to add a tiny delay to ensure different timestamps
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("Threads", async () => {
    beforeAll(async () => {
        // Initialize persistence with correct working directory
        await persistence.initialize(path.resolve(__dirname, "../graphs"));
        const { registerAuth } = await import("../../src/auth/index.mjs");
        const cwd = path.resolve(__dirname, "..");
        await registerAuth({ 
            path: "graphs/auth.mts:auth" 
        }, { cwd });
    })

    const authorizedUserContext: AuthContext = {
        user: {
            identity: "user123",
            permissions: ["threads:create_run", "threads:read", "threads:update", "threads:delete",
                          "assistants:create", "assistants:read", "assistants:search"],
            display_name: "John Doe",
            is_authenticated: true,
        },
        scopes: ["threads:write", "threads:read", "threads:create_run", "threads:update", "threads:delete", "threads:search",
                 "assistants:write", "assistants:create", "assistants:read", "assistants:search"],
    };

    const differentUserContext: AuthContext = {
        user: {
            identity: "user456",
            permissions: ["threads:write", "threads:read"],
            display_name: "Jane Smith",
            is_authenticated: true,
        },
        scopes: ["threads:write", "threads:read"],
    };

    PersistenceTypes.map(async (persistenceType) => {
        describe(`[${persistenceType}]`, async () => {
            beforeEach(async () => {
                stubPersistence(persistenceType as PersistenceType);
                await truncate({ threads: true, runs: true, assistants: true, full: false });
                await checkpointer.initialize(".");
            });

            describe("put", () => {
                it("basic", async () => {
                    const thread1Id = randomUUID();
                    
                    const thread = await Threads.put(thread1Id, {
                        metadata: { foo: "bar" },
                        if_exists: "raise",
                    }, undefined);
                    expect(thread).toHaveProperty("thread_id", thread1Id);

                    const reloaded = await Threads.get(thread1Id, undefined);
                    expect(reloaded).toHaveProperty("metadata", { foo: "bar" });

                    await expect(Threads.put(thread1Id, {
                        metadata: { foo: "bar" },
                        if_exists: "raise",
                    }, undefined)).rejects.toThrow("Thread already exists");

                });

                describe("authorization", () => {
                    it("allows creating thread with owner metadata", async () => {
                        const threadId = randomUUID();
                        
                        const thread = await Threads.put(threadId, {
                            metadata: { 
                                owner: "user123",
                                project: "testProject" 
                            },
                            if_exists: "raise",
                        }, authorizedUserContext);
                        
                        expect(thread).toHaveProperty("thread_id", threadId);
                        expect(thread.metadata).toEqual({
                            owner: "user123",
                            project: "testProject"
                        });
                    });

                    it("allows creating thread with tags metadata", async () => {
                        const threadId = randomUUID();
                        
                        const thread = await Threads.put(threadId, {
                            metadata: { 
                                owner: "user123",
                                tags: ["admin", "test"],
                                category: "development"
                            },
                            if_exists: "raise",
                        }, authorizedUserContext);
                        
                        expect(thread.metadata?.tags).toEqual(["admin", "test"]);
                    });
                });
            });

            describe("get", () => {
                it("simple", async () => {
                    const thread1Id = randomUUID();
                    const thread2Id = randomUUID();
                    
                    await Threads.put(thread1Id, {
                        metadata: { foo: "bar", owner: "user123" },
                        if_exists: "raise",
                    }, undefined);
                    await Threads.put(thread2Id, {
                        metadata: { foo: "baz", owner: "user123" },
                        if_exists: "raise",
                    }, undefined);
                    const fetched = await Threads.get(thread1Id, authorizedUserContext);
                    const fetched2 = await Threads.get(thread2Id, authorizedUserContext);
                    expect(fetched).toHaveProperty("thread_id", thread1Id);
                    expect(fetched).toHaveProperty("metadata", { foo: "bar", owner: "user123" });
                    expect(fetched2).toHaveProperty("metadata", { foo: "baz", owner: "user123" });
                });

                describe("authorization", () => {
                    it("allows user to get thread they own", async () => {
                        const threadId = randomUUID();
                        
                        // Create thread with ownership metadata
                        await Threads.put(threadId, {
                            metadata: { owner: "user123", project: "myProject" },
                            if_exists: "raise",
                        }, undefined);
                        
                        // User can access their own thread
                        const fetched = await Threads.get(threadId, authorizedUserContext);
                        expect(fetched).toHaveProperty("thread_id", threadId);
                        expect(fetched.metadata?.owner).toBe("user123");
                    });

                    it("prevents user from accessing thread they don't own", async () => {
                        const threadId = randomUUID();
                        
                        // Create thread owned by user123
                        await Threads.put(threadId, {
                            metadata: { owner: "user123", project: "secretProject" },
                            if_exists: "raise",
                        }, undefined);
                        
                        // Different user tries to access it
                        await expect(
                            Threads.get(threadId, differentUserContext)
                        ).rejects.toThrowError(`Thread with ID ${threadId} not found`);
                    });
                });
            });

            describe("patch", () => {
                it("allows user to patch their own thread", async () => {
                    const threadId = randomUUID();

                    await Threads.put(threadId, {
                        metadata: { foo: "bar", owner: "user123" },
                        if_exists: "raise",
                    }, undefined);
                    await Threads.patch(threadId, {
                        metadata: { foo: "baz" },
                    }, authorizedUserContext);
                    const fetched = await Threads.get(threadId, authorizedUserContext);
                    expect(fetched).toHaveProperty("thread_id", threadId);
                    expect(fetched).toHaveProperty("metadata", { foo: "baz", owner: "user123" });
                });

                describe("authorization", () => {
                    it("allows owner to patch their thread", async () => {
                        const threadId = randomUUID();
                        
                        await Threads.put(threadId, {
                            metadata: { owner: "user123", status: "draft" },
                            if_exists: "raise",
                        }, undefined);
                        
                        await Threads.patch(threadId, {
                            metadata: { owner: "user123", status: "published" },
                        }, authorizedUserContext);
                        
                        const fetched = await Threads.get(threadId, authorizedUserContext);
                        expect(fetched.metadata?.status).toBe("published");
                    });

                    it("prevents non-owner from patching thread", async () => {
                        const threadId = randomUUID();
                        
                        await Threads.put(threadId, {
                            metadata: { owner: "user123", status: "draft" },
                            if_exists: "raise",
                        }, undefined);
                        
                        await expect(
                            Threads.patch(threadId, {
                                metadata: { status: "hacked" },
                            }, differentUserContext)
                        ).rejects.toThrowError("Thread not found");
                    });
                });

                it("404s if thread doesn't exist", async () => {
                    const threadId = randomUUID();
                    await expect(
                        Threads.patch(threadId, {
                            metadata: { foo: "baz" },
                        }, authorizedUserContext),
                    ).rejects.toThrowError("Thread not found");
                });
            });

            describe("search", () => {
                it("returns all threads matching filters", async () => {
                    const thread1Id = randomUUID();
                    const thread2Id = randomUUID();
                    const thread3Id = randomUUID();

                    // Create threads with tiny delays to ensure different timestamps
                    await Threads.put(thread1Id, {
                        metadata: { foo: "bar", owner: "user123" },
                        if_exists: "raise",
                    }, undefined);
                    
                    await sleep(2); // 2ms delay, ensure in-memory test isn't too fast for sorting by created_at
                    
                    await Threads.put(thread2Id, {
                        metadata: { foo: "baz", owner: "user123" },
                        if_exists: "raise",
                    }, undefined);
                    
                    await sleep(2); // 2ms delay
                    
                    await Threads.put(thread3Id, {
                        metadata: { foo: "bar", owner: "user123" },
                        if_exists: "raise",
                    }, undefined);
                    
                    let fetched = [];
                    for await (const item of Threads.search({
                        metadata: { foo: "bar", owner: "user123" },
                        offset: 0,
                        limit: 10,
                    }, authorizedUserContext)) {
                        fetched.push(item);
                    }
                    expect(fetched).toHaveLength(2);
                    expect(fetched[0].thread).toHaveProperty("thread_id", thread3Id);
                    expect(fetched[1].thread).toHaveProperty("thread_id", thread1Id);
                });

                describe("authorization", () => {
                    it("returns only threads user owns", async () => {
                        const thread1Id = randomUUID();
                        const thread2Id = randomUUID();
                        const thread3Id = randomUUID();

                        // Create threads for different users
                        await Threads.put(thread1Id, {
                            metadata: { owner: "user123", project: "project1" },
                            if_exists: "raise",
                        }, undefined);
                        
                        await sleep(2);
                        
                        await Threads.put(thread2Id, {
                            metadata: { owner: "user456", project: "project2" },
                            if_exists: "raise",
                        }, undefined);
                        
                        await sleep(2);
                        
                        await Threads.put(thread3Id, {
                            metadata: { owner: "user123", project: "project3" },
                            if_exists: "raise",
                        }, undefined);
                        
                        let fetched = [];
                        for await (const item of Threads.search({
                            offset: 0,
                            limit: 10,
                        }, authorizedUserContext)) {
                            fetched.push(item);
                        }
                        
                        // Should only return threads owned by user123
                        expect(fetched).toHaveLength(2);
                        expect(fetched.every(item => item.thread.metadata?.owner === "user123")).toBe(true);
                    });

                    it("filters by tag containment", async () => {
                        const thread1Id = randomUUID();
                        const thread2Id = randomUUID();

                        await Threads.put(thread1Id, {
                            metadata: { 
                                owner: "user123",
                                tags: ["admin", "test"],
                                category: "development"
                            },
                            if_exists: "raise",
                        }, undefined);
                        
                        await sleep(2);
                        
                        await Threads.put(thread2Id, {
                            metadata: { 
                                owner: "user123",
                                tags: ["viewer", "production"],
                                category: "deployment"
                            },
                            if_exists: "raise",
                        }, undefined);
                        
                        let fetched = [];
                        for await (const item of Threads.search({
                            metadata: { category: "development" },
                            offset: 0,
                            limit: 10,
                        }, authorizedUserContext)) {
                            fetched.push(item);
                        }
                        
                        expect(fetched).toHaveLength(1);
                        expect(fetched[0]?.thread.metadata?.tags).toContain("admin");
                    });

                    it("returns empty results for unauthorized user", async () => {
                        const threadId = randomUUID();
                        
                        await Threads.put(threadId, {
                            metadata: { owner: "user123", secret: "data" },
                            if_exists: "raise",
                        }, undefined);
                        
                        let fetched = [];
                        for await (const item of Threads.search({
                            offset: 0,
                            limit: 10,
                        }, differentUserContext)) {
                            fetched.push(item);
                        }
                        
                        expect(fetched).toHaveLength(0);
                    });
                });
            });

            describe("setStatus", () => {
                it("when thread not found", async () => {
                    const thread1Id = randomUUID();
                    
                    await expect(
                        Threads.setStatus(thread1Id, {})
                    ).rejects.toThrow("Thread not found")
                });

                it("sets status to error", async () => {
                    const thread1Id = randomUUID();

                    await Threads.put(thread1Id, {
                        metadata: { foo: "bar" },
                        if_exists: "raise",
                    }, undefined);
                    
                    const thread = await Threads.setStatus(thread1Id, {
                        exception: {
                            name: "Major bug",
                            message: "There is a major bug",
                        }
                    });

                    expect(thread.status).toEqual("error");
                });

                it("sets status to interrupted", async () => {
                    const thread1Id = randomUUID();

                    await Threads.put(thread1Id, {
                        metadata: { foo: "bar" },
                        if_exists: "raise",
                    }, undefined);
                    
                    const thread = await Threads.setStatus(thread1Id, {
                        checkpoint: {
                            next: ["after feedback step"],
                            tasks: [{
                                id: "12345",
                                name: "checkpoint name",
                                interrupts: {
                                    "wait": "wait for feedback"
                                }
                            }],
                            metadata: {
                                source: "input",
                                step: 1,
                                writes: null,
                                parents: {}
                            },
                            values: {}
                        }
                    });

                    expect(thread.status).toEqual("interrupted");
                });

                it("sets status to busy when has pending runs", async () => {
                    const threadId = randomUUID();
                    const runId = randomUUID();
                    const assistantId = randomUUID();

                    // Create an assistant first (required for runs)
                    await Assistants.put(assistantId, {
                        config: {},
                        graph_id: "test_graph",
                        metadata: { owner: "user123" },
                        if_exists: "raise",
                        name: "Test Assistant"
                    }, authorizedUserContext);

                    // Create a thread
                    await Threads.put(threadId, {
                        metadata: { foo: "bar", owner: "user123" },
                        if_exists: "raise",
                    }, undefined);

                    // Create a pending run for the thread
                    await Runs.put(runId, assistantId, {}, {
                        threadId: threadId,
                        metadata: { owner: "user123" },
                        status: "pending"
                    }, authorizedUserContext);

                    // Call setStatus without any checkpoint or exception
                    const thread = await Threads.setStatus(threadId, {});

                    expect(thread.status).toEqual("busy");
                });

            });

            describe("delete", () => {
                it("404s when thread not found", async () => {
                    const thread1Id = randomUUID();
                    
                    await expect(
                        Threads.delete(thread1Id, authorizedUserContext)
                    ).rejects.toThrow(`Thread with ID ${thread1Id} not found`)
                });

                it("404s when thread not owned by user", async () => {
                    const thread1Id = randomUUID();

                    await Threads.put(thread1Id, {
                        metadata: { foo: "bar", owner: "user123" },
                        if_exists: "raise",
                    }, undefined);
                    
                    await expect(
                        Threads.delete(thread1Id, differentUserContext)
                    ).rejects.toThrow(`Thread with ID ${thread1Id} not found`)
                });

                it("deletes when thread owned by user", async () => {
                    const thread1Id = randomUUID();

                    await Threads.put(thread1Id, {
                        metadata: { foo: "bar", owner: "user123" },
                        if_exists: "raise",
                    }, undefined);
                    
                    const deletedThreadIds = await Threads.delete(thread1Id, authorizedUserContext)
                    const deletedThreadId = deletedThreadIds[0];

                    expect(deletedThreadId).toEqual(thread1Id);
                });

                it("deletes all associated runs when thread is deleted", async () => {
                    const threadId = randomUUID();
                    const runId1 = randomUUID();
                    const runId2 = randomUUID();
                    const assistantId = randomUUID();

                    // Create an assistant first (required for runs)
                    await Assistants.put(assistantId, {
                        config: {},
                        graph_id: "test_graph",
                        metadata: { owner: "user123" },
                        if_exists: "raise",
                        name: "Test Assistant"
                    }, authorizedUserContext);

                    // Create a thread
                    await Threads.put(threadId, {
                        metadata: { owner: "user123", graph_id: "test_graph" },
                        if_exists: "raise",
                    }, undefined);

                    // Create some runs associated with the thread
                    await Runs.put(runId1, assistantId, {}, {
                        threadId: threadId,
                        metadata: { owner: "user123" },
                        status: "pending"
                    }, authorizedUserContext);

                    await Runs.put(runId2, assistantId, {}, {
                        threadId: threadId,
                        metadata: { owner: "user123" },
                        status: "success"
                    }, authorizedUserContext);

                    // Verify runs exist before deletion
                    const runBefore1 = await Runs.get(runId1, threadId, authorizedUserContext);
                    const runBefore2 = await Runs.get(runId2, threadId, authorizedUserContext);
                    expect(runBefore1).not.toBeNull();
                    expect(runBefore2).not.toBeNull();

                    // Delete the thread
                    await Threads.delete(threadId, authorizedUserContext);

                    // Verify that the associated runs are also deleted
                    const runAfter1 = await Runs.get(runId1, threadId, authorizedUserContext);
                    const runAfter2 = await Runs.get(runId2, threadId, authorizedUserContext);
                    expect(runAfter1).toBeNull();
                    expect(runAfter2).toBeNull();
                });
            });

            describe("copy", () => {
                it("successfully copies a thread", async () => {
                    const originalThreadId = randomUUID();

                    // Create original thread
                    await Threads.put(originalThreadId, {
                        metadata: { 
                            owner: "user123", 
                            project: "myProject",
                            category: "development" 
                        },
                        if_exists: "raise",
                    }, undefined);

                    // Copy the thread
                    const copiedThread = await Threads.copy(originalThreadId, authorizedUserContext);

                    // Verify the copied thread
                    expect(copiedThread.thread_id).not.toBe(originalThreadId);
                    expect(copiedThread.thread_id).toBeDefined();
                    expect(copiedThread.status).toBe("idle");
                    expect(copiedThread.metadata).toBeDefined();
                    expect(copiedThread.metadata?.owner).toBe("user123");
                    expect(copiedThread.metadata?.project).toBe("myProject");
                    expect(copiedThread.metadata?.category).toBe("development");
                    expect(copiedThread.metadata?.thread_id).toBe(copiedThread.thread_id);
                    expect(copiedThread.created_at).toBeDefined();
                    expect(copiedThread.updated_at).toBeDefined();

                    // Verify original thread still exists and unchanged
                    const originalStillExists = await Threads.get(originalThreadId, authorizedUserContext);
                    expect(originalStillExists.thread_id).toBe(originalThreadId);
                    expect(originalStillExists.metadata).toBeDefined();
                    expect(originalStillExists.metadata?.owner).toBe("user123");
                });

                it("404s when original thread not found", async () => {
                    const nonExistentThreadId = randomUUID();
                    
                    await expect(
                        Threads.copy(nonExistentThreadId, authorizedUserContext)
                    ).rejects.toThrow("Thread not found");
                });

                it("404s when user cannot access original thread", async () => {
                    const originalThreadId = randomUUID();

                    // Create thread owned by user123
                    await Threads.put(originalThreadId, {
                        metadata: { 
                            owner: "user123", 
                            secret: "confidential" 
                        },
                        if_exists: "raise",
                    }, undefined);

                    // Different user tries to copy it
                    await expect(
                        Threads.copy(originalThreadId, differentUserContext)
                    ).rejects.toThrow("Thread not found");
                });

                it("allows authorized user to copy thread they can read", async () => {
                    const originalThreadId = randomUUID();

                    // Create thread
                    await Threads.put(originalThreadId, {
                        metadata: { 
                            owner: "user123", 
                            data: "some important data" 
                        },
                        if_exists: "raise",
                    }, undefined);

                    // Owner can copy their own thread
                    const copiedThread = await Threads.copy(originalThreadId, authorizedUserContext);
                    
                    expect(copiedThread.thread_id).not.toBe(originalThreadId);
                    expect(copiedThread.metadata).toBeDefined();
                    expect(copiedThread.metadata?.owner).toBe("user123");
                    expect(copiedThread.metadata?.data).toBe("some important data");
                    expect(copiedThread.status).toBe("idle");
                });

                it("creates independent copy that can be modified separately", async () => {
                    const originalThreadId = randomUUID();

                    // Create original thread
                    await Threads.put(originalThreadId, {
                        metadata: { 
                            owner: "user123", 
                            version: "1.0" 
                        },
                        if_exists: "raise",
                    }, undefined);

                    // Copy the thread
                    const copiedThread = await Threads.copy(originalThreadId, authorizedUserContext);
                    const copiedThreadId = copiedThread.thread_id;

                    // Modify the copied thread
                    await Threads.patch(copiedThreadId, {
                        metadata: { version: "2.0" }
                    }, authorizedUserContext);

                    // Verify original is unchanged
                    const originalAfterCopyModification = await Threads.get(originalThreadId, authorizedUserContext);
                    expect(originalAfterCopyModification.metadata).toBeDefined();
                    expect(originalAfterCopyModification.metadata?.version).toBe("1.0");

                    // Verify copy was modified
                    const copiedAfterModification = await Threads.get(copiedThreadId, authorizedUserContext);
                    expect(copiedAfterModification.metadata).toBeDefined();
                    expect(copiedAfterModification.metadata?.version).toBe("2.0");
                    expect(copiedAfterModification.metadata?.owner).toBe("user123"); // Other metadata preserved
                });
            })
        })
    })
});