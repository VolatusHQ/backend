/**
 * Whether the live subscription has drifted far enough from the computed
 * target to justify sending `adjust` — BACKEND_HANDOFF.md § Service 3 step 4:
 * "Do not re-rate every block just because you can... put the threshold in
 * the mandate so the user chose it."
 *
 * Every `adjust` is a transaction, a `_sync`, and real gas (BRIEF.md measured
 * `sync` alone at ~0.0017 USDC on Arc; `adjust` does the same `_sync` plus a
 * storage write, so it costs at least that much). Re-rating on every tick for
 * a sub-percent IV wobble would burn the mandate's cumulative allowance on
 * noise. `driftToleranceBps` is the mandate's own choice of how much drift is
 * worth paying for.
 */

import type { CoverageTarget } from "./pricing.js";

export interface CurrentSubscription {
  ratePerSecond: bigint;
  coverageNotional: bigint;
}

export type AdjustReason = "not-subscribed" | "rate-drift" | "notional-drift" | "within-tolerance";

export interface AdjustDecision {
  due: boolean;
  reason: AdjustReason;
  /** Relative change vs. current, in basis points. `Infinity` when current is 0 and target is not. */
  rateDriftBps: number;
  notionalDriftBps: number;
}

function driftBps(from: bigint, to: bigint): number {
  if (from === 0n) return to === 0n ? 0 : Number.POSITIVE_INFINITY;
  const diff = to > from ? to - from : from - to;
  return Number((diff * 10_000n) / from);
}

/**
 * `current.ratePerSecond === 0n` means there is no live subscription to
 * re-rate at all (never subscribed, or cancelled). `subscribe()` is a
 * user-authorized action this agent never initiates on its own — see
 * README.md § Delegation — so that case is reported, not treated as a rate
 * drift of infinite size.
 */
export function shouldAdjust(
  current: CurrentSubscription,
  target: CoverageTarget,
  toleranceBps: number,
): AdjustDecision {
  if (current.ratePerSecond === 0n) {
    return { due: false, reason: "not-subscribed", rateDriftBps: 0, notionalDriftBps: 0 };
  }

  const rateDriftBps = driftBps(current.ratePerSecond, target.ratePerSecond);
  const notionalDriftBps = driftBps(current.coverageNotional, target.coverageNotional);

  if (rateDriftBps > toleranceBps) {
    return { due: true, reason: "rate-drift", rateDriftBps, notionalDriftBps };
  }
  if (notionalDriftBps > toleranceBps) {
    return { due: true, reason: "notional-drift", rateDriftBps, notionalDriftBps };
  }
  return { due: false, reason: "within-tolerance", rateDriftBps, notionalDriftBps };
}
