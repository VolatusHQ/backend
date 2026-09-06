import { describe, expect, it } from "vitest";
import { projectSubscription } from "./project.js";

describe("projectSubscription — matches the on-chain _sync arithmetic", () => {
  it("reproduces the real measured sync exactly (BRIEF.md § Measured)", () => {
    // subscription(2, 0x7975E5…080c) before the measured sync tx:
    // ratePerSecond 100, funded 2000000, lastSync 1788562735, coveredSeconds 0.
    // The tx elapsed 221s: coveredSeconds 0 -> 221, funded -22100 (-> 1977900),
    // capacityPool +22100, runwaySeconds 20000 -> 19779.
    const before = {
      ratePerSecond: 100n,
      funded: 2_000_000n,
      lastSync: 1_788_562_735n,
      coveredSeconds: 0n,
    };
    const nowTs = 1_788_562_735n + 221n;
    const coverageEnd = 1_789_153_388n; // epoch(2).coverageEnd — nowhere near hit

    const projected = projectSubscription(before, nowTs, coverageEnd);

    expect(projected.elapsedSeconds).toBe(221n);
    expect(projected.paidSeconds).toBe(221n);
    expect(projected.accruedPremium).toBe(22_100n);
    expect(projected.funded).toBe(1_977_900n);
    expect(projected.coveredSeconds).toBe(221n);
    expect(projected.ranDry).toBe(false);
    expect(projected.runwaySeconds).toBe(19_779n);
    expect(projected.asOf).toBe(nowTs);
  });

  it("is a no-op when nothing has elapsed since lastSync (mirrors _sync's early return)", () => {
    const sub = { ratePerSecond: 100n, funded: 500n, lastSync: 1000n, coveredSeconds: 3n };
    const projected = projectSubscription(sub, 1000n, 2000n);

    expect(projected.elapsedSeconds).toBe(0n);
    expect(projected.paidSeconds).toBe(0n);
    expect(projected.accruedPremium).toBe(0n);
    expect(projected.funded).toBe(500n);
    expect(projected.coveredSeconds).toBe(3n);
    expect(projected.ranDry).toBe(false);
  });

  it("caps accrual at funded when the balance runs dry partway through (the branch that is not the naive design)", () => {
    // 10s elapsed at rate 100 = 1000 owed, but only 750 is funded.
    // floor(750 / 100) = 7 paid seconds, 700 premium, 50 left over (< one
    // second's rate) — exactly `_sync`'s "ran dry partway" branch.
    const sub = { ratePerSecond: 100n, funded: 750n, lastSync: 1000n, coveredSeconds: 5n };
    const projected = projectSubscription(sub, 1010n, 5000n);

    expect(projected.elapsedSeconds).toBe(10n);
    expect(projected.paidSeconds).toBe(7n);
    expect(projected.accruedPremium).toBe(700n);
    expect(projected.funded).toBe(50n);
    expect(projected.coveredSeconds).toBe(12n);
    expect(projected.ranDry).toBe(true);
    expect(projected.runwaySeconds).toBe(0n); // 50 / 100, floor
  });

  it("clamps accrual at coverageEnd — time past the epoch's end never accrues", () => {
    const sub = { ratePerSecond: 10n, funded: 1_000_000n, lastSync: 100n, coveredSeconds: 0n };
    const projected = projectSubscription(sub, 5_000n, 200n); // now is far past coverageEnd

    expect(projected.asOf).toBe(200n);
    expect(projected.elapsedSeconds).toBe(100n); // 200 - 100, not 5000 - 100
    expect(projected.paidSeconds).toBe(100n);
    expect(projected.accruedPremium).toBe(1_000n);
    expect(projected.funded).toBe(999_000n);
  });

  it("a cancelled subscription (ratePerSecond 0) never accrues, regardless of stored funded", () => {
    const sub = { ratePerSecond: 0n, funded: 500n, lastSync: 100n, coveredSeconds: 9n };
    const projected = projectSubscription(sub, 10_000n, 20_000n);

    expect(projected.elapsedSeconds).toBe(0n);
    expect(projected.funded).toBe(500n);
    expect(projected.coveredSeconds).toBe(9n);
    expect(projected.runwaySeconds).toBe(0n);
  });

  it("a subscription that has already run fully dry keeps returning zero runway on repeated projection", () => {
    const sub = { ratePerSecond: 100n, funded: 0n, lastSync: 1000n, coveredSeconds: 50n };
    const projected = projectSubscription(sub, 2000n, 5000n);

    expect(projected.paidSeconds).toBe(0n);
    expect(projected.accruedPremium).toBe(0n);
    expect(projected.ranDry).toBe(true); // elapsed (1000) > paid (0)
    expect(projected.runwaySeconds).toBe(0n);
  });
});
