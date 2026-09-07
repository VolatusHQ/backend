/**
 * The mandate: a typed, bounded authorization for one LP's hedge on one Arc
 * epoch. Every action the tick loop attempts (`tick.ts`) is checked against
 * this before it is attempted — never after. This module holds the checks;
 * `spend.ts` holds the journal-backed cumulative ledger a restart cannot
 * forget, and `config.ts` is where a mandate's field values actually come
 * from (env, today — see that file's comment on why).
 *
 * The mandate itself is data, not enforcement. Enforcement is layered:
 *
 *   - `clampRate`/`clampNotional` here keep every *computed* target inside
 *     the mandate's declared caps before it is ever sent.
 *   - `mandateExpired` refuses every action once `expiresAt` has passed.
 *   - `spend.ts` refuses to fund past `maxCumulativeSpendUsdc`, reading the
 *     journal fresh every time rather than trusting an in-memory counter.
 *   - `src/delegation/` is the layer that makes this bind even if this
 *     service's own code is compromised — see that module's README section.
 */

import type { Address, Hex } from "viem";

export interface Mandate {
  /** Namespaces this mandate's journal keys (`adjust:<id>`, `fund:<id>`) and log lines. Not a security boundary itself. */
  id: string;

  /** The LP this mandate hedges: whose v4 position sizes gamma exposure, and whose Arc subscription gets adjusted/funded. */
  owner: Address;

  /** Unichain pool id measured for gamma and IV — both are keyed off this, never off the Arc epoch id. */
  poolId: Hex;

  /** Arc epoch id this mandate is scoped to. One mandate, one epoch: a new epoch needs a new mandate, not a mutated one. */
  epochId: bigint;

  /** Pinned. `adjust`/`fund`/`approve` are only ever sent to these — see src/delegation/. */
  streamAddress: Address;
  usdcAddress: Address;

  /** ratePerSecond at ivWad == referenceIvWad; scales linearly with ivWad from there. See pricing.ts. */
  baseRatePerSecond: bigint;
  referenceIvWad: bigint;
  maxRatePerSecond: bigint;

  /** coverageNotional at positionWeightWad == WAD (the LP holds the whole pool's liquidity); scales linearly down from there. */
  baseCoverageNotional: bigint;
  maxCoverageNotional: bigint;

  /** Relative-change threshold, basis points, below which `adjust` is not worth sending (BACKEND_HANDOFF.md: "put the threshold in the mandate so the user chose it"). */
  driftToleranceBps: number;

  /** `fund` when projected runway falls to this many seconds or fewer. */
  runwayFloorSeconds: bigint;
  /** Amount funded per top-up, 6dp USDC — clamped to whatever remains of `maxCumulativeSpendUsdc`. */
  fundTopUpUsdc: bigint;

  /** Hard ceiling on total USDC ever moved into the stream via `fund()` under this mandate, 6dp. Never gas — see spend.ts. */
  maxCumulativeSpendUsdc: bigint;

  /** Unix seconds. No action — read-only status excepted — is attempted at or after this. */
  expiresAt: bigint;
}

export function mandateExpired(mandate: Mandate, nowTs: bigint): boolean {
  return nowTs >= mandate.expiresAt;
}

/** `adjust` reverts `ZeroRate` on 0 — floor at 1 (the smallest legal rate) rather than ever sending 0. */
export function clampRate(mandate: Mandate, rate: bigint): bigint {
  if (rate < 1n) return 1n;
  return rate > mandate.maxRatePerSecond ? mandate.maxRatePerSecond : rate;
}

/**
 * `adjust`/`subscribe` revert `InsufficientCapacity` above `capacityPool`, so
 * a live read of it is as much a hard cap as the mandate's own
 * `maxCoverageNotional` — both are applied, whichever binds tighter.
 */
export function clampNotional(mandate: Mandate, notional: bigint, capacityPool: bigint): bigint {
  let n = notional < 0n ? 0n : notional;
  if (n > mandate.maxCoverageNotional) n = mandate.maxCoverageNotional;
  if (n > capacityPool) n = capacityPool;
  return n;
}
