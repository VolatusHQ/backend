import { describe, expect, it } from "vitest";
import { shouldSync } from "./gate.js";

const baseInputs = {
  coverageEnd: 1_789_153_388n,
  gasCostEstimateUsdc: 1_722n, // ~0.001722 USDC, BRIEF.md's measured cost
  safetyFactor: 10,
  maxSyncIntervalSeconds: 3_600n,
  epochEndMarginSeconds: 120n,
  drainMarginSeconds: 120n,
};

describe("shouldSync — the gate that is not the handoff's naive 'every 30-60s' design", () => {
  it("suppresses an uneconomic sync: a 30s tick at ratePerSecond 100 accrues far less than 10x gas", () => {
    // 30s * 100 = 3000 accrued (0.003 USDC) vs 17220 threshold (10x 1722) — BRIEF.md's
    // own worked example ("57% overhead" at this rate/interval).
    const decision = shouldSync({
      ...baseInputs,
      projected: { elapsedSeconds: 30n, accruedPremium: 3_000n, runwaySeconds: 19_700n, asOf: 1_000_000n },
    });
    expect(decision.due).toBe(false);
    expect(decision.reason).toBe("below-threshold");
    expect(decision.coverageRatio).toBeCloseTo(3000 / 1722, 5);
  });

  it("permits an economic sync once accrued premium clears the safety factor", () => {
    // 172200 accrued vs threshold 17220 (10x) — comfortably over.
    const decision = shouldSync({
      ...baseInputs,
      projected: { elapsedSeconds: 1_722n, accruedPremium: 172_200n, runwaySeconds: 18_000n, asOf: 1_000_000n },
    });
    expect(decision.due).toBe(true);
    expect(decision.reason).toBe("economic");
    expect(decision.coverageRatio).toBeGreaterThanOrEqual(10);
  });

  it("nothing-elapsed always wins, even if every other threshold would otherwise fire", () => {
    const decision = shouldSync({
      ...baseInputs,
      coverageEnd: 1_000_010n, // epoch ending imminently
      drainMarginSeconds: 999_999n, // draining threshold trivially satisfied
      projected: { elapsedSeconds: 0n, accruedPremium: 0n, runwaySeconds: 0n, asOf: 1_000_000n },
    });
    expect(decision.due).toBe(false);
    expect(decision.reason).toBe("nothing-elapsed");
  });

  it("fires the max-interval backstop even when nowhere near economic", () => {
    const decision = shouldSync({
      ...baseInputs,
      projected: { elapsedSeconds: 3_600n, accruedPremium: 100n, runwaySeconds: 50_000n, asOf: 1_000_000n },
    });
    expect(decision.due).toBe(true);
    expect(decision.reason).toBe("max-interval");
  });

  it("forces a sync when the epoch is about to end, before the economic bar would otherwise clear", () => {
    const coverageEnd = 1_000_050n;
    const decision = shouldSync({
      ...baseInputs,
      coverageEnd,
      maxSyncIntervalSeconds: 999_999n,
      projected: { elapsedSeconds: 10n, accruedPremium: 10n, runwaySeconds: 50_000n, asOf: coverageEnd - 60n },
    });
    expect(decision.due).toBe(true);
    expect(decision.reason).toBe("epoch-ending");
  });

  it("forces a sync when the subscription is about to drain, before the economic bar would otherwise clear", () => {
    const decision = shouldSync({
      ...baseInputs,
      maxSyncIntervalSeconds: 999_999n,
      coverageEnd: 999_999_999n,
      projected: { elapsedSeconds: 10n, accruedPremium: 10n, runwaySeconds: 60n, asOf: 1_000_000n },
    });
    expect(decision.due).toBe(true);
    expect(decision.reason).toBe("draining");
  });

  it("an infinite-cost-ratio fallback (zero gas estimate) is treated as trivially economic, not a divide-by-zero crash", () => {
    const decision = shouldSync({
      ...baseInputs,
      gasCostEstimateUsdc: 0n,
      projected: { elapsedSeconds: 5n, accruedPremium: 1n, runwaySeconds: 50_000n, asOf: 1_000_000n },
    });
    expect(decision.due).toBe(true);
    expect(decision.reason).toBe("economic");
    expect(decision.coverageRatio).toBe(Number.POSITIVE_INFINITY);
  });
});
