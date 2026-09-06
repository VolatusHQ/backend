/**
 * The loop harness every keeper/reporter/agent runs on, so none of them
 * write their own `setInterval` and get the shutdown or backoff behaviour
 * slightly wrong.
 *
 * - Jitter on the interval, so a fleet of services with the same interval
 *   does not end up hammering the same RPC in lockstep.
 * - `SIGINT`/`SIGTERM` let the in-flight tick finish before the process
 *   exits — a keeper mid-`sync()` should not be killed between simulate and
 *   send.
 * - Consecutive tick failures are counted and, past a threshold, escalated
 *   through the caller's `alert` function (`alerts.ts`'s `alert`, structurally
 *   — this module does not import `alerts.ts`, it just accepts a matching
 *   function, so there is no dependency in either direction).
 */

import { createLogger, type Logger } from "./logger.js";

export interface RunLoopOptions {
  name: string;
  intervalMs: number;
  tick: (signal: AbortSignal) => void | Promise<void>;
  /** Called after every failed tick, in addition to the built-in log + escalation. */
  onError?: (err: unknown, consecutiveFailures: number) => void | Promise<void>;
  /** Matches `alerts.ts`'s `AlertFn`. Called once consecutive failures reach `maxConsecutiveFailures`. */
  alert?: (level: "warn" | "error", msg: string, fields?: Record<string, unknown>) => void | Promise<void>;
  /** Escalate to `alert` at this many consecutive failures. Default `3`. */
  maxConsecutiveFailures?: number;
  /** +/- this many ms of random jitter per interval. Default `20%` of `intervalMs`. */
  jitterMs?: number;
  logger?: Logger;
}

export interface RunningLoop {
  /** Stop scheduling further ticks and resolve once the in-flight one (if any) finishes. */
  stop(): Promise<void>;
}

export function runLoop(opts: RunLoopOptions): RunningLoop {
  const logger = opts.logger ?? createLogger({ service: opts.name });
  const jitterMs = opts.jitterMs ?? Math.floor(opts.intervalMs * 0.2);
  const maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 3;

  let stopped = false;
  let consecutiveFailures = 0;
  let currentTick: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();

  function scheduleNext(): void {
    if (stopped) return;
    const spread = jitterMs > 0 ? Math.floor((Math.random() * 2 - 1) * jitterMs) : 0;
    const delay = Math.max(0, opts.intervalMs + spread);
    timer = setTimeout(() => void runOnce(), delay);

    // Deliberately NOT unref'd. A keeper or reporter is usually the only thing
    // its process is doing, so an unref'd timer lets Node decide the event loop
    // is empty and exit between ticks -- the service starts, logs that it
    // started, and dies before the first tick ever fires. `stop()` clears the
    // timer, so this does not hold a shutdown open.
  }

  async function runOnce(): Promise<void> {
    currentTick = (async () => {
      try {
        await opts.tick(controller.signal);
        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures += 1;
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`${opts.name}: tick failed`, { err: message, consecutiveFailures });

        if (opts.alert && consecutiveFailures >= maxConsecutiveFailures) {
          try {
            await opts.alert("error", `${opts.name}: ${consecutiveFailures} consecutive tick failures`, {
              lastError: message,
            });
          } catch (alertErr) {
            logger.error(`${opts.name}: alert delivery itself failed`, {
              err: alertErr instanceof Error ? alertErr.message : String(alertErr),
            });
          }
        }

        try {
          await opts.onError?.(err, consecutiveFailures);
        } catch (handlerErr) {
          logger.error(`${opts.name}: onError handler threw`, {
            err: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
          });
        }
      }
    })();
    await currentTick;
    currentTick = null;
    if (!stopped) scheduleNext();
  }

  function onSignal(signal: string): void {
    logger.info(`${opts.name}: received ${signal}, finishing in-flight tick before exit`);
    void stop();
  }
  const sigintHandler = () => onSignal("SIGINT");
  const sigtermHandler = () => onSignal("SIGTERM");
  process.once("SIGINT", sigintHandler);
  process.once("SIGTERM", sigtermHandler);

  async function stop(): Promise<void> {
    if (stopped) {
      if (currentTick) await currentTick;
      return;
    }
    stopped = true;
    if (timer) clearTimeout(timer);
    controller.abort();
    process.off("SIGINT", sigintHandler);
    process.off("SIGTERM", sigtermHandler);
    if (currentTick) await currentTick;
  }

  scheduleNext();
  return { stop };
}
