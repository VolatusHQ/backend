import { describe, expect, it } from "vitest";
import { shouldFund } from "./fundGate.js";
import type { Mandate } from "./mandate.js";

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

describe("shouldFund", () => {
  it("never funds when there is no live subscription", () => {
    const decision = shouldFund({ ratePerSecond: 0n, projected: { runwaySeconds: 0n }, mandate, cumulativeSpentUsdc: 0n });
    expect(decision.due).toBe(false);
    expect(decision.reason).toBe("not-subscribed");
  });

  it("does not fund while runway is above the floor", () => {
    const decision = shouldFund({ ratePerSecond: 100n, projected: { runwaySeconds: 500n }, mandate, cumulativeSpentUsdc: 0n });
    expect(decision.due).toBe(false);
    expect(decision.reason).toBe("sufficient-runway");
  });

  it("funds the configured top-up once runway falls to the floor", () => {
    const decision = shouldFund({ ratePerSecond: 100n, projected: { runwaySeconds: 300n }, mandate, cumulativeSpentUsdc: 0n });
    expect(decision.due).toBe(true);
    expect(decision.reason).toBe("runway-floor");
    expect(decision.amountUsdc).toBe(mandate.fundTopUpUsdc);
  });

  it("funds below the floor too", () => {
    const decision = shouldFund({ ratePerSecond: 100n, projected: { runwaySeconds: 0n }, mandate, cumulativeSpentUsdc: 0n });
    expect(decision.due).toBe(true);
  });

  it("a mandate cap refuses funding once the cumulative cap is already reached", () => {
    const decision = shouldFund({
      ratePerSecond: 100n,
      projected: { runwaySeconds: 0n },
      mandate,
      cumulativeSpentUsdc: mandate.maxCumulativeSpendUsdc,
    });
    expect(decision.due).toBe(false);
    expect(decision.reason).toBe("cumulative-cap-reached");
  });

  it("clamps the top-up amount to whatever remains of the cumulative cap", () => {
    const decision = shouldFund({
      ratePerSecond: 100n,
      projected: { runwaySeconds: 0n },
      mandate,
      cumulativeSpentUsdc: mandate.maxCumulativeSpendUsdc - 400_000n,
    });
    expect(decision.due).toBe(true);
    expect(decision.amountUsdc).toBe(400_000n); // less than fundTopUpUsdc (1_000_000)
  });
});
