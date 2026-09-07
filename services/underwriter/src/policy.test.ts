import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { decide, type PolicyInputs, type PolicyTuning } from "./policy.js";

const SUB_A = "0x7975E591c26e6c6D9B0CFd9A81f6d61A921C080c" as Address;

const defaultTuning: PolicyTuning = {
  postSpreadThresholdWad: 50_000_000_000_000_000n, // +5%
  withdrawSpreadThresholdWad: -20_000_000_000_000_000n, // -2%
  maxConcentrationWad: 500_000_000_000_000_000n, // 50%
  postIncrementUsdc: 1_000_000n, // 1 USDC
  withdrawShareFractionWad: 100_000_000_000_000_000n, // 10%
};

const baseInputs: PolicyInputs = {
  oracleOk: true,
  dataSufficient: true,
  spreadWad: 0n,
  capacityPool: 5_889_412n,
  totalShares: 5_000_000n,
  totalNotional: 1_000_000n,
  maxNotional: 1_000_000n,
  maxNotionalSubscriber: SUB_A,
  ownShares: 5_000_000n,
};

describe("decide — hard rules, checked before any threshold", () => {
  it("holds when the oracle is unavailable, regardless of every other input", () => {
    const decision = decide({ ...baseInputs, oracleOk: false, dataSufficient: false, spreadWad: null }, defaultTuning);
    expect(decision.intent).toBe("hold");
    expect(decision.reason).toMatch(/oracle-unavailable/);
  });

  it("holds on insufficient data (the live realizedVol=0 edge case) rather than treating it as a buy signal", () => {
    const decision = decide({ ...baseInputs, dataSufficient: false, spreadWad: null }, defaultTuning);
    expect(decision.intent).toBe("hold");
    expect(decision.reason).toMatch(/insufficient-data/);
  });

  it("holds when this agent holds 0 shares, even if concentration or spread would otherwise say withdraw", () => {
    const decision = decide(
      { ...baseInputs, ownShares: 0n, maxNotional: 5_000_000n, spreadWad: -30_000_000_000_000_000n },
      defaultTuning,
    );
    expect(decision.intent).toBe("hold");
    expect(decision.reason).toMatch(/no-position/);
  });
});

describe("decide — concentration, checked before the spread thresholds", () => {
  it("withdraws when one subscriber's share of the pool exceeds the max, without blocking a future subscription", () => {
    const decision = decide(
      { ...baseInputs, capacityPool: 10_000_000n, totalShares: 5_000_000n, maxNotional: 6_000_000n, totalNotional: 6_000_000n },
      defaultTuning,
    );
    expect(decision.intent).toBe("withdraw");
    expect(decision.reason).toMatch(/concentration/);
    expect(decision.concentrationWad).toBe(600_000_000_000_000_000n); // 60%
    expect(decision.withdrawShareAmount).toBe(500_000n); // 10% of 5,000,000 owned shares
    expect(decision.wouldBlockSubscriptions).toBe(false);
  });

  it("flags wouldBlockSubscriptions when the same withdrawal would leave the pool below the concentrated subscriber's notional", () => {
    // capacityPool 6,500,000 / totalShares 5,000,000 (price 1.3); withdrawing 10% of 5,000,000
    // owned shares (500,000 shares) returns floor(500,000*6,500,000/5,000,000) = 650,000,
    // leaving 5,850,000 -- below maxNotional 6,000,000. The full, undiminished withdrawal is
    // still returned; it is not silently shrunk to avoid the flag.
    const decision = decide(
      { ...baseInputs, capacityPool: 6_500_000n, totalShares: 5_000_000n, maxNotional: 6_000_000n, totalNotional: 6_000_000n },
      defaultTuning,
    );
    expect(decision.intent).toBe("withdraw");
    expect(decision.withdrawShareAmount).toBe(500_000n);
    expect(decision.wouldBlockSubscriptions).toBe(true);
  });
});

describe("decide — spread thresholds", () => {
  it("posts more capacity once spread clears the post threshold", () => {
    const decision = decide({ ...baseInputs, spreadWad: 60_000_000_000_000_000n }, defaultTuning); // +6%
    expect(decision.intent).toBe("post");
    expect(decision.postAmountUsdc).toBe(1_000_000n);
    expect(decision.wouldBlockSubscriptions).toBe(false);
  });

  it("posts at the exact threshold (>=, not >)", () => {
    const decision = decide({ ...baseInputs, spreadWad: 50_000_000_000_000_000n }, defaultTuning);
    expect(decision.intent).toBe("post");
  });

  it("withdraws once spread is at or below the withdraw threshold", () => {
    const decision = decide({ ...baseInputs, spreadWad: -30_000_000_000_000_000n }, defaultTuning); // -3%
    expect(decision.intent).toBe("withdraw");
    expect(decision.reason).toMatch(/cheap relative to realized/);
  });

  it("withdraws at the exact threshold (<=, not <)", () => {
    const decision = decide({ ...baseInputs, spreadWad: -20_000_000_000_000_000n }, defaultTuning);
    expect(decision.intent).toBe("withdraw");
  });

  it("holds within the neutral band between the two thresholds", () => {
    const decision = decide({ ...baseInputs, spreadWad: 0n }, defaultTuning);
    expect(decision.intent).toBe("hold");
    expect(decision.reason).toMatch(/neutral band/);
  });

  it("flags wouldBlockSubscriptions on a spread-driven withdrawal too, not only a concentration-driven one", () => {
    const looseTuning: PolicyTuning = { ...defaultTuning, maxConcentrationWad: 990_000_000_000_000_000n }; // 99%, so concentration doesn't fire first
    const decision = decide(
      {
        ...baseInputs,
        capacityPool: 6_500_000n,
        totalShares: 5_000_000n,
        maxNotional: 6_000_000n,
        totalNotional: 6_000_000n,
        spreadWad: -30_000_000_000_000_000n,
      },
      looseTuning,
    );
    expect(decision.intent).toBe("withdraw");
    expect(decision.reason).toMatch(/cheap relative to realized/);
    expect(decision.withdrawShareAmount).toBe(500_000n);
    expect(decision.wouldBlockSubscriptions).toBe(true);
  });
});

describe("decide — utilization/concentration are always reported, even on hold", () => {
  it("computes concentrationWad and utilizationWad on a plain hold decision", () => {
    const decision = decide(baseInputs, defaultTuning);
    // maxNotional 1,000,000 / capacityPool 5,889,412
    expect(decision.concentrationWad).toBeGreaterThan(0n);
    expect(decision.utilizationWad).toBe(decision.concentrationWad); // equal here: totalNotional === maxNotional in baseInputs
  });
});
