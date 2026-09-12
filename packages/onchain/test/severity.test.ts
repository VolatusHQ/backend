import { describe, expect, it } from "vitest";
import {
  computeVolSeverity,
  formatSeverityLabel,
  percentileRank,
  richnessFromSpread,
  tierFromPercentile,
  TIER_THRESHOLDS,
  type VolSeverity,
} from "../src/severity.js";

describe("percentileRank", () => {
  it("no trailing history -> 0.5 (typical), never an asserted extreme", () => {
    expect(percentileRank(100n, [])).toBe(0.5);
  });

  it("current value below every sample -> 0", () => {
    expect(percentileRank(1n, [10n, 20n, 30n])).toBe(0);
  });

  it("current value above every sample -> 1", () => {
    expect(percentileRank(100n, [10n, 20n, 30n])).toBe(1);
  });

  it("current value in the middle -> the fraction strictly below it", () => {
    expect(percentileRank(20n, [10n, 20n, 30n, 40n])).toBe(0.25); // only 10n is strictly below
  });

  it("a value equal to every sample is not counted as below (strict inequality)", () => {
    expect(percentileRank(10n, [10n, 10n, 10n])).toBe(0);
  });
});

describe("tierFromPercentile", () => {
  it("boundaries land on the documented side of each cut point", () => {
    expect(tierFromPercentile(0)).toBe("very-low");
    expect(tierFromPercentile(TIER_THRESHOLDS.veryLow - 0.001)).toBe("very-low");
    expect(tierFromPercentile(TIER_THRESHOLDS.veryLow)).toBe("low");
    expect(tierFromPercentile(TIER_THRESHOLDS.low - 0.001)).toBe("low");
    expect(tierFromPercentile(TIER_THRESHOLDS.low)).toBe("typical");
    expect(tierFromPercentile(TIER_THRESHOLDS.high - 0.001)).toBe("typical");
    expect(tierFromPercentile(TIER_THRESHOLDS.high)).toBe("high");
    expect(tierFromPercentile(TIER_THRESHOLDS.extreme - 0.001)).toBe("high");
    expect(tierFromPercentile(TIER_THRESHOLDS.extreme)).toBe("extreme");
    expect(tierFromPercentile(1)).toBe("extreme");
  });
});

describe("richnessFromSpread", () => {
  const defaults = { postSpreadThresholdWad: 50_000_000_000_000_000n, withdrawSpreadThresholdWad: -20_000_000_000_000_000n };

  it("dataSufficient=false -> insufficient-data regardless of the spread value", () => {
    expect(richnessFromSpread(100n, false)).toBe("insufficient-data");
    expect(richnessFromSpread(null, false)).toBe("insufficient-data");
  });

  it("spreadWad=null -> insufficient-data even if dataSufficient were somehow true", () => {
    expect(richnessFromSpread(null, true)).toBe("insufficient-data");
  });

  it("spread at or above the post threshold -> rich", () => {
    expect(richnessFromSpread(defaults.postSpreadThresholdWad, true)).toBe("rich");
    expect(richnessFromSpread(defaults.postSpreadThresholdWad + 1n, true)).toBe("rich");
  });

  it("spread at or below the withdraw threshold -> cheap", () => {
    expect(richnessFromSpread(defaults.withdrawSpreadThresholdWad, true)).toBe("cheap");
    expect(richnessFromSpread(defaults.withdrawSpreadThresholdWad - 1n, true)).toBe("cheap");
  });

  it("spread strictly inside the neutral band -> neutral", () => {
    expect(richnessFromSpread(0n, true)).toBe("neutral");
  });
});

describe("computeVolSeverity + formatSeverityLabel", () => {
  it("combines magnitude and richness into one label", () => {
    const severity: VolSeverity = computeVolSeverity({
      currentImpliedVolWad: 900n,
      trailingImpliedVolWad: [100n, 200n, 300n, 400n, 500n, 600n, 700n, 800n],
      spreadWad: 60_000_000_000_000_000n, // above the +5% default post threshold
      dataSufficient: true,
    });
    expect(severity.tier).toBe("extreme"); // above every trailing sample -> percentile 1
    expect(severity.richness).toBe("rich");
    expect(formatSeverityLabel(severity)).toBe("Extreme · pricing rich");
  });

  it("never fabricates a richness qualifier when data is insufficient", () => {
    const severity = computeVolSeverity({
      currentImpliedVolWad: 500n,
      trailingImpliedVolWad: [100n, 900n],
      spreadWad: null,
      dataSufficient: false,
    });
    expect(severity.richness).toBe("insufficient-data");
    expect(formatSeverityLabel(severity)).toMatch(/not enough data yet$/);
  });

  it("a neutral-band spread renders the bare tier label with no qualifier", () => {
    const severity = computeVolSeverity({
      currentImpliedVolWad: 500n,
      trailingImpliedVolWad: [100n, 200n, 300n, 400n, 600n, 700n, 800n, 900n],
      spreadWad: 0n,
      dataSufficient: true,
    });
    expect(formatSeverityLabel(severity)).toBe("Typical");
  });
});
