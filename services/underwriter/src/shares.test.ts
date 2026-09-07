import { describe, expect, it } from "vitest";
import { mulDivDown, projectPostCapacity, projectWithdrawal, sharePriceWad } from "./shares.js";

describe("mulDivDown — the primitive both contract-mirroring functions reduce to", () => {
  it("floors a non-exact division, same as Math.mulDiv (30 / 7 = 4.28... -> 4)", () => {
    expect(mulDivDown(10n, 3n, 7n)).toBe(4n);
  });

  it("is exact when the division has no remainder", () => {
    expect(mulDivDown(50n, 200n, 100n)).toBe(100n);
  });

  it("throws on a zero denominator rather than letting BigInt's own error through unremarked", () => {
    expect(() => mulDivDown(1n, 1n, 0n)).toThrow(/division by zero/);
  });

  it("rejects a negative operand — every quantity in this system is non-negative on-chain", () => {
    expect(() => mulDivDown(-1n, 1n, 1n)).toThrow(/negative/);
  });
});

describe("sharePriceWad", () => {
  it("reproduces the live, session-verified figure exactly (BRIEF.md: capacityPool 5,889,412 / totalShares 5,000,000)", () => {
    // 5,889,412 / 5,000,000 = 1.1778824 exactly -- verified by hand: 5,000,000 * 1.1778824 = 5,889,412.
    expect(sharePriceWad(5_889_412n, 5_000_000n)).toBe(1_177_882_400_000_000_000n);
  });

  it("is exactly 1.0 (1e18) when the pool has never earned or lost anything", () => {
    expect(sharePriceWad(5_000_000n, 5_000_000n)).toBe(1_000_000_000_000_000_000n);
  });

  it("is 0 (a sentinel, not a real quote) when no shares are outstanding yet", () => {
    expect(sharePriceWad(0n, 0n)).toBe(0n);
  });
});

describe("projectPostCapacity — mirrors postCapacity's mintedShares branch for branch", () => {
  it("mints 1:1 against an empty pool (the contract's capacityPool == 0 branch)", () => {
    expect(projectPostCapacity(1_000_000n, 0n, 0n)).toBe(1_000_000n);
  });

  it("mints proportionally once the pool has value (price > 1: fewer shares per USDC)", () => {
    // price is 2 (capacityPool 200 / totalShares 100) -- 50 in buys 25 shares.
    expect(projectPostCapacity(50n, 200n, 100n)).toBe(25n);
  });

  it("floors when the proportional mint is not exact (10 * 3 / 7 = 4.28... -> 4)", () => {
    expect(projectPostCapacity(10n, 7n, 3n)).toBe(4n);
  });

  it("is 0 for a 0 amount without touching the division at all", () => {
    expect(projectPostCapacity(0n, 500n, 200n)).toBe(0n);
  });
});

describe("projectWithdrawal — mirrors withdrawCapacity's amount calculation", () => {
  it("returns proportional capacity at a price of 1", () => {
    expect(projectWithdrawal(50n, 100n, 100n)).toBe(50n);
  });

  it("returns more than the share count once price has risen above 1", () => {
    // price is 2 (capacityPool 200 / totalShares 100) -- 25 shares redeem for 50.
    expect(projectWithdrawal(25n, 200n, 100n)).toBe(50n);
  });

  it("floors when the proportional redemption is not exact (1 * 7 / 3 = 2.33... -> 2)", () => {
    expect(projectWithdrawal(1n, 7n, 3n)).toBe(2n);
  });

  it("reproduces a full-pool withdrawal exactly: all shares redeem for the entire pool", () => {
    expect(projectWithdrawal(5_000_000n, 5_889_412n, 5_000_000n)).toBe(5_889_412n);
  });

  it("throws when totalShares is 0 -- the contract would panic (division by zero) too", () => {
    expect(() => projectWithdrawal(1n, 0n, 0n)).toThrow(/totalShares is 0/);
  });
});
