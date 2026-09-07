/**
 * The one place Unichain block numbers meet Arc unix timestamps
 * (BACKEND_HANDOFF.md's "Units" table). Everything here is pure and
 * bigint-only so it is exactly reproducible in a test without touching a
 * chain — only `measureUnichainBlockTime` talks to the RPC, and it does so
 * by *measuring*, not by assuming a constant.
 *
 * Measured live on 2026-09-05: Unichain Sepolia blocks 61,711,100 ->
 * 61,712,100 (1,000 blocks apart) carried the clock from timestamp
 * 1,788,563,528 to 1,788,564,528 — exactly 1,000 seconds, i.e. 1.000s/block
 * at that moment. That confirms BRIEF.md's "~1s/block" but is a point
 * measurement, not a promise the chain keeps forever (a validator can drift
 * it — DECISIONS.md §12's note on `block.timestamp`), so this module
 * re-measures on every call rather than hardcoding that number.
 */

import type { PublicClient } from "viem";

/**
 * Floor division for bigints, rounding toward negative infinity (unlike `/`,
 * which truncates toward zero). Used everywhere below so "round down" means
 * the same thing regardless of sign: a coverageEnd computed from a *future*
 * block is rounded to an earlier-or-equal timestamp (safe — ends coverage
 * slightly early), and one computed from a block already in the past is
 * rounded to an earlier-or-equal timestamp too, not a less-negative one.
 */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("floorDiv: division by zero");
  const q = a / b;
  const r = a % b;
  return r !== 0n && r < 0n !== b < 0n ? q - 1n : q;
}

export interface BlockTimeSample {
  /** `latestTimestamp - pastTimestamp`, seconds. */
  numeratorSeconds: bigint;
  /** `latestBlock - pastBlock`, always >= 1. */
  denominatorBlocks: bigint;
  latestBlock: bigint;
  latestTimestamp: bigint;
  pastBlock: bigint;
  pastTimestamp: bigint;
}

/**
 * Measure Unichain's actual recent block time from two real blocks, `lookback`
 * apart (default 1,000 — big enough that per-block jitter washes out, small
 * enough to stay inside a single `eth_getLogs`-free pair of `eth_getBlockByNumber`
 * calls). Kept as a rate (`numeratorSeconds / denominatorBlocks`) rather than
 * pre-divided into a single "seconds per block" integer, so a fast chain
 * (sub-1s blocks) doesn't get floored to a useless `0` before it is ever
 * multiplied by the number of remaining blocks — see `computeCoverageEnd`.
 */
export async function measureUnichainBlockTime(
  client: PublicClient,
  lookback = 1_000n,
): Promise<BlockTimeSample> {
  const latestBlock = await client.getBlockNumber();
  const pastBlock = latestBlock > lookback ? latestBlock - lookback : 0n;
  const [latest, past] = await Promise.all([
    client.getBlock({ blockNumber: latestBlock }),
    client.getBlock({ blockNumber: pastBlock }),
  ]);
  const denominatorBlocks = latestBlock - pastBlock;
  if (denominatorBlocks <= 0n) {
    throw new Error("measureUnichainBlockTime: latest and past block are the same block");
  }
  return {
    numeratorSeconds: latest.timestamp - past.timestamp,
    denominatorBlocks,
    latestBlock,
    latestTimestamp: latest.timestamp,
    pastBlock,
    pastTimestamp: past.timestamp,
  };
}

/**
 * Convert a Unichain block number (`endBlock`) to a conservative Arc unix
 * timestamp, using a measured block-time rate rather than an assumed
 * constant.
 *
 * `remainingSeconds` is computed as a single floor-divided multiplication
 * (`remainingBlocks * numerator / denominator`), not `remainingBlocks *
 * (numerator / denominator)` — doing the division first would floor the
 * per-block rate to a coarse integer (and to exactly `0` on a sub-1s-block
 * chain) before the error has a chance to average out over many blocks.
 *
 * BACKEND_HANDOFF.md: "Be slightly conservative — coverage ending a little
 * early is safe; ending late sells coverage for a period the payoff does not
 * cover." Flooring here always moves `coverageEnd` earlier-or-equal to the
 * real future timestamp of `endBlock`, never later.
 */
export function computeCoverageEnd(params: {
  nowTimestamp: bigint;
  currentBlock: bigint;
  endBlock: bigint;
  blockTimeNumeratorSeconds: bigint;
  blockTimeDenominatorBlocks: bigint;
}): bigint {
  const { nowTimestamp, currentBlock, endBlock, blockTimeNumeratorSeconds, blockTimeDenominatorBlocks } = params;
  const remainingBlocks = endBlock - currentBlock;
  const remainingSeconds = floorDiv(
    remainingBlocks * blockTimeNumeratorSeconds,
    blockTimeDenominatorBlocks,
  );
  return nowTimestamp + remainingSeconds;
}

/** `coverageEnd + marginSeconds` — the reporter's own operational deadline. */
export function computeReportDeadline(coverageEnd: bigint, marginSeconds: bigint): bigint {
  return coverageEnd + marginSeconds;
}

/**
 * False when mirroring the epoch now would open it with a report window
 * that is already closed — e.g. a very old vault epoch discovered by a
 * backfill long after it ended. Opening it anyway would only ever be able to
 * revert `ReportWindowClosed`, so it is better not to spend the gas or
 * pollute Arc state with a doomed epoch (`discoverAndMirrorEpochs` in
 * `discovery.ts` uses this to skip and journal it as `skipped-stale`
 * instead of `openEpoch`-ing it).
 */
export function shouldMirrorEpoch(params: { nowTimestamp: bigint; reportDeadline: bigint }): boolean {
  return params.reportDeadline > params.nowTimestamp;
}
