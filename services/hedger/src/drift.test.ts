import { describe, expect, it } from "vitest";
import { shouldAdjust } from "./drift.js";

describe("shouldAdjust", () => {
  it("never adjusts when there is no live subscription (ratePerSecond 0)", () => {
    const decision = shouldAdjust({ ratePerSecond: 0n, coverageNotional: 0n }, { ratePerSecond: 500n, coverageNotional: 1_000_000n }, 500);
    expect(decision.due).toBe(false);
    expect(decision.reason).toBe("not-subscribed");
  });

  it("does not adjust when drift is below tolerance", () => {
    // 100 -> 103 is 300 bps (3%), under a 500 bps (5%) tolerance.
    const decision = shouldAdjust({ ratePerSecond: 100n, coverageNotional: 4_000_000n }, { ratePerSecond: 103n, coverageNotional: 4_000_000n }, 500);
    expect(decision.due).toBe(false);
    expect(decision.reason).toBe("within-tolerance");
    expect(decision.rateDriftBps).toBe(300);
  });

  it("adjusts once rate drift exceeds tolerance", () => {
    // 100 -> 55 is 4500 bps (45%), over a 500 bps tolerance -- the live measured case.
    const decision = shouldAdjust({ ratePerSecond: 100n, coverageNotional: 4_000_000n }, { ratePerSecond: 55n, coverageNotional: 4_000_000n }, 500);
    expect(decision.due).toBe(true);
    expect(decision.reason).toBe("rate-drift");
    expect(decision.rateDriftBps).toBe(4_500);
  });

  it("adjusts on notional drift alone even when rate is unchanged", () => {
    const decision = shouldAdjust(
      { ratePerSecond: 100n, coverageNotional: 4_000_000n },
      { ratePerSecond: 100n, coverageNotional: 2_000_000n },
      500,
    );
    expect(decision.due).toBe(true);
    expect(decision.reason).toBe("notional-drift");
    expect(decision.notionalDriftBps).toBe(5_000);
  });

  it("rate drift is checked (and reported) before notional drift when both exceed tolerance", () => {
    const decision = shouldAdjust(
      { ratePerSecond: 100n, coverageNotional: 4_000_000n },
      { ratePerSecond: 200n, coverageNotional: 8_000_000n },
      500,
    );
    expect(decision.due).toBe(true);
    expect(decision.reason).toBe("rate-drift");
  });

  it("a drift exactly at the tolerance boundary does not fire (strictly greater-than)", () => {
    // 100 -> 105 is exactly 500 bps.
    const decision = shouldAdjust({ ratePerSecond: 100n, coverageNotional: 4_000_000n }, { ratePerSecond: 105n, coverageNotional: 4_000_000n }, 500);
    expect(decision.due).toBe(false);
  });
});
