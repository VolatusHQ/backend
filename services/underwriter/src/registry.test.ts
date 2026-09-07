import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { openJournal, type Logger } from "@volatus/service-kit";
import {
  discoverSubscriptions,
  dropTrackedSubscription,
  isExposed,
  listTrackedSubscriptions,
  ratioWad,
  seedSubscription,
  summarizeExposure,
  type SubscriptionExposure,
} from "./registry.js";

const SUB_A = "0x7975E591c26e6c6D9B0CFd9A81f6d61A921C080c" as Address;
const SUB_B = "0x000000000000000000000000000000000000bb" as Address;
const STREAM = "0x0000000000000000000000000000000000dEaD" as Address;

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

describe("isExposed / summarizeExposure — pure aggregation, the utilization/concentration inputs", () => {
  it("excludes a cancelled subscription (ratePerSecond 0) from the sum", () => {
    expect(isExposed({ ratePerSecond: 0n, claimed: false })).toBe(false);
  });

  it("excludes a claimed subscription even if ratePerSecond is still set", () => {
    expect(isExposed({ ratePerSecond: 100n, claimed: true })).toBe(false);
  });

  it("includes a live, unclaimed subscription", () => {
    expect(isExposed({ ratePerSecond: 100n, claimed: false })).toBe(true);
  });

  it("reproduces BRIEF.md's live single-subscriber state (coverageNotional 4,000,000)", () => {
    const subs: SubscriptionExposure[] = [
      { subscriber: SUB_A, ratePerSecond: 100n, coverageNotional: 4_000_000n, claimed: false },
    ];
    const summary = summarizeExposure(subs);
    expect(summary.totalNotional).toBe(4_000_000n);
    expect(summary.maxNotional).toBe(4_000_000n);
    expect(summary.maxNotionalSubscriber).toBe(SUB_A);
    expect(summary.activeCount).toBe(1);
  });

  it("aggregates across multiple exposed subscribers and picks the true max", () => {
    const subs: SubscriptionExposure[] = [
      { subscriber: SUB_A, ratePerSecond: 100n, coverageNotional: 4_000_000n, claimed: false },
      { subscriber: SUB_B, ratePerSecond: 50n, coverageNotional: 6_000_000n, claimed: false },
    ];
    const summary = summarizeExposure(subs);
    expect(summary.totalNotional).toBe(10_000_000n);
    expect(summary.maxNotional).toBe(6_000_000n);
    expect(summary.maxNotionalSubscriber).toBe(SUB_B);
    expect(summary.activeCount).toBe(2);
  });

  it("ignores cancelled/claimed rows even when they would otherwise dominate the max", () => {
    const subs: SubscriptionExposure[] = [
      { subscriber: SUB_A, ratePerSecond: 0n, coverageNotional: 99_000_000n, claimed: false }, // cancelled
      { subscriber: SUB_B, ratePerSecond: 50n, coverageNotional: 1_000_000n, claimed: false },
    ];
    const summary = summarizeExposure(subs);
    expect(summary.totalNotional).toBe(1_000_000n);
    expect(summary.maxNotional).toBe(1_000_000n);
    expect(summary.activeCount).toBe(1);
  });

  it("an aggregate can legitimately exceed the pool -- ratioWad is not capped at 1e18", () => {
    // The contract checks one subscription's notional against capacityPool at subscribe
    // time; it never checks the running total. This is exactly the gap this module exists
    // to surface (see registry.ts module doc).
    expect(ratioWad(10_000_000n, 5_889_412n)).toBeGreaterThan(1_000_000_000_000_000_000n);
  });

  it("ratioWad is 0 (a sentinel) rather than throwing when the pool is empty", () => {
    expect(ratioWad(1_000_000n, 0n)).toBe(0n);
  });

  it("ratioWad floors a non-exact ratio the same direction as shares.ts", () => {
    // 4,000,000 / 5,889,412 = 0.6791... -> WAD-floored.
    const wad = ratioWad(4_000_000n, 5_889_412n);
    expect(wad).toBeLessThan(1_000_000_000_000_000_000n);
    expect(wad).toBeGreaterThan(600_000_000_000_000_000n);
  });
});

describe("registry persistence — namespaced under the journal's actions table, not the shared subscriptions table", () => {
  function freshJournal() {
    return openJournal(":memory:");
  }

  it("seedSubscription is idempotent and immediately visible to listTrackedSubscriptions", () => {
    const journal = freshJournal();
    seedSubscription(journal, 2n, SUB_A);
    seedSubscription(journal, 2n, SUB_A); // no-op second call
    const tracked = listTrackedSubscriptions(journal);
    expect(tracked).toHaveLength(1);
    expect(tracked[0]).toEqual({ epochId: 2n, subscriber: SUB_A });
    journal.close();
  });

  it("dropTrackedSubscription removes a pair from listTrackedSubscriptions without touching others", () => {
    const journal = freshJournal();
    seedSubscription(journal, 2n, SUB_A);
    seedSubscription(journal, 2n, SUB_B);
    dropTrackedSubscription(journal, 2n, SUB_A, "cancelled", silentLogger);
    const tracked = listTrackedSubscriptions(journal);
    expect(tracked).toHaveLength(1);
    expect(tracked[0]!.subscriber).toBe(SUB_B);
    journal.close();
  });

  it("discoverSubscriptions records a new Subscribed log and advances its own cursor, never the keeper's", () => {
    const journal = freshJournal();
    const fakeClient = {
      chain: { id: 5_042_002 },
      getLogs: async () => [
        {
          address: STREAM,
          blockNumber: 500n,
          args: { epochId: 2n, subscriber: SUB_A, ratePerSecond: 100n, coverage: 4_000_000n },
        },
      ],
    };

    return discoverSubscriptions({
      journal,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fakeClient as any,
      address: STREAM,
      toBlock: 1_000n,
      seedBlock: 0n,
      logger: silentLogger,
    }).then((result) => {
      expect(result.newSubscriptions).toBe(1);
      expect(listTrackedSubscriptions(journal)).toEqual([{ epochId: 2n, subscriber: SUB_A }]);
      // Its own cursor, distinctly named from "keeper:subscribed:cursor".
      expect(journal.getCursor("underwriter:subscribed:cursor")).toBe(1_000n);
      expect(journal.getCursor("keeper:subscribed:cursor")).toBeNull();
      journal.close();
    });
  });

  it("does not re-discover (or duplicate) a pair already tracked", async () => {
    const journal = freshJournal();
    seedSubscription(journal, 2n, SUB_A);
    const fakeClient = {
      chain: { id: 5_042_002 },
      getLogs: async () => [
        { address: STREAM, blockNumber: 500n, args: { epochId: 2n, subscriber: SUB_A, ratePerSecond: 100n, coverage: 4_000_000n } },
      ],
    };
    const result = await discoverSubscriptions({
      journal,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fakeClient as any,
      address: STREAM,
      toBlock: 1_000n,
      seedBlock: 0n,
      logger: silentLogger,
    });
    expect(result.newSubscriptions).toBe(0);
    expect(listTrackedSubscriptions(journal)).toHaveLength(1);
    journal.close();
  });
});
