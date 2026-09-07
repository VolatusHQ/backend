/**
 * Turns the two signals (`oracle.ts`'s implied vol, `gamma.ts`'s position
 * weight) into a target `(ratePerSecond, coverageNotional)` pair —
 * BACKEND_HANDOFF.md § Service 3 step 3.
 *
 * **This is a proportional heuristic, not a calibrated pricing model, and
 * that is worth saying plainly rather than implying otherwise:**
 *
 *   - `ratePerSecond` scales *linearly* with `ivWad` relative to the
 *     mandate's own `referenceIvWad` — the IV level at which
 *     `baseRatePerSecond` was chosen to apply. Double the IV, double the
 *     rate. There is no options-pricing curve here (no vega convexity, no
 *     smile, no term structure) — it is a knob the mandate's author sets by
 *     picking a reference point they consider fair, and the hedger keeps the
 *     live rate proportional to that choice as IV moves.
 *   - `coverageNotional` scales *linearly* with `positionWeightWad` — the
 *     LP's share of the pool's liquidity (`gamma.ts`) — relative to
 *     `baseCoverageNotional`, the notional the mandate's author chose for a
 *     hypothetical LP holding the whole pool. It is not backed by any options
 *     Greek computed in dollars; see `gamma.ts` for exactly why that number
 *     is not obtainable honestly from this pool.
 *
 * Neither formula was backtested or fit to data. Both are exactly what
 * BACKEND_HANDOFF.md asked for: something a mandate's author configures and
 * the agent then holds to, re-pricing mechanically as the two inputs move,
 * never re-rating on a guess and never touching anything the mandate does
 * not already bound (`clampRate`/`clampNotional`, `mandate.ts`).
 */

import { clampNotional, clampRate, type Mandate } from "./mandate.js";
import { WAD } from "./constants.js";

export interface CoverageTarget {
  ratePerSecond: bigint;
  coverageNotional: bigint;
}

export function computeTargetRate(mandate: Mandate, ivWad: bigint): bigint {
  if (mandate.referenceIvWad <= 0n) {
    throw new Error("pricing.ts: mandate.referenceIvWad must be positive");
  }
  const raw = (mandate.baseRatePerSecond * ivWad) / mandate.referenceIvWad;
  return clampRate(mandate, raw);
}

export function computeTargetNotionalFromWeight(
  mandate: Mandate,
  positionWeightWad: bigint,
  capacityPool: bigint,
): bigint {
  const raw = (mandate.baseCoverageNotional * positionWeightWad) / WAD;
  return clampNotional(mandate, raw, capacityPool);
}

export interface ComputeTargetParams {
  mandate: Mandate;
  ivWad: bigint;
  /** Whether `gamma.ts` found a live position for the mandate's owner at all. */
  positionFound: boolean;
  positionWeightWad: bigint;
  capacityPool: bigint;
  /** The subscription's current on-chain notional — held steady (not zeroed) when no position was found. */
  currentCoverageNotional: bigint;
}

/**
 * When no v4 position was found for the mandate's owner, there is no gamma
 * signal to size coverage against at all — not "a signal of zero." Forcing
 * the notional to zero in that case would silently cancel real coverage
 * because of a log-scan gap or a position minted after this tick started,
 * which is a worse failure than doing nothing. So the target holds the
 * *current* on-chain notional (still re-clamped to the mandate's cap and the
 * live `capacityPool`) rather than deriving one. `drift.ts` then sees zero
 * notional drift and only ever re-rates on IV in that case.
 */
export function computeTarget(params: ComputeTargetParams): CoverageTarget {
  const ratePerSecond = computeTargetRate(params.mandate, params.ivWad);
  const coverageNotional = params.positionFound
    ? computeTargetNotionalFromWeight(params.mandate, params.positionWeightWad, params.capacityPool)
    : clampNotional(params.mandate, params.currentCoverageNotional, params.capacityPool);
  return { ratePerSecond, coverageNotional };
}
