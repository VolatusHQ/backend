import { describe, expect, it } from "vitest";
import { clampNotional, clampRate, mandateExpired, type Mandate } from "./mandate.js";

const mandate: Mandate = {
  id: "test",
  owner: "0x7975E591c26e6c6D9B0CFd9A81f6d61A921C080c",
  poolId: "0xc60f25d0a8e2ec722cc0d7f2cff8179340bd5a034351319ada88292d23f21b89",
  epochId: 2n,
  streamAddress: "0x6C35BEC76B7c43DDdbF0b46E3402D1461b4233D9",
  usdcAddress: "0x3600000000000000000000000000000000000000",
  baseRatePerSecond: 100n,
  referenceIvWad: 10n ** 18n,
  maxRatePerSecond: 1_000n,
  baseCoverageNotional: 4_000_000n,
  maxCoverageNotional: 8_000_000n,
  driftToleranceBps: 500,
  runwayFloorSeconds: 300n,
  fundTopUpUsdc: 1_000_000n,
  maxCumulativeSpendUsdc: 5_000_000n,
  expiresAt: 2_000_000_000n,
};

describe("mandateExpired", () => {
  it("is false before expiresAt and true at/after it", () => {
    expect(mandateExpired(mandate, mandate.expiresAt - 1n)).toBe(false);
    expect(mandateExpired(mandate, mandate.expiresAt)).toBe(true);
    expect(mandateExpired(mandate, mandate.expiresAt + 1n)).toBe(true);
  });
});

describe("clampRate — a mandate cap refuses an over-cap action", () => {
  it("passes a rate inside [1, maxRatePerSecond] through unchanged", () => {
    expect(clampRate(mandate, 500n)).toBe(500n);
  });

  it("floors a zero (or negative) rate at 1 — adjust() reverts ZeroRate on an actual 0", () => {
    expect(clampRate(mandate, 0n)).toBe(1n);
    expect(clampRate(mandate, -5n)).toBe(1n);
  });

  it("caps a rate above maxRatePerSecond at the mandate's declared maximum", () => {
    expect(clampRate(mandate, 999_999n)).toBe(mandate.maxRatePerSecond);
  });
});

describe("clampNotional — refuses both the mandate cap and live capacityPool, whichever binds tighter", () => {
  it("passes a notional under both caps through unchanged", () => {
    expect(clampNotional(mandate, 3_000_000n, 10_000_000n)).toBe(3_000_000n);
  });

  it("caps at maxCoverageNotional when capacityPool is larger", () => {
    expect(clampNotional(mandate, 50_000_000n, 100_000_000n)).toBe(mandate.maxCoverageNotional);
  });

  it("caps at the live capacityPool when it is the tighter bound (an underwriter withdrew)", () => {
    expect(clampNotional(mandate, 6_000_000n, 2_000_000n)).toBe(2_000_000n);
  });

  it("floors a negative notional at 0", () => {
    expect(clampNotional(mandate, -1n, 10_000_000n)).toBe(0n);
  });
});
