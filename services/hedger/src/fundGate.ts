/**
 * Whether `fund` is due — BACKEND_HANDOFF.md § Service 3 step 5: "Top up
 * `fund(epochId, amount)` when `runwaySeconds` falls below a floor, within
 * the mandate's cumulative cap."
 *
 * The runway floor is read off `runway.ts`'s off-chain projection (the same
 * ported `_sync` mirror the keeper uses), not the contract's own
 * `runwaySeconds` view, so this can be evaluated in the same tick as a
 * pending `adjust` without an extra round trip. The cumulative cap is not
 * re-derived here: `spend.ts` reads the journal for what has actually landed
 * and this function is handed the result, so the two stay in one place.
 */

import type { Mandate } from "./mandate.js";
import type { ProjectedSubscription } from "./runway.js";

export type FundReason = "not-subscribed" | "sufficient-runway" | "cumulative-cap-reached" | "runway-floor";

export interface FundDecision {
  due: boolean;
  reason: FundReason;
  /** 6dp USDC to fund. Always 0 when `due` is false. */
  amountUsdc: bigint;
}

export interface ShouldFundParams {
  ratePerSecond: bigint;
  projected: Pick<ProjectedSubscription, "runwaySeconds">;
  mandate: Mandate;
  /** From `spend.ts`'s `cumulativeSpentUsdc` — read fresh from the journal, never an in-memory running total. */
  cumulativeSpentUsdc: bigint;
}

export function shouldFund(params: ShouldFundParams): FundDecision {
  const { ratePerSecond, projected, mandate, cumulativeSpentUsdc } = params;

  if (ratePerSecond === 0n) {
    return { due: false, reason: "not-subscribed", amountUsdc: 0n };
  }
  if (projected.runwaySeconds > mandate.runwayFloorSeconds) {
    return { due: false, reason: "sufficient-runway", amountUsdc: 0n };
  }

  const remainingCap =
    mandate.maxCumulativeSpendUsdc > cumulativeSpentUsdc ? mandate.maxCumulativeSpendUsdc - cumulativeSpentUsdc : 0n;
  if (remainingCap <= 0n) {
    return { due: false, reason: "cumulative-cap-reached", amountUsdc: 0n };
  }

  const amountUsdc = mandate.fundTopUpUsdc > remainingCap ? remainingCap : mandate.fundTopUpUsdc;
  return { due: true, reason: "runway-floor", amountUsdc };
}
