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

  it("owed exactly equal to funded takes the fully-paid branch, not the ran-dry one -- the boundary between the two", () => {
    // 10s * rate 100 = 1000 owed, funded is exactly 1000: `owed <= funded` is true on
    // equality, so this must land on the same branch as any other fully-paid tick
    // (paidSeconds == elapsedSeconds, funded lands at exactly 0) rather than the
    // integer-division "ran dry" branch, which would also compute 0 leftover here but
    // via the wrong path (and would disagree the moment funded is not an exact
    // multiple of rate).
    const sub = { ratePerSecond: 100n, funded: 1_000n, lastSync: 1_000n, coveredSeconds: 0n };
    const projected = projectSubscription(sub, 1_010n, 5_000n);

    expect(projected.elapsedSeconds).toBe(10n);
    expect(projected.paidSeconds).toBe(10n);
    expect(projected.accruedPremium).toBe(1_000n);
    expect(projected.funded).toBe(0n);
    expect(projected.ranDry).toBe(false); // paidSeconds === elapsedSeconds, not <
    expect(projected.runwaySeconds).toBe(0n);
  });

  it("a rate larger than the entire funded balance pays for zero seconds, not a fraction rounded up", () => {
    // 1s elapsed at rate 100, but only 40 is funded: floor(40/100) = 0 seconds
    // buyable even though *some* money is there and *some* time elapsed.
    const sub = { ratePerSecond: 100n, funded: 40n, lastSync: 1_000n, coveredSeconds: 0n };
    const projected = projectSubscription(sub, 1_001n, 5_000n);

    expect(projected.elapsedSeconds).toBe(1n);
    expect(projected.paidSeconds).toBe(0n);
    expect(projected.accruedPremium).toBe(0n);
    expect(projected.funded).toBe(40n); // untouched -- nothing was actually billable
    expect(projected.ranDry).toBe(true);
  });

  it("lastSync already at or past coverageEnd (a fully wound-down epoch) is a no-op, never a negative elapsed", () => {
    // Mirrors real state: subscription(3, deployer) on the live Arc stream has
    // lastSync == coverageEnd exactly (claim() synced it all the way through).
    // asOf clamps to coverageEnd, so asOf <= lastSync and _sync's early return fires --
    // this must never compute a negative elapsedSeconds by subtracting past asOf.
    const coverageEnd = 1_788_593_531n;
    const sub = { ratePerSecond: 1_000n, funded: 0n, lastSync: coverageEnd, coveredSeconds: 831n };
    const projected = projectSubscription(sub, coverageEnd + 2_063n, coverageEnd);

    expect(projected.asOf).toBe(coverageEnd);
    expect(projected.elapsedSeconds).toBe(0n);
    expect(projected.paidSeconds).toBe(0n);
    expect(projected.accruedPremium).toBe(0n);
    expect(projected.coveredSeconds).toBe(831n);
    expect(projected.runwaySeconds).toBe(0n);
  });

  it("lastSync strictly after coverageEnd (an inconsistent read, e.g. mid-reorg) still never accrues backwards", () => {
    // Not reachable from a real `_sync` (which always clamps lastSync to
    // coverageEnd), but the projection must stay safe if it is ever handed a read
    // like this rather than deriving a negative elapsedSeconds.
    const coverageEnd = 1_000n;
    const sub = { ratePerSecond: 50n, funded: 10_000n, lastSync: 1_500n, coveredSeconds: 0n };
    const projected = projectSubscription(sub, 2_000n, coverageEnd);

    expect(projected.asOf).toBe(coverageEnd);
    expect(projected.elapsedSeconds).toBe(0n);
    expect(projected.accruedPremium).toBe(0n);
    expect(projected.funded).toBe(10_000n);
  });

  describe("cross-checked against the live Arc stream (BRIEF.md, 2026-09-05)", () => {
    it("epoch 2's subscription: fully drained (funded 0), projecting forward changes nothing further", () => {
      // Live read via cast, SIGMA_STREAM 0x6C35BEC7...4233D9, epoch 2:
      //   subscription(2, 0x7975E5...080c) = (ratePerSecond 100, coverageNotional
      //   4000000, funded 0, lastSync 1788593175, coveredSeconds 20000, claimed false)
      //   epoch(2).coverageEnd = 1789153388. runwaySeconds(2, ...) reads 0 on-chain.
      const sub = { ratePerSecond: 100n, funded: 0n, lastSync: 1_788_593_175n, coveredSeconds: 20_000n };
      const nowTs = 1_788_595_594n; // chain block timestamp at the moment of the read
      const coverageEnd = 1_789_153_388n;

      const projected = projectSubscription(sub, nowTs, coverageEnd);

      // Already dry on-chain: any further elapsed time buys zero additional seconds.
      expect(projected.paidSeconds).toBe(0n);
      expect(projected.accruedPremium).toBe(0n);
      expect(projected.funded).toBe(0n);
      expect(projected.coveredSeconds).toBe(20_000n); // unchanged from the on-chain value
      expect(projected.ranDry).toBe(true);
      expect(projected.runwaySeconds).toBe(0n);
    });

    it("epoch 3's subscription: claimed and fully synced through coverageEnd, projection is an exact no-op", () => {
      // Live read via cast, epoch 3 (reported, payoffWad 1e18, claimed):
      //   subscription(3, 0x7975E5...080c) = (ratePerSecond 1000, coverageNotional
      //   2000000, funded 0, lastSync 1788593531, coveredSeconds 831, claimed true)
      //   epoch(3).coverageEnd = 1788593531 -- lastSync == coverageEnd exactly,
      //   because claim()'s internal _sync ran the balance all the way through.
      //   runwaySeconds(3, ...) reads 0 on-chain, matching this projection.
      const sub = { ratePerSecond: 1_000n, funded: 0n, lastSync: 1_788_593_531n, coveredSeconds: 831n };
      const nowTs = 1_788_595_594n; // well after coverageEnd
      const coverageEnd = 1_788_593_531n;

      const projected = projectSubscription(sub, nowTs, coverageEnd);

      expect(projected.asOf).toBe(coverageEnd); // clamped
      expect(projected.elapsedSeconds).toBe(0n); // asOf <= lastSync: _sync's early return
      expect(projected.funded).toBe(0n);
      expect(projected.coveredSeconds).toBe(831n);
      expect(projected.runwaySeconds).toBe(0n);
    });
  });
});
