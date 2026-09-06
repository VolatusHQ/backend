/**
 * Alerting: always logged, optionally pushed to a webhook.
 *
 * `deadlineAlarm` exists for exactly one reason, stated in `BACKEND_HANDOFF.md`:
 * "`reportDeadline` is a real operational deadline and missing it costs a
 * payout." It has to fire *before* the deadline, with enough margin for a
 * human or a retry to act — firing on or after the deadline is a post-mortem,
 * not an alarm.
 */

import { createLogger, sanitizeForLog, type Logger } from "./logger.js";

export type AlertLevel = "warn" | "error";

export type AlertFn = (level: AlertLevel, msg: string, fields?: Record<string, unknown>) => Promise<void>;

export interface AlerterOptions {
  service: string;
  /** Posted to when set. Left unset, `alert()` still logs — it just has no other channel. */
  webhookUrl?: string;
  logger?: Logger;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface Alerter {
  alert: AlertFn;
}

export function makeAlerter(opts: AlerterOptions): Alerter {
  const logger = opts.logger ?? createLogger({ service: opts.service });
  const fetchImpl = opts.fetchImpl ?? fetch;

  const alert: AlertFn = async (level, msg, fields) => {
    logger[level](msg, fields);
    if (!opts.webhookUrl) return;

    const body = JSON.stringify(
      sanitizeForLog({
        service: opts.service,
        level,
        msg,
        fields: fields ?? {},
        ts: new Date().toISOString(),
      }),
    );

    try {
      const response = await fetchImpl(opts.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!response.ok) {
        logger.error("alert webhook returned a non-2xx status", {
          status: response.status,
          webhookUrl: opts.webhookUrl,
        });
      }
    } catch (err) {
      logger.error("alert webhook delivery failed", {
        err: err instanceof Error ? err.message : String(err),
        webhookUrl: opts.webhookUrl,
      });
    }
  };

  return { alert };
}

export interface DeadlineAlarmOptions {
  /** What is late — used in the alert message, e.g. `"reportPayoff(2)"`. */
  name: string;
  /** Unix seconds. */
  deadline: number;
  /** Seconds of margin before `deadline` at which the alarm starts firing. */
  margin: number;
  /** Whether the guarded work has already landed. Checked fresh on every call. */
  isDone: () => boolean | Promise<boolean>;
  alert: AlertFn;
  /** Injectable for tests. Unix seconds. Defaults to the real clock. */
  now?: () => number;
}

/**
 * Check once whether the deadline alarm should fire, and fire it if so.
 * Meant to be called on every tick of a monitoring loop (`runner.ts`), not
 * scheduled itself — it is a stateless check, so over-calling is harmless
 * and under-calling just delays the warning.
 *
 * Fires (returns `true`) when `now > deadline - margin` and `isDone()` is
 * false — i.e. starting *before* the deadline, escalating from `warn` to
 * `error` once the deadline itself has passed. Returns `false` and does
 * nothing otherwise, including whenever `isDone()` is true.
 */
export async function deadlineAlarm(opts: DeadlineAlarmOptions): Promise<boolean> {
  const now = (opts.now ?? (() => Math.floor(Date.now() / 1000)))();
  const armAt = opts.deadline - opts.margin;
  if (now <= armAt) return false;

  if (await opts.isDone()) return false;

  const remaining = opts.deadline - now;
  const level: AlertLevel = remaining > 0 ? "warn" : "error";
  const msg =
    remaining > 0
      ? `${opts.name}: deadline in ${remaining}s and not done`
      : `${opts.name}: deadline passed ${-remaining}s ago and still not done`;

  await opts.alert(level, msg, {
    name: opts.name,
    deadline: opts.deadline,
    now,
    remainingSeconds: remaining,
  });
  return true;
}
