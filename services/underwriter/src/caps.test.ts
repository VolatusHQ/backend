import { describe, expect, it } from "vitest";
import { openJournal } from "@volatus/service-kit";
import { checkSpendCap, loadSpendHistory, recordSpend, type SpendCapTuning, type SpendRecord } from "./caps.js";

const tuning: SpendCapTuning = { perTxCapUsdc: 1, periodCapUsdc: 5, periodSeconds: 86_400 };

describe("checkSpendCap — enforced in our own code, since Circle's spending policy is mainnet-only", () => {
  it("refuses a single proposed spend over the per-tx cap, even with no history at all", () => {
    const decision = checkSpendCap(tuning, [], 1_000_000, 1.5);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/per-transaction cap/);
  });

  it("allows a spend under both caps with empty history", () => {
    const decision = checkSpendCap(tuning, [], 1_000_000, 0.5);
    expect(decision.allowed).toBe(true);
    expect(decision.remainingInPeriod).toBe(5);
  });

  it("refuses once cumulative spend in the rolling window would exceed the period cap", () => {
    // The proposal has to clear the per-transaction cap to reach the rolling
    // check at all -- perTxCap is 1, so anything above that is refused by the
    // first gate and never exercises this one. Hence 4.5 of history and a
    // proposal of exactly 1: allowed per-transaction, but 5.5 against a
    // period cap of 5.
    const history: SpendRecord[] = [
      { atSeconds: 999_000, amountUsdc: 2 },
      { atSeconds: 999_500, amountUsdc: 2.5 },
    ];
    const atCap = checkSpendCap(tuning, history, 1_000_000, 0.5);
    expect(atCap.allowed).toBe(true);
    const overCap = checkSpendCap(tuning, history, 1_000_000, 1);
    expect(overCap.allowed).toBe(false);
    expect(overCap.reason).toMatch(/rolling 86400s cap/);
  });

  it("excludes spends outside the rolling window from the running total", () => {
    const longAgo: SpendRecord[] = [{ atSeconds: 1_000_000 - 100_000, amountUsdc: 5 }]; // outside an 86,400s window
    const decision = checkSpendCap(tuning, longAgo, 1_000_000, 1);
    expect(decision.allowed).toBe(true);
    expect(decision.spentInPeriod).toBe(0);
  });

  it("a spend exactly at the window boundary (atSeconds === windowStart) is excluded (strictly greater-than)", () => {
    const boundary: SpendRecord[] = [{ atSeconds: 1_000_000 - 86_400, amountUsdc: 5 }];
    const decision = checkSpendCap(tuning, boundary, 1_000_000, 1);
    expect(decision.spentInPeriod).toBe(0);
    expect(decision.allowed).toBe(true);
  });
});

describe("recordSpend / loadSpendHistory — the journal-backed half of the cap", () => {
  it("round-trips a recorded spend through the journal", () => {
    const journal = openJournal(":memory:");
    recordSpend(journal, "0xaaaa", 1, 1_000_000);
    recordSpend(journal, "0xbbbb", 0.5, 1_000_100);
    const history = loadSpendHistory(journal);
    expect(history).toHaveLength(2);
    expect(history.reduce((sum, r) => sum + r.amountUsdc, 0)).toBe(1.5);
    journal.close();
  });

  it("a fresh journal has no spend history", () => {
    const journal = openJournal(":memory:");
    expect(loadSpendHistory(journal)).toEqual([]);
    journal.close();
  });

  it("an over-cap post is refused end to end: record one spend, then check a second against the live history", () => {
    const journal = openJournal(":memory:");
    recordSpend(journal, "0xcccc", 4.5, 1_000_000);
    const decision = checkSpendCap(tuning, loadSpendHistory(journal), 1_000_050, 1);
    expect(decision.allowed).toBe(false);
    expect(decision.remainingInPeriod).toBeCloseTo(0.5, 10);
    journal.close();
  });
});
