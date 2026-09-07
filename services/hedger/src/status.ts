/**
 * `status` — what the hedger sees, what it would do, and why.
 *
 * The oracle line comes first because it gates everything: when
 * `tryImpliedVol` returns `ok = false` the tick stops there and nothing below
 * it is computed. That is deliberate — a hedger that guesses at a missing
 * volatility feed re-prices real money against a number nobody published.
 */

import { formatUnits } from "viem";
import type { HedgerTickResult } from "./tick.js";
import type { Mandate } from "./mandate.js";

function pct(wad: bigint): string {
  return `${((Number(wad) / 1e18) * 100).toFixed(4)}%`;
}

function usdc(units: bigint): string {
  return `${formatUnits(units, 6)} USDC`;
}

function duration(seconds: bigint): string {
  const s = seconds < 0n ? 0n : seconds;
  const d = s / 86_400n;
  const h = (s % 86_400n) / 3_600n;
  const m = (s % 3_600n) / 60n;
  if (d > 0n) return `${d}d ${h}h`;
  if (h > 0n) return `${h}h ${m}m`;
  return `${m}m ${s % 60n}s`;
}

export function formatStatusReport(r: HedgerTickResult, mandate: Mandate): string {
  const l: string[] = [];

  l.push(`hedger status — as of unix ${r.nowTs}`);
  l.push(`mandate "${mandate.id}" for ${mandate.owner}, Arc epoch ${mandate.epochId}`);
  l.push(
    `  expires ${mandate.expiresAt} (${r.mandateExpired ? "EXPIRED — no action will be taken" : `in ${duration(mandate.expiresAt - r.nowTs)}`})`,
  );
  l.push(
    `  spend ${usdc(r.cumulativeSpentUsdc)} of ${usdc(mandate.maxCumulativeSpendUsdc)} cap` +
      `  |  drift tolerance ${mandate.driftToleranceBps} bps  |  runway floor ${mandate.runwayFloorSeconds}s`,
  );
  l.push("");

  l.push("signal (Unichain)");
  if (!r.ivResult.ok) {
    l.push("  implied vol        : UNAVAILABLE — tryImpliedVol returned ok=false.");
    l.push("                       Doing nothing. A missing feed is never replaced by a guess.");
  } else {
    l.push(`  implied vol        : ${pct(r.ivResult.impliedVolWad)}`);
  }
  if (r.position) {
    l.push(`  v4 position        : ${r.position.found ? (r.position.inRange ? "in range" : "OUT OF RANGE — no gamma exposure") : "none found for this owner"}`);
    l.push(`  position weight    : ${pct(r.position.positionWeightWad)} of pool liquidity`);
  }
  l.push("");

  l.push("subscription (Arc)");
  l.push(`  ratePerSecond      : ${r.subscription.ratePerSecond}  (6dp USDC/s)`);
  l.push(`  coverageNotional   : ${usdc(r.subscription.coverageNotional)}`);
  l.push(`  funded             : ${usdc(r.subscription.funded)}`);
  l.push(`  coveredSeconds     : ${r.subscription.coveredSeconds}`);
  l.push(`  capacityPool       : ${usdc(r.capacityPool)}  (a notional above this reverts InsufficientCapacity)`);
  if (r.projectedRunway) {
    l.push(`  projected runway   : ${duration(BigInt(r.projectedRunway.runwaySeconds))}`);
  }
  l.push("");

  if (r.skippedReason) {
    l.push(`decision: NO ACTION — ${r.skippedReason}`);
    return l.join("\n");
  }

  if (r.target) {
    l.push("target");
    l.push(`  ratePerSecond      : ${r.target.ratePerSecond}`);
    l.push(`  coverageNotional   : ${usdc(r.target.coverageNotional)}`);
  }

  if (r.adjustDecision) {
    l.push("");
    l.push(`adjust: ${r.adjustDecision.due ? "YES" : "NO"}`);
    l.push(`  reason             : ${r.adjustDecision.reason}`);
    l.push(`  drift              : rate ${r.adjustDecision.rateDriftBps} bps, notional ${r.adjustDecision.notionalDriftBps} bps (tolerance ${mandate.driftToleranceBps})`);
  }

  if (r.fundDecision) {
    l.push("");
    l.push(`fund: ${r.fundDecision.due ? "YES" : "NO"}`);
    l.push(`  reason             : ${r.fundDecision.reason}`);
    if (r.fundDecision.due) l.push(`  amount             : ${usdc(r.fundDecision.amountUsdc)}`);
  }

  for (const [label, res] of [
    ["approve", r.approveSendResult],
    ["adjust", r.adjustSendResult],
    ["fund", r.fundSendResult],
  ] as const) {
    if (res) l.push(`  ${label} sent        : ${res.ok ? res.hash : `FAILED — ${res.reason}`}`);
  }

  return l.join("\n");
}
