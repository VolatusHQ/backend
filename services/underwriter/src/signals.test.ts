import { describe, expect, it } from "vitest";
import { evaluateMarketSignal, type MarketReads } from "./signals.js";

const base: MarketReads = {
  oracleOk: true,
  impliedVolWad: 559_336_341_441_482_646n, // live-verified figure, 2026-09-05: 55.93%
  realizedVolWad: 0n,
  hasActiveEpoch: true,
  accumulatorNow: 1_000n,
  startAccumulator: 1_000n, // unchanged -- the live edge case
  observations: 8,
};

describe("evaluateMarketSignal — the hard rules from BACKEND_HANDOFF.md and the live edge case", () => {
  it("holds with no spread when tryImpliedVol reports ok=false, regardless of everything else", () => {
    const signal = evaluateMarketSignal({ ...base, oracleOk: false, impliedVolWad: 0n, accumulatorNow: 5_000n });
    expect(signal.dataSufficient).toBe(false);
    expect(signal.spreadWad).toBeNull();
  });

  it("REGRESSION (live 2026-09-05 state): ok=true and realizedVol=0 is NOT a screaming buy signal", () => {
    // Exactly today's live reads: oracle healthy, but nothing has swapped on the measured
    // pool since the active epoch opened -- accumulatorNow === startAccumulator. A
    // ratio-based spread would divide by zero here; this must come back as insufficient
    // data, not as "spread = full implied vol, maximally attractive."
    const signal = evaluateMarketSignal(base);
    expect(signal.oracleOk).toBe(true);
    expect(signal.realizedVolWad).toBe(0n);
    expect(signal.dataSufficient).toBe(false);
    expect(signal.spreadWad).toBeNull();
  });

  it("is insufficient when there is no active epoch at all, even if the oracle is otherwise healthy", () => {
    const signal = evaluateMarketSignal({ ...base, hasActiveEpoch: false, accumulatorNow: 9_999n, startAccumulator: 0n });
    expect(signal.dataSufficient).toBe(false);
    expect(signal.spreadWad).toBeNull();
  });

  it("is sufficient once the accumulator has moved since the epoch opened, and computes a signed difference", () => {
    const signal = evaluateMarketSignal({
      ...base,
      realizedVolWad: 300_000_000_000_000_000n, // 30%
      accumulatorNow: 1_500n, // moved past startAccumulator
    });
    expect(signal.dataSufficient).toBe(true);
    // 55.9336341441482646% - 30% = 25.9336341441482646%
    expect(signal.spreadWad).toBe(259_336_341_441_482_646n);
  });

  it("computes a negative spread (implied cheap relative to realized) without throwing or flooring at zero", () => {
    const signal = evaluateMarketSignal({
      ...base,
      impliedVolWad: 100_000_000_000_000_000n, // 10%
      realizedVolWad: 400_000_000_000_000_000n, // 40%
      accumulatorNow: 2_000n,
    });
    expect(signal.dataSufficient).toBe(true);
    expect(signal.spreadWad).toBe(-300_000_000_000_000_000n);
  });

  it("treats accumulator strictly greater than (not >=) startAccumulator as the sufficiency bar", () => {
    const signal = evaluateMarketSignal({ ...base, accumulatorNow: 1_000n, startAccumulator: 1_000n });
    expect(signal.dataSufficient).toBe(false);
  });
});
