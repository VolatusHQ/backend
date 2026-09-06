/**
 * Whether a real `sync` transaction is worth sending right now.
 *
 * This is the part of Service 2 that is deliberately *not*
 * `BACKEND_HANDOFF.md`'s literal "every 30–60s, call sync for each active
 * subscription." BRIEF.md measured a real `sync` at 68,887 gas / 0.00172218
 * USDC on Arc, where gas *is* USDC. At the seeded demo rate
 * (ratePerSecond 100 = 0.0001 USDC/s) a 30s tick accrues 0.003 USDC while
 * burning 0.0017 to collect it — 57% overhead; at 60s it's 29%. `_sync` is a
 * no-op when nothing has elapsed, so calling it too often is harmless to
 * *correctness* — it is not harmless to the keeper wallet's runway.
 *
 * A sync is due when any of:
 *
 *   - `economic`: the accrued premium is worth at least `safetyFactor` times
 *     the estimated gas cost of collecting it. This is the normal case.
 *   - `max-interval`: a backstop so a subscription is never left un-synced
 *     indefinitely just because it never crosses the economic bar (a very
 *     low rate could take a long time to clear 10x gas).
 *   - `epoch-ending`: coverageEnd is within `epochEndMarginSeconds`. Past
 *     coverageEnd, elapsed stops growing — `_sync` clamps at `coverageEnd` —
 *     so whatever is unswept right now is *all it will ever be*. If the
 *     economic threshold hasn't cleared by then, waiting for it to clear
 *     later is waiting for something that has stopped changing.
 *   - `draining`: the projected funded balance covers fewer than
 *     `drainMarginSeconds` more seconds at the current rate. Same freeze,
 *     just triggered by running out of money instead of running out of
 *     epoch.
 *
 * `nothing-elapsed` always wins over every other reason: if a real `sync`
 * would be a no-op (see `project.ts`), sending one buys nothing and costs
 * gas — there is no version of "due" that overrides that.
 */

import type { ProjectedSubscription } from "./project.js";

export interface GateInputs {
  projected: Pick<ProjectedSubscription, "elapsedSeconds" | "accruedPremium" | "runwaySeconds" | "asOf">;
  coverageEnd: bigint;
  /** Estimated cost of one `sync` call, in 6dp USDC — see `gas.ts`. */
  gasCostEstimateUsdc: bigint;
  /** Sync when accrued premium is worth at least this many times the gas cost. */
  safetyFactor: number;
  /** Backstop: sync anyway once this many seconds have elapsed since lastSync. */
  maxSyncIntervalSeconds: bigint;
  /** Force a sync when coverageEnd is within this many seconds. */
  epochEndMarginSeconds: bigint;
  /** Force a sync when projected runway falls to this many seconds or fewer. */
  drainMarginSeconds: bigint;
}

export type GateReason =
  | "nothing-elapsed"
  | "economic"
  | "max-interval"
  | "epoch-ending"
  | "draining"
  | "below-threshold";

export interface GateDecision {
  due: boolean;
  reason: GateReason;
  /** accruedPremium as a multiple of gasCostEstimateUsdc — for logging, not a decision input. */
  coverageRatio: number;
}

export function shouldSync(inputs: GateInputs): GateDecision {
  const {
    projected,
    coverageEnd,
    gasCostEstimateUsdc,
    safetyFactor,
    maxSyncIntervalSeconds,
    epochEndMarginSeconds,
    drainMarginSeconds,
  } = inputs;

  if (projected.elapsedSeconds === 0n) {
    return { due: false, reason: "nothing-elapsed", coverageRatio: 0 };
  }

  const coverageRatio =
    gasCostEstimateUsdc > 0n
      ? Number(projected.accruedPremium) / Number(gasCostEstimateUsdc)
      : Number.POSITIVE_INFINITY;

  if (coverageRatio >= safetyFactor) {
    return { due: true, reason: "economic", coverageRatio };
  }

  if (projected.elapsedSeconds >= maxSyncIntervalSeconds) {
    return { due: true, reason: "max-interval", coverageRatio };
  }

  const remainingUntilCoverageEnd = coverageEnd - projected.asOf;
  if (remainingUntilCoverageEnd <= epochEndMarginSeconds) {
    return { due: true, reason: "epoch-ending", coverageRatio };
  }

  if (projected.runwaySeconds <= drainMarginSeconds) {
    return { due: true, reason: "draining", coverageRatio };
  }

  return { due: false, reason: "below-threshold", coverageRatio };
}
