/**
 * Signals -> intent. This is a heuristic, not a calibrated risk model — see
 * README.md's "Policy and its limits" for the honest version of that
 * sentence. Every threshold below is a config default with a name and a
 * reason attached to it, not a number backed by historical loss data (there
 * is no history to back it with: this pool has processed one claim, ever).
 *
 * Decision order, each one final once it fires:
 *
 *   1. oracle unavailable            -> hold   (hard rule, BACKEND_HANDOFF.md)
 *   2. insufficient data this epoch  -> hold   (see signals.ts module doc)
 *   3. this agent holds no shares    -> hold   (nothing to withdraw)
 *   4. concentration over the cap    -> withdraw (idiosyncratic risk first)
 *   5. spread clears the post bar    -> post
 *   6. spread at/below withdraw bar  -> withdraw
 *   7. otherwise                     -> hold   (neutral band)
 *
 * Concentration is checked before the spread thresholds: a rich spread does
 * not make a single over-concentrated counterparty safer, so risk
 * concentration is treated as the more urgent signal.
 *
 * **On `wouldBlockSubscriptions`.** Withdrawing capacity can push
 * `capacityPool` below what an existing subscriber would need to `adjust()`
 * back up to their current notional, or below what a same-sized new
 * subscriber could `subscribe()` for (`contracts/src/SigmaStream.sol`'s
 * `InsufficientCapacity`). This module computes that flag and puts it on
 * every withdraw decision it returns — it never shrinks the withdrawal
 * amount to make the flag go away. `BACKEND_HANDOFF.md` § Service 4 is
 * explicit that this tradeoff is surfaced, not routed around; `tick.ts` is
 * where the operational choice (send anyway, or refuse and alarm) is made,
 * with the full, undiminished numbers in hand.
 */

import type { Address } from "viem";
import { mulDivDown, projectWithdrawal } from "./shares.js";

const WAD = 10n ** 18n;

export interface PolicyInputs {
  oracleOk: boolean;
  dataSufficient: boolean;
  /** `impliedVolWad - realizedVolWad`. Must be non-null whenever both flags above are true —
   *  see `signals.ts`'s `evaluateMarketSignal`, which guarantees exactly that pairing. */
  spreadWad: bigint | null;
  capacityPool: bigint;
  totalShares: bigint;
  totalNotional: bigint;
  maxNotional: bigint;
  maxNotionalSubscriber: Address | null;
  /** This agent's own share balance — `shares(address)` on `SigmaStream`. */
  ownShares: bigint;
}

export interface PolicyTuning {
  /** Post more capacity once `spreadWad >=` this. Default 0.05e18 (5 percentage points of
   *  annualized vol): implied pricing rich enough over realized to be worth committing more. */
  postSpreadThresholdWad: bigint;
  /** Withdraw once `spreadWad <=` this. Default -0.02e18: implied pricing at or below realized
   *  is adverse for the underwriter side of the trade. */
  withdrawSpreadThresholdWad: bigint;
  /** Withdraw (regardless of spread) once concentration exceeds this. Default 0.5e18 (50%):
   *  more than half the pool's value exposed to one counterparty's claim. */
  maxConcentrationWad: bigint;
  /** Amount proposed for a single "post" decision, 6dp USDC. Sizing (and whether it clears
   *  the spending cap) is `caps.ts`'s job, not this module's. */
  postIncrementUsdc: bigint;
  /** Fraction of this agent's own shares to withdraw when a withdraw decision fires.
   *  Default 0.1e18 (10%): a partial de-risking step, not an exit. */
  withdrawShareFractionWad: bigint;
}

export type Intent = "post" | "withdraw" | "hold";

export interface PolicyDecision {
  intent: Intent;
  reason: string;
  postAmountUsdc?: bigint;
  withdrawShareAmount?: bigint;
  /** `maxNotional / capacityPool`, WAD. Always computed, even on hold, for the status report. */
  concentrationWad: bigint;
  /** `totalNotional / capacityPool`, WAD. Can exceed 1e18 — see `registry.ts` module doc. */
  utilizationWad: bigint;
  /** Only meaningful when `intent === "withdraw"`. See module doc. */
  wouldBlockSubscriptions: boolean;
}

function formatPct(wad: bigint): string {
  const sign = wad < 0n ? "-" : "";
  const abs = wad < 0n ? -wad : wad;
  return `${sign}${((Number(abs) / 1e18) * 100).toFixed(4)}%`;
}

function planWithdraw(inputs: PolicyInputs, tuning: PolicyTuning): { shareAmount: bigint; wouldBlock: boolean } {
  const shareAmount = mulDivDown(inputs.ownShares, tuning.withdrawShareFractionWad, WAD);
  if (shareAmount === 0n || inputs.totalShares === 0n) {
    return { shareAmount, wouldBlock: false };
  }
  const projectedAmountOut = projectWithdrawal(shareAmount, inputs.capacityPool, inputs.totalShares);
  const projectedPool = inputs.capacityPool - projectedAmountOut;
  return { shareAmount, wouldBlock: projectedPool < inputs.maxNotional };
}

export function decide(inputs: PolicyInputs, tuning: PolicyTuning): PolicyDecision {
  const concentrationWad = inputs.capacityPool === 0n ? 0n : mulDivDown(inputs.maxNotional, WAD, inputs.capacityPool);
  const utilizationWad = inputs.capacityPool === 0n ? 0n : mulDivDown(inputs.totalNotional, WAD, inputs.capacityPool);
  const base = { concentrationWad, utilizationWad };

  if (!inputs.oracleOk) {
    return {
      ...base,
      intent: "hold",
      reason: "oracle-unavailable: tryImpliedVol returned ok=false -- never substitute a guess for a missing feed",
      wouldBlockSubscriptions: false,
    };
  }

  if (!inputs.dataSufficient) {
    return {
      ...base,
      intent: "hold",
      reason:
        "insufficient-data: no observations since the active epoch opened -- realizedVol=0 here is a missing " +
        "measurement, not a zero-risk one (see signals.ts)",
      wouldBlockSubscriptions: false,
    };
  }

  if (inputs.ownShares === 0n) {
    // Concentration/spread may still say "withdraw," but this agent has nothing to withdraw --
    // that is a fact about this agent's position, not about the market, so it is checked before
    // either signal and always reported as hold rather than a withdraw of 0 shares.
    return {
      ...base,
      intent: "hold",
      reason: "no-position: this agent holds 0 shares -- nothing to withdraw regardless of signals",
      wouldBlockSubscriptions: false,
    };
  }

  if (concentrationWad > tuning.maxConcentrationWad) {
    const { shareAmount, wouldBlock } = planWithdraw(inputs, tuning);
    return {
      ...base,
      intent: "withdraw",
      reason:
        `concentration ${formatPct(concentrationWad)} exceeds the max ${formatPct(tuning.maxConcentrationWad)} -- ` +
        `subscriber ${inputs.maxNotionalSubscriber ?? "?"} alone accounts for that share of the pool`,
      withdrawShareAmount: shareAmount,
      wouldBlockSubscriptions: wouldBlock,
    };
  }

  const spread = inputs.spreadWad;
  if (spread === null) {
    // Guaranteed unreachable when evaluateMarketSignal produced these inputs (dataSufficient
    // implies a non-null spread) -- guarded anyway so a caller assembling PolicyInputs by hand
    // (e.g. a test) gets a clear hold instead of a thrown TypeError two lines down.
    return {
      ...base,
      intent: "hold",
      reason: "no spread available despite dataSufficient=true -- inconsistent inputs, refusing to guess",
      wouldBlockSubscriptions: false,
    };
  }

  if (spread >= tuning.postSpreadThresholdWad) {
    return {
      ...base,
      intent: "post",
      reason:
        `spread ${formatPct(spread)} clears the post threshold ${formatPct(tuning.postSpreadThresholdWad)} -- ` +
        "implied is rich relative to realized",
      postAmountUsdc: tuning.postIncrementUsdc,
      wouldBlockSubscriptions: false,
    };
  }

  if (spread <= tuning.withdrawSpreadThresholdWad) {
    const { shareAmount, wouldBlock } = planWithdraw(inputs, tuning);
    return {
      ...base,
      intent: "withdraw",
      reason:
        `spread ${formatPct(spread)} at or below the withdraw threshold ${formatPct(tuning.withdrawSpreadThresholdWad)} -- ` +
        "implied is cheap relative to realized",
      withdrawShareAmount: shareAmount,
      wouldBlockSubscriptions: wouldBlock,
    };
  }

  return {
    ...base,
    intent: "hold",
    reason:
      `spread ${formatPct(spread)} is within the neutral band [${formatPct(tuning.withdrawSpreadThresholdWad)}, ` +
      `${formatPct(tuning.postSpreadThresholdWad)}]`,
    wouldBlockSubscriptions: false,
  };
}
