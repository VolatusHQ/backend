import { describe, expect, it } from "vitest";
import { computeTarget, computeTargetNotionalFromWeight, computeTargetRate } from "./pricing.js";
import type { Mandate } from "./mandate.js";

const mandate: Mandate = {
  id: "test",
  owner: "0x7975E591c26e6c6D9B0CFd9A81f6d61A921C080c",
  poolId: "0xc60f25d0a8e2ec722cc0d7f2cff8179340bd5a034351319ada88292d23f21b89",
  epochId: 2n,
  streamAddress: "0x6C35BEC76B7c43DDdbF0b46E3402D1461b4233D9",
  usdcAddress: "0x3600000000000000000000000000000000000000",
  baseRatePerSecond: 100n,
  referenceIvWad: 10n ** 18n, // 100% annualized
  maxRatePerSecond: 1_000n,
  baseCoverageNotional: 4_000_000n,
  maxCoverageNotional: 8_000_000n,
  driftToleranceBps: 500,
  runwayFloorSeconds: 300n,
  fundTopUpUsdc: 1_000_000n,
  maxCumulativeSpendUsdc: 5_000_000n,
  expiresAt: 2_000_000_000n,
};

describe("computeTargetRate — linear in ivWad / referenceIvWad", () => {
  it("returns exactly baseRatePerSecond at the reference IV", () => {
    expect(computeTargetRate(mandate, mandate.referenceIvWad)).toBe(100n);
  });

  it("scales down proportionally below the reference IV (the live measured case: 55.93% of 100%)", () => {
    // 100 * 559336341441482646 / 1e18 = 55.9336... -> floors to 55.
    expect(computeTargetRate(mandate, 559_336_341_441_482_646n)).toBe(55n);
  });

  it("scales up proportionally above the reference IV, capped at maxRatePerSecond", () => {
    expect(computeTargetRate(mandate, 20n * 10n ** 18n)).toBe(mandate.maxRatePerSecond); // 20x IV would be 2000, capped at 1000
  });

  it("never returns zero even at ivWad = 0 — ZeroRate must never be sent", () => {
    expect(computeTargetRate(mandate, 0n)).toBe(1n);
  });

  it("throws rather than dividing by zero if a mandate is misconfigured with referenceIvWad = 0", () => {
    expect(() => computeTargetRate({ ...mandate, referenceIvWad: 0n }, 10n ** 18n)).toThrow();
  });
});

describe("computeTargetNotionalFromWeight — linear in positionWeightWad", () => {
  it("returns baseCoverageNotional at full weight (capped by capacityPool if lower)", () => {
    expect(computeTargetNotionalFromWeight(mandate, 10n ** 18n, 100_000_000n)).toBe(mandate.baseCoverageNotional);
  });

  it("scales down proportionally at partial weight", () => {
    expect(computeTargetNotionalFromWeight(mandate, 10n ** 17n, 100_000_000n)).toBe(400_000n); // 10% of 4_000_000
  });

  it("is zero at zero weight (out of range, or no pool liquidity)", () => {
    expect(computeTargetNotionalFromWeight(mandate, 0n, 100_000_000n)).toBe(0n);
  });

  it("a mandate cap refuses an over-cap notional even at full weight", () => {
    const rich = { ...mandate, baseCoverageNotional: 50_000_000n };
    expect(computeTargetNotionalFromWeight(rich, 10n ** 18n, 100_000_000n)).toBe(rich.maxCoverageNotional);
  });

  it("the live capacityPool refuses an over-capacity notional even under the mandate's own cap", () => {
    expect(computeTargetNotionalFromWeight(mandate, 10n ** 18n, 1_000_000n)).toBe(1_000_000n);
  });
});

describe("computeTarget — the combined target the tick loop compares against the live subscription", () => {
  it("holds the current notional steady (does not zero it) when no position was found", () => {
    const target = computeTarget({
      mandate,
      ivWad: mandate.referenceIvWad,
      positionFound: false,
      positionWeightWad: 0n,
      capacityPool: 100_000_000n,
      currentCoverageNotional: 4_000_000n,
    });
    expect(target.coverageNotional).toBe(4_000_000n);
    expect(target.ratePerSecond).toBe(100n);
  });

  it("still re-clamps the held-steady notional against a capacityPool that shrank below it", () => {
    const target = computeTarget({
      mandate,
      ivWad: mandate.referenceIvWad,
      positionFound: false,
      positionWeightWad: 0n,
      capacityPool: 500_000n,
      currentCoverageNotional: 4_000_000n,
    });
    expect(target.coverageNotional).toBe(500_000n);
  });

  it("sizes notional from position weight when a position was found", () => {
    const target = computeTarget({
      mandate,
      ivWad: mandate.referenceIvWad,
      positionFound: true,
      positionWeightWad: 5n * 10n ** 17n, // 50%
      capacityPool: 100_000_000n,
      currentCoverageNotional: 999_999n, // ignored — a position was found
    });
    expect(target.coverageNotional).toBe(2_000_000n);
  });
});
