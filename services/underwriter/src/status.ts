/**
 * `status` — one read-only picture of what the underwriter sees and what it
 * would do about it.
 *
 * The report leads with whether the data is usable at all, because that is the
 * decision that gates every other one. `realizedVol` reads `0` whenever the
 * measured pool has not traded since its epoch opened, and a spread computed
 * against that zero would say "implied is enormously rich, post everything" —
 * a confident number derived from an absent measurement. `signals.ts` refuses
 * to compute it, and this report says so in words rather than printing a
 * plausible figure.
 */

import { formatUnits } from "viem";
import type { Address } from "viem";
import type { TickSummary } from "./tick.js";

const WAD = 10n ** 18n;

function pct(wad: bigint): string {
  const sign = wad < 0n ? "-" : "";
  const abs = wad < 0n ? -wad : wad;
  return `${sign}${((Number(abs) / 1e18) * 100).toFixed(4)}%`;
}

function usdc(units: bigint): string {
  return `${formatUnits(units, 6)} USDC`;
}

export interface StatusContext {
  walletAddress: Address;
  /** Native Arc balance, which is the same USDC that pays for gas. */
  walletBalanceUsdc: number;
}

export function formatStatusReport(s: TickSummary, ctx: StatusContext): string {
  const l: string[] = [];

  l.push(`underwriter status — as of unix ${s.nowTs}`);
  l.push(`wallet ${ctx.walletAddress} — ${ctx.walletBalanceUsdc.toFixed(6)} USDC (Arc gas is this balance)`);
  l.push("");

  l.push("signal (Unichain)");
  l.push(`  oracle feed        : ${s.market.oracleOk ? "live" : "UNAVAILABLE (tryImpliedVol ok=false)"}`);
  l.push(`  implied vol        : ${pct(s.market.impliedVolWad)}`);
  l.push(`  realized vol       : ${pct(s.market.realizedVolWad)}`);
  l.push(`  active epoch       : ${s.market.hasActiveEpoch ? "yes" : "no"}`);
  l.push(`  accumulator        : ${s.market.accumulatorNow} (epoch opened at ${s.market.startAccumulator})`);

  if (s.market.spreadWad === null) {
    // The distinction the whole signal rests on: realized 0 with an unmoved
    // accumulator is an absent measurement, not a measurement of zero risk.
    l.push("  spread             : NOT COMPUTED — insufficient data, not a spread of zero.");
    l.push(
      s.market.hasActiveEpoch && s.market.accumulatorNow === s.market.startAccumulator
        ? "                       the pool has not traded since this epoch opened, so realized"
        : "                       the feed or the epoch is unavailable, so realized",
    );
    l.push("                       volatility is unmeasured. Holding rather than inferring.");
  } else {
    l.push(`  spread (impl-real) : ${pct(s.market.spreadWad)}`);
  }
  l.push("");

  l.push("pool (Arc)");
  l.push(`  capacityPool       : ${usdc(s.capacityPool)}`);
  l.push(`  totalShares        : ${s.totalShares}`);
  l.push(`  share price        : ${(Number(s.sharePriceWad) / 1e18).toFixed(6)}${
    s.sharePriceWad > WAD ? "  (above 1.0 — premium has been earned)" : ""
  }`);
  l.push(`  our shares         : ${s.ownShares}  -> ${usdc(
    s.totalShares === 0n ? 0n : (s.ownShares * s.capacityPool) / s.totalShares,
  )} if withdrawn now`);
  l.push("");

  l.push("exposure");
  l.push(`  subscriptions      : ${s.exposure.activeCount} still exposed`);
  l.push(`  total notional     : ${usdc(s.exposure.totalNotional)}`);
  l.push(`  largest single     : ${usdc(s.exposure.maxNotional)}${
    s.exposure.maxNotionalSubscriber ? ` (${s.exposure.maxNotionalSubscriber})` : ""
  }`);
  l.push(`  utilization        : ${pct(s.decision.utilizationWad)}`);
  l.push(`  concentration      : ${pct(s.decision.concentrationWad)}`);
  l.push("");

  l.push(`intent: ${s.decision.intent.toUpperCase()}`);
  l.push(`  reason             : ${s.decision.reason}`);
  if (s.decision.postAmountUsdc !== undefined) {
    l.push(`  would post         : ${usdc(s.decision.postAmountUsdc)}`);
  }
  if (s.decision.withdrawShareAmount !== undefined) {
    l.push(`  would withdraw     : ${s.decision.withdrawShareAmount} shares`);
  }
  if (s.decision.wouldBlockSubscriptions) {
    // Surfaced, never routed around: subscribe() reverts InsufficientCapacity
    // when notional exceeds the pool, and that is the contract working.
    l.push("  ⚠ this withdrawal would drop the pool below the largest live notional,");
    l.push("    which would make new subscriptions revert InsufficientCapacity.");
    l.push("    Refused unless UW_ALLOW_BLOCKING_WITHDRAWALS=1.");
  }
  if (s.blockedByCap) l.push("  BLOCKED by our own spend cap (Circle's policy engine is mainnet-only).");
  if (s.blockedByGuard) l.push("  BLOCKED by the blocking-withdrawal guard.");
  if (s.capDecision && !s.capDecision.allowed) l.push(`  cap says           : ${s.capDecision.reason}`);
  if (s.error) l.push(`  error              : ${s.error}`);

  return l.join("\n");
}
