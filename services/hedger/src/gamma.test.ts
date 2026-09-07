import { describe, expect, it } from "vitest";
import { computePositionSignal, NO_POSITION } from "./gamma.js";

describe("computePositionSignal", () => {
  it("returns NO_POSITION (found: false) when no position was found", () => {
    expect(computePositionSignal(null, 50_000n, 58)).toEqual(NO_POSITION);
  });

  it("weights an in-range position by its share of pool liquidity", () => {
    const signal = computePositionSignal({ liquidity: 5_000n, tickLower: -60, tickUpper: 60 }, 50_000n, 0);
    expect(signal.found).toBe(true);
    expect(signal.inRange).toBe(true);
    expect(signal.positionWeightWad).toBe(10n ** 17n); // 5_000 / 50_000 = 0.1 = 1e17 WAD
  });

  it("zeroes the weight when the current tick is below the position's range", () => {
    const signal = computePositionSignal({ liquidity: 5_000n, tickLower: 100, tickUpper: 200 }, 50_000n, 58);
    expect(signal.found).toBe(true);
    expect(signal.inRange).toBe(false);
    expect(signal.positionWeightWad).toBe(0n);
  });

  it("zeroes the weight when the current tick is at or above the position's upper bound (upper is exclusive)", () => {
    const signal = computePositionSignal({ liquidity: 5_000n, tickLower: -60, tickUpper: 60 }, 50_000n, 60);
    expect(signal.inRange).toBe(false);
    expect(signal.positionWeightWad).toBe(0n);
  });

  it("treats the lower bound as inclusive", () => {
    const signal = computePositionSignal({ liquidity: 5_000n, tickLower: -60, tickUpper: 60 }, 50_000n, -60);
    expect(signal.inRange).toBe(true);
  });

  it("never exceeds WAD even if a position somehow reports more liquidity than the pool total", () => {
    const signal = computePositionSignal({ liquidity: 60_000n, tickLower: -60, tickUpper: 60 }, 50_000n, 0);
    expect(signal.positionWeightWad).toBe(10n ** 18n);
  });

  it("does not divide by zero when the pool reports zero liquidity", () => {
    const signal = computePositionSignal({ liquidity: 5_000n, tickLower: -60, tickUpper: 60 }, 0n, 0);
    expect(signal.positionWeightWad).toBe(0n);
  });
});
