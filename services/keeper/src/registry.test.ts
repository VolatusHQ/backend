import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { openJournal, type Journal, type Logger } from "@volatus/service-kit";
import {
  discoverSubscriptions,
  dropTrackedSubscription,
  evaluateDropReason,
  listActiveSubscriptions,
  PRUNED_BEFORE_CURSOR,
  seedSubscription,
  SUBSCRIBED_CURSOR,
} from "./registry.js";

const ADDR = "0x0000000000000000000000000000000000000001" as Address;
const SUBSCRIBER_A = "0x7975E591c26e6c6D9B0CFd9A81f6d61A921C080c" as Address;
const SUBSCRIBER_B = "0x000000000000000000000000000000000000bb" as Address;

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

/** Fake `PublicClient` exposing only what `getLogsChunked` (via `discoverSubscriptions`) touches. */
function fakeClient(getLogsImpl: (p: { fromBlock: bigint; toBlock: bigint }) => unknown[]) {
  return {
    chain: { id: 5_042_002 },
    getLogs: vi.fn(async (p: { fromBlock: bigint; toBlock: bigint }) => getLogsImpl(p)),
  };
}

function subscribedLog(epochId: bigint, subscriber: Address, blockNumber: bigint) {
  return {
    args: { epochId, subscriber, ratePerSecond: 100n, coverage: 4_000_000n },
    blockNumber,
  };
}

describe("discoverSubscriptions", () => {
  let journal: Journal;
  beforeEach(() => {
    journal = openJournal(":memory:");
  });
  afterEach(() => journal.close());

  it("registers a subscription found in a Subscribed log and advances the cursor", async () => {
    const client = fakeClient((p) => (p.fromBlock <= 500n && p.toBlock >= 500n ? [subscribedLog(2n, SUBSCRIBER_A, 500n)] : []));

    const result = await discoverSubscriptions({
      journal,
      client: client as never,
      address: ADDR,
      toBlock: 1_000n,
      seedBlock: 0n,
      logger: silentLogger,
    });

    expect(result.newSubscriptions).toBe(1);
    expect(journal.getCursor(SUBSCRIBED_CURSOR)).toBe(1_000n);
    expect(listActiveSubscriptions(journal)).toEqual([{ epochId: 2n, subscriber: SUBSCRIBER_A }]);
  });

  it("resumes from the persisted cursor rather than rescanning from seedBlock", async () => {
    journal.setCursor(SUBSCRIBED_CURSOR, 900n);
    const calls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    const client = fakeClient((p) => {
      calls.push(p);
      return [];
    });

    await discoverSubscriptions({ journal, client: client as never, address: ADDR, toBlock: 1_000n, seedBlock: 0n, logger: silentLogger });

    expect(calls[0]!.fromBlock).toBe(901n);
  });

  it("does not re-register a subscription already tracked (idempotent under overlapping scans)", async () => {
    const client = fakeClient(() => [subscribedLog(2n, SUBSCRIBER_A, 500n)]);

    await discoverSubscriptions({ journal, client: client as never, address: ADDR, toBlock: 1_000n, seedBlock: 0n, logger: silentLogger });
    journal.setCursor(SUBSCRIBED_CURSOR, 499n); // force a rescan over the same log
    const second = await discoverSubscriptions({ journal, client: client as never, address: ADDR, toBlock: 1_000n, seedBlock: 0n, logger: silentLogger });

    expect(second.newSubscriptions).toBe(0);
    expect(listActiveSubscriptions(journal)).toHaveLength(1);
  });

  it("prunedBefore does not silently lose subscriptions: pruned chunks are skipped, newer ones still register, and the floor is recorded", async () => {
    // Chunks below 18000 are "pruned"; the log for subscriber B sits above it and is found.
    const client = fakeClient((p) => {
      if (p.toBlock < 18_000n) {
        throw new Error("server returned an error response: error code 4444: pruned history unavailable");
      }
      return p.fromBlock <= 20_000n && p.toBlock >= 20_000n ? [subscribedLog(2n, SUBSCRIBER_B, 20_000n)] : [];
    });

    const result = await discoverSubscriptions({
      journal,
      client: client as never,
      address: ADDR,
      toBlock: 27_000n,
      seedBlock: 0n,
      logger: silentLogger,
    });

    expect(result.prunedBefore).toBe(18_000n);
    expect(journal.getCursor(PRUNED_BEFORE_CURSOR)).toBe(18_000n);
    // The subscription above the prune floor was still found...
    expect(listActiveSubscriptions(journal)).toContainEqual({ epochId: 2n, subscriber: SUBSCRIBER_B });

    // ...and a subscription that predates the prune floor, added by hand ahead of time
    // (BACKEND_HANDOFF.md: "must have been seeded"), is untouched by the scan either way.
    seedSubscription(journal, 2n, SUBSCRIBER_A, { discoveredAtBlock: "100" });
    const rescan = await discoverSubscriptions({
      journal,
      client: client as never,
      address: ADDR,
      toBlock: 27_001n,
      seedBlock: 0n,
      logger: silentLogger,
    });
    expect(rescan.newSubscriptions).toBe(0); // nothing new below the floor to (re)discover
    expect(listActiveSubscriptions(journal)).toHaveLength(2); // both A (seeded) and B (logged) still tracked
  });

  it("seedSubscription is idempotent and marks its payload source as 'seed'", () => {
    seedSubscription(journal, 3n, SUBSCRIBER_A);
    seedSubscription(journal, 3n, SUBSCRIBER_A, { initialRatePerSecond: "50" });
    const subs = journal.listSubscriptions(3n);
    expect(subs).toHaveLength(1);
    expect(subs[0]?.payload).toMatchObject({ source: "seed", initialRatePerSecond: "50" });
  });
});

describe("registry survives a simulated restart", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keeper-registry-"));
    dbPath = join(dir, "journal.sqlite");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a subscription discovered before a restart is still tracked after reopening the journal file", async () => {
    const before = openJournal(dbPath);
    const client = fakeClient(() => [subscribedLog(2n, SUBSCRIBER_A, 500n)]);
    await discoverSubscriptions({ journal: before, client: client as never, address: ADDR, toBlock: 1_000n, seedBlock: 0n, logger: silentLogger });
    expect(existsSync(dbPath)).toBe(true);
    before.close(); // simulates the keeper process dying here

    const after = openJournal(dbPath);
    expect(listActiveSubscriptions(after)).toEqual([{ epochId: 2n, subscriber: SUBSCRIBER_A }]);
    // The cursor survives too, so the next scan resumes rather than rescanning from seedBlock.
    expect(after.getCursor(SUBSCRIBED_CURSOR)).toBe(1_000n);
    after.close();
  });

  it("a dropped subscription stays dropped after a restart", async () => {
    const before = openJournal(dbPath);
    seedSubscription(before, 2n, SUBSCRIBER_A);
    dropTrackedSubscription(before, 2n, SUBSCRIBER_A, "cancelled", silentLogger);
    before.close();

    const after = openJournal(dbPath);
    expect(listActiveSubscriptions(after)).toHaveLength(0);
    after.close();
  });
});

describe("evaluateDropReason", () => {
  const base = { ratePerSecond: 100n, funded: 1_000n, coverageEnd: 2_000n, runwaySeconds: 10n, now: 1_000n };

  it("does not drop an active, funded, in-epoch subscription", () => {
    expect(evaluateDropReason(base)).toBeNull();
  });

  it("drops a cancelled subscription (ratePerSecond 0) even if funded is nonzero", () => {
    expect(evaluateDropReason({ ...base, ratePerSecond: 0n, funded: 5_000n })).toBe("cancelled");
  });

  it("drops a drained subscription (runwaySeconds and funded both 0) even mid-epoch", () => {
    expect(evaluateDropReason({ ...base, funded: 0n, runwaySeconds: 0n })).toBe("drained");
  });

  it("does not drop for drained unless BOTH runwaySeconds and funded read 0", () => {
    // funded 0 but runwaySeconds not yet re-read as 0 (stale view) — not drained by this check.
    expect(evaluateDropReason({ ...base, funded: 0n, runwaySeconds: 5n })).toBeNull();
  });

  it("drops once the epoch is past coverageEnd", () => {
    expect(evaluateDropReason({ ...base, now: 2_001n })).toBe("epoch-ended");
  });

  it("cancelled takes priority over epoch-ended when both are true", () => {
    expect(evaluateDropReason({ ...base, ratePerSecond: 0n, now: 2_001n })).toBe("cancelled");
  });
});
