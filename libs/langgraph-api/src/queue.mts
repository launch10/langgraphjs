import type { Ops, Run, RunStatus, RunNotifier } from "./storage/types.mjs";
import {
  type StreamCheckpoint,
  type StreamTaskResult,
  streamState,
} from "./stream.mjs";
import { logError, logger } from "./logging.mjs";
import { serializeError } from "./utils/serde.mjs";
import { callWebhook } from "./webhook.mjs";
import { runWithParsingContext } from "./utils/parsing-context.mjs";

const MAX_RETRY_ATTEMPTS = 3;
const NOTIFICATION_TIMEOUT_MS = 5000;
const FALLBACK_POLL_INTERVAL_MS = 10000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const queue = async (ops: Ops) => {
  let notifier: RunNotifier | null = null;
  let notificationChannel: string | null = null;

  if (ops.getNotifier && ops.getNotificationChannel) {
    try {
      notifier = await ops.getNotifier();
      notificationChannel = ops.getNotificationChannel();
      logger.info("Queue using LISTEN/NOTIFY for run notifications", {
        channel: notificationChannel,
      });
    } catch (err) {
      logger.warn("Failed to initialize notifier, falling back to polling", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Defaults are set globally by server.mts via setDefaults()
  // The getGraph function will use those defaults unless explicitly overridden

  while (true) {
    let processedAny = false;

    for await (const { run, attempt, signal } of ops.runs.next()) {
      processedAny = true;
      await worker(ops, run, attempt, signal);
    }

    if (processedAny) {
      continue;
    }

    if (notifier && notificationChannel && notifier.isConnected()) {
      try {
        await notifier.waitForNotification(
          notificationChannel,
          NOTIFICATION_TIMEOUT_MS
        );
      } catch {
        // Timeout or error - continue to check for runs
      }
    } else {
      await sleep(FALLBACK_POLL_INTERVAL_MS * Math.random());
    }
  }
};

const worker = async (
  ops: Ops,
  run: Run,
  attempt: number,
  signal: AbortSignal
) => {
  const startedAt = new Date();
  let endedAt: Date | undefined = undefined;
  let checkpoint: StreamCheckpoint | undefined = undefined;
  let exception: Error | undefined = undefined;
  let status: RunStatus | undefined = undefined;

  const temporary = run.kwargs.temporary;
  const webhook = run.kwargs.webhook as string | undefined;

  logger.info("Starting background run", {
    run_id: run.run_id,
    run_attempt: attempt,
    run_created_at: run.created_at,
    run_started_at: startedAt,
    run_queue_ms: startedAt.valueOf() - run.created_at.valueOf(),
  });

  const onCheckpoint = (value: StreamCheckpoint) => {
    checkpoint = value;
  };

  const onTaskResult = (result: StreamTaskResult) => {
    if (checkpoint == null) return;
    const index = checkpoint.tasks.findIndex((task) => task.id === result.id);
    checkpoint.tasks[index] = {
      ...checkpoint.tasks[index],
      ...result,
    };
  };

  try {
    if (attempt > MAX_RETRY_ATTEMPTS) {
      throw new Error(`Run ${run.run_id} exceeded max attempts`);
    }

    const runId = run.run_id;
    const resumable = run.kwargs?.resumable ?? false;

    try {
      await runWithParsingContext(async () => {
        const stream = streamState(run, {
          attempt,
          signal,
          ...(!temporary ? { onCheckpoint, onTaskResult } : undefined),
        });

        for await (const { event, data } of stream) {
          await ops.runs.stream.publish({ runId, resumable, event, data });
        }
      });
    } catch (error) {
      await ops.runs.stream.publish({
        runId,
        resumable,
        event: "error",
        data: serializeError(error),
      });
      throw error;
    }

    endedAt = new Date();
    logger.info("Background run succeeded", {
      run_id: run.run_id,
      run_attempt: attempt,
      run_created_at: run.created_at,
      run_started_at: startedAt,
      run_ended_at: endedAt,
      run_exec_ms: endedAt.valueOf() - startedAt.valueOf(),
    });

    status = "success";
    await ops.runs.setStatus(run.run_id, status);
  } catch (error) {
    endedAt = new Date();
    if (error instanceof Error) exception = error;

    const isAbort =
      signal.aborted || (error instanceof Error && error.name === "AbortError");
    const abortReason = signal.reason as string | undefined;

    if (isAbort && abortReason === "interrupt") {
      logger.info("Background run interrupted", {
        run_id: run.run_id,
        run_attempt: attempt,
        reason: abortReason,
      });
      status = "interrupted";
      await ops.runs.setStatus(run.run_id, "interrupted");
    } else if (isAbort && abortReason === "rollback") {
      logger.info("Background run rolled back (deleting)", {
        run_id: run.run_id,
        run_attempt: attempt,
      });
      status = "error";
      await ops.runs.delete(run.run_id, run.thread_id, undefined);
    } else {
      logError(error, {
        prefix: "Background run failed",
        context: {
          run_id: run.run_id,
          run_attempt: attempt,
          run_created_at: run.created_at,
          run_started_at: startedAt,
          run_ended_at: endedAt,
          run_exec_ms: endedAt.valueOf() - startedAt.valueOf(),
        },
      });

      status = "error";
      await ops.runs.setStatus(run.run_id, "error");
    }
  } finally {
    if (temporary) {
      await ops.threads.delete(run.thread_id, undefined);
    } else {
      await ops.threads.setStatus(run.thread_id, { checkpoint, exception });
    }

    if (webhook) {
      await callWebhook({
        checkpoint,
        status,
        exception,
        run,
        webhook,
        run_started_at: startedAt,
        run_ended_at: endedAt,
      });
    }
  }
};
