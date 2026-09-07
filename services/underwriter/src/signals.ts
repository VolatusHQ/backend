/**
 * The market side of the underwriter's signal: implied vs. realized
 * volatility on Unichain, and whether there is enough data to trust either
 * number at all.
 *
 * **Spread is a difference, not a ratio, and that is a deliberate choice.**
 * `realizedVol` can be exactly `0` any time nothing has traded since the
 * active epoch opened (verified live on this session's chain: `tryImpliedVol`
 * returned `ok=true, 559336341441482646` while `realizedVol` read `0`, on a
 * pool that simply had not seen a swap yet). A ratio `implied / realized`
 * divides by that zero and either throws or produces `Infinity`, which a
 * naive policy would read as "maximally attractive" — exactly backwards,
 * since a `0` here is a *missing* measurement, not a measurement of zero
 * risk. A difference (`impliedVolWad - realizedVolWad`) stays a well-defined
 * WAD number through that edge case, so this module computes a difference —
 * see README.md "Why a difference, not a ratio."
 *
 * **That still leaves the missing-measurement problem itself**, which a
 * difference alone does not solve: `implied - 0` is the full implied vol,
 * read as "richly attractive" by a spread-only policy, which is just as
 * wrong. So this module also computes `dataSufficient`, independent of the
 * spread's sign: whether `SigmaHook`'s variance accumulator for this pool has
 * moved at all since the vault opened the active epoch. If it hasn't, there
 * have been zero observations *this epoch* — not "zero realized variance,"
 * missing data — and the policy module treats that exactly like
 * `tryImpliedVol` returning `ok=false`: hold, do not substitute a guess.
 *
 * `accumulator`/`observations` are lifetime counters on `SigmaHook` — the
 * accumulator is "append-only and never reset" across the pool's whole life
 * (`contracts/src/libraries/EpochCursor.sol`), so a lifetime `observations >
 * 0` on its own cannot distinguish "traded recently" from "traded once, two
 * epochs ago, and not since." The precise per-epoch signal is comparing the
 * *live* accumulator against the value `SigmaVault` snapshotted as
 * `startAccumulator` when it opened the current epoch
 * (`contracts/src/SigmaVault.sol`, `startAccumulator: hook.accumulator(poolId)`)
 * — if they are equal, nothing has moved the tick since. That comparison,
 * not the raw lifetime `observations` count, is what `dataSufficient` uses.
 * `observations` is still read and carried through for the status report,
 * since it is useful context, but it is not what the decision is made on.
 *
 * `SigmaHook.accumulator`/`.observations` are not exported from
 * `@volatus/onchain`'s hand-narrowed `sigmaHookAbi` (which only carries the
 * bundled `varianceState` view and the `VarianceObserved` event) — the two
 * getters below are declared locally rather than editing that shared
 * package, which is outside this service's boundary.
 */

import type { Address, Hex, PublicClient } from "viem";
import { sigmaOracleAbi, sigmaVaultAbi } from "@volatus/onchain";

/** `SigmaHook.accumulator(bytes32)` / `.observations(bytes32)` — auto-generated public getters
 *  for `EpochCursor.VarianceState` fields, declared locally (see module doc). */
export const hookExtraAbi = [
  {
    type: "function",
    name: "accumulator",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "observations",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ type: "uint32" }],
  },
] as const;

export interface MarketReads {
  oracleOk: boolean;
  /** `0n` when `oracleOk` is false — never a guess, just the schema's zero value. */
  impliedVolWad: bigint;
  realizedVolWad: bigint;
  /** Whether the vault currently has an active epoch for this pool at all. */
  hasActiveEpoch: boolean;
  /** `SigmaHook.accumulator(poolId)`, read live. */
  accumulatorNow: bigint;
  /** The vault epoch's `startAccumulator` — the hook's accumulator at the moment this epoch
   *  opened. `0n` and meaningless when `hasActiveEpoch` is false. */
  startAccumulator: bigint;
  /** `SigmaHook.observations(poolId)` — a lifetime counter, carried through for display only.
   *  See module doc for why the decision uses the accumulator comparison instead. */
  observations: number;
}

export interface MarketSignal extends MarketReads {
  /** True only when the oracle is live, there is an active epoch, and its accumulator has
   *  moved since that epoch opened. False means "no data," not "no risk." */
  dataSufficient: boolean;
  /** `impliedVolWad - realizedVolWad`, WAD, signed. `null` whenever `oracleOk` is false or
   *  `dataSufficient` is false — never a computed number standing in for a missing one. */
  spreadWad: bigint | null;
}

export function evaluateMarketSignal(raw: MarketReads): MarketSignal {
  const dataSufficient = raw.oracleOk && raw.hasActiveEpoch && raw.accumulatorNow > raw.startAccumulator;
  const spreadWad = dataSufficient ? raw.impliedVolWad - raw.realizedVolWad : null;
  return { ...raw, dataSufficient, spreadWad };
}

export interface ReadMarketSignalOptions {
  client: PublicClient;
  oracleAddress: Address;
  vaultAddress: Address;
  hookAddress: Address;
  poolId: Hex;
}

/** Live chain reads feeding `evaluateMarketSignal`. Nothing here decides anything — see policy.ts. */
export async function readMarketSignal(opts: ReadMarketSignalOptions): Promise<MarketSignal> {
  const [tryImplied, realizedVolWad, activeEpochId] = await Promise.all([
    opts.client.readContract({
      address: opts.oracleAddress,
      abi: sigmaOracleAbi,
      functionName: "tryImpliedVol",
      args: [opts.poolId],
    }),
    opts.client.readContract({
      address: opts.oracleAddress,
      abi: sigmaOracleAbi,
      functionName: "realizedVol",
      args: [opts.poolId],
    }),
    opts.client.readContract({
      address: opts.vaultAddress,
      abi: sigmaVaultAbi,
      functionName: "activeEpoch",
      args: [opts.poolId],
    }),
  ]);
  const [oracleOk, impliedVolWad] = tryImplied;

  const hasActiveEpoch = activeEpochId !== 0n;
  let accumulatorNow = 0n;
  let startAccumulator = 0n;
  let observations = 0;

  if (hasActiveEpoch) {
    const [vaultEpoch, accNow, obs] = await Promise.all([
      opts.client.readContract({
        address: opts.vaultAddress,
        abi: sigmaVaultAbi,
        functionName: "epoch",
        args: [activeEpochId],
      }),
      opts.client.readContract({
        address: opts.hookAddress,
        abi: hookExtraAbi,
        functionName: "accumulator",
        args: [opts.poolId],
      }),
      opts.client.readContract({
        address: opts.hookAddress,
        abi: hookExtraAbi,
        functionName: "observations",
        args: [opts.poolId],
      }),
    ]);
    startAccumulator = vaultEpoch.startAccumulator;
    accumulatorNow = accNow;
    observations = obs;
  }

  return evaluateMarketSignal({
    oracleOk,
    impliedVolWad: oracleOk ? impliedVolWad : 0n,
    realizedVolWad,
    hasActiveEpoch,
    accumulatorNow,
    startAccumulator,
    observations,
  });
}
