import { describe, expect, it } from "vitest";
import {
  computeCoverageEnd,
  computeReportDeadline,
  floorDiv,
  measureUnichainBlockTime,
  shouldMirrorEpoch,
} from "../src/time.js";
import type { PublicClient } from "viem";

describe("floorDiv", () => {
  it("matches ordinary truncating division when it divides evenly", () => {
    expect(floorDiv(10n, 5n)).toBe(2n);
    expect(floorDiv(-10n, 5n)).toBe(-2n);
  });

  it("rounds toward negative infinity, not toward zero, on a positive remainder case", () => {
    expect(floorDiv(7n, 2n)).toBe(3n); // 3.5 -> 3, same as truncation here
    expect(floorDiv(-7n, 2n)).toBe(-4n); // -3.5 -> floor is -4, truncation would give -3
  });

  it("throws on division by zero", () => {
    expect(() => floorDiv(1n, 0n)).toThrow();
  });
});

describe("computeCoverageEnd — the block-number -> Arc-timestamp conversion", () => {
  const nowTimestamp = 1_788_564_528n;
  const currentBlock = 61_712_100n;

  it("is conservative (rounds down) for a future endBlock with an exact 1s/block rate", () => {
    // Measured live 2026-09-05: 1000 blocks apart moved the clock by exactly
    // 1000 seconds -- see time.ts's doc comment.
    const endBlock = currentBlock + 604_800n; // ~7 days of blocks, matching vault epoch 2
    const coverageEnd = computeCoverageEnd({
      nowTimestamp,
      currentBlock,
      endBlock,
      blockTimeNumeratorSeconds: 1000n,
      blockTimeDenominatorBlocks: 1000n,
    });
    expect(coverageEnd).toBe(nowTimestamp + 604_800n);
  });

  it("rounds DOWN (never up) when the measured rate is not a whole number of seconds per block", () => {
    // 999 seconds over 1000 blocks -> 0.999s/block. 7 remaining blocks is
    // 6.993s of real time; flooring must give 6, never 7.
    const coverageEnd = computeCoverageEnd({
      nowTimestamp,
      currentBlock,
      endBlock: currentBlock + 7n,
      blockTimeNumeratorSeconds: 999n,
      blockTimeDenominatorBlocks: 1000n,
    });
    expect(coverageEnd).toBe(nowTimestamp + 6n);
    // The naive "round the per-block rate first, then multiply" approach
    // would floor 999/1000 to 0 and produce nowTimestamp + 0 -- an absurdly
    // early coverageEnd for a genuinely 7-block-away epoch. Guard against
    // that regression explicitly.
    expect(coverageEnd).not.toBe(nowTimestamp);
  });

  it("never returns a timestamp later than naively multiplying blocks by the measured rate would", () => {
    // For a large, non-exact remaining-block count, the floored result must
    // be <= the exact rational value (converted to a float for comparison).
    const endBlock = currentBlock + 123_457n;
    const numerator = 1013n;
    const denominator = 1000n;
    const coverageEnd = computeCoverageEnd({
      nowTimestamp,
      currentBlock,
      endBlock,
      blockTimeNumeratorSeconds: numerator,
      blockTimeDenominatorBlocks: denominator,
    });
    const exactRemainingSeconds = (Number(endBlock - currentBlock) * Number(numerator)) / Number(denominator);
    expect(Number(coverageEnd - nowTimestamp)).toBeLessThanOrEqual(exactRemainingSeconds);
    expect(Number(coverageEnd - nowTimestamp)).toBeGreaterThan(exactRemainingSeconds - 1);
  });

  it("handles an endBlock already in the past (a stale, already-ended epoch) by landing earlier than now", () => {
    const coverageEnd = computeCoverageEnd({
      nowTimestamp,
      currentBlock,
      endBlock: currentBlock - 1000n,
      blockTimeNumeratorSeconds: 1000n,
      blockTimeDenominatorBlocks: 1000n,
    });
    expect(coverageEnd).toBe(nowTimestamp - 1000n);
    expect(coverageEnd).toBeLessThan(nowTimestamp);
  });
});

describe("computeReportDeadline", () => {
  it("adds the margin on top of coverageEnd", () => {
    expect(computeReportDeadline(1000n, 86_400n)).toBe(87_400n);
  });
});

describe("shouldMirrorEpoch", () => {
  it("is true when the report deadline is still in the future", () => {
    expect(shouldMirrorEpoch({ nowTimestamp: 100n, reportDeadline: 101n })).toBe(true);
  });

  it("is false once the report deadline has already passed (a stale epoch)", () => {
    expect(shouldMirrorEpoch({ nowTimestamp: 100n, reportDeadline: 100n })).toBe(false);
    expect(shouldMirrorEpoch({ nowTimestamp: 101n, reportDeadline: 100n })).toBe(false);
  });
});

describe("measureUnichainBlockTime", () => {
  function fakeClient(blocks: Record<string, { number: bigint; timestamp: bigint }>, latest: bigint): PublicClient {
    return {
      getBlockNumber: async () => latest,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
        const b = blocks[blockNumber.toString()];
        if (!b) throw new Error(`no fixture block ${blockNumber}`);
        return b as never;
      },
    } as unknown as PublicClient;
  }

  it("computes numerator/denominator from two real blocks, 1000 apart by default", async () => {
    const client = fakeClient(
      {
        "61712100": { number: 61_712_100n, timestamp: 1_788_564_528n },
        "61711100": { number: 61_711_100n, timestamp: 1_788_563_528n },
      },
      61_712_100n,
    );
    const sample = await measureUnichainBlockTime(client);
    expect(sample.numeratorSeconds).toBe(1000n);
    expect(sample.denominatorBlocks).toBe(1000n);
    expect(sample.latestBlock).toBe(61_712_100n);
    expect(sample.pastBlock).toBe(61_711_100n);
  });

  it("clamps the lookback to block 0 when the chain is younger than the lookback window", async () => {
    const client = fakeClient(
      {
        "500": { number: 500n, timestamp: 2000n },
        "0": { number: 0n, timestamp: 1000n },
      },
      500n,
    );
    const sample = await measureUnichainBlockTime(client, 1000n);
    expect(sample.pastBlock).toBe(0n);
    expect(sample.denominatorBlocks).toBe(500n);
  });
});
