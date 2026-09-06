import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openJournal, type Journal } from "./journal.js";

describe("journal — actions (in-memory)", () => {
  let journal: Journal;

  beforeEach(() => {
    journal = openJournal(":memory:");
  });
  afterEach(() => {
    journal.close();
  });

  it("claim() on a new key returns fresh, and claiming the same key again returns in_flight", () => {
    expect(journal.claim("reporter", "openEpoch", "2")).toBe("fresh");
    expect(journal.claim("reporter", "openEpoch", "2")).toBe("in_flight");
  });

  it("different keys/actions/services do not collide", () => {
    expect(journal.claim("reporter", "openEpoch", "2")).toBe("fresh");
    expect(journal.claim("reporter", "openEpoch", "3")).toBe("fresh");
    expect(journal.claim("reporter", "reportPayoff", "2")).toBe("fresh");
    expect(journal.claim("keeper", "openEpoch", "2")).toBe("fresh");
  });

  it("recordDone makes claim() return done, terminally", () => {
    journal.claim("reporter", "openEpoch", "2");
    journal.recordSent("reporter", "openEpoch", "2", "0xhash1");
    journal.recordDone("reporter", "openEpoch", "2", "0xhash1", { coverageEnd: "123" });

    expect(journal.claim("reporter", "openEpoch", "2")).toBe("done");
    const record = journal.get("reporter", "openEpoch", "2");
    expect(record?.status).toBe("done");
    expect(record?.txHash).toBe("0xhash1");
    expect(record?.result).toEqual({ coverageEnd: "123" });
  });

  it("recordFailed allows the action to be claimed again (a failed send never landed)", () => {
    journal.claim("reporter", "reportPayoff", "2");
    journal.recordFailed("reporter", "reportPayoff", "2", new Error("ReportWindowClosed"));

    const failedRecord = journal.get("reporter", "reportPayoff", "2");
    expect(failedRecord?.status).toBe("failed");
    expect(failedRecord?.error).toContain("ReportWindowClosed");

    expect(journal.claim("reporter", "reportPayoff", "2")).toBe("fresh");
  });

  it("recordSent without a prior claim throws — callers must claim first", () => {
    expect(() => journal.recordSent("reporter", "openEpoch", "999", "0xhash")).toThrow();
  });

  it("list() returns every record for a service, not other services'", () => {
    journal.claim("reporter", "openEpoch", "2");
    journal.claim("reporter", "reportPayoff", "2");
    journal.claim("keeper", "sync", "2:0xabc");

    expect(journal.list("reporter")).toHaveLength(2);
    expect(journal.list("keeper")).toHaveLength(1);
    expect(journal.list("nobody")).toHaveLength(0);
  });
});

describe("journal — crash recovery across a real restart", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "service-kit-journal-"));
    dbPath = join(dir, "journal.sqlite");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("an action recorded as in_flight is NOT re-claimable as fresh after the process (journal handle) restarts", () => {
    // Process 1: claims the action and sends the tx, but crashes before recordDone.
    const before = openJournal(dbPath);
    expect(before.claim("reporter", "reportPayoff", "2")).toBe("fresh");
    before.recordSent("reporter", "reportPayoff", "2", "0xdeadbeef");
    before.close(); // simulates the process dying here, mid-flight

    expect(existsSync(dbPath)).toBe(true);

    // Process 2: reopens the same file — a real restart, not the same in-memory object.
    const after = openJournal(dbPath);
    const result = after.claim("reporter", "reportPayoff", "2");

    // The bug this guards against: silently returning "fresh" here would
    // cause reportPayoff to be sent a second time.
    expect(result).toBe("in_flight");

    // The caller reconciles by looking up the tx hash rather than resending.
    const record = after.get("reporter", "reportPayoff", "2");
    expect(record?.status).toBe("in_flight");
    expect(record?.txHash).toBe("0xdeadbeef");

    after.close();
  });

  it("a claim with no recordSent yet still comes back in_flight after restart (never silently fresh)", () => {
    const before = openJournal(dbPath);
    expect(before.claim("keeper", "sync", "2:0xabc")).toBe("fresh");
    // No recordSent/recordDone/recordFailed called — process crashed right after claim().
    before.close();

    const after = openJournal(dbPath);
    expect(after.claim("keeper", "sync", "2:0xabc")).toBe("in_flight");
    expect(after.get("keeper", "sync", "2:0xabc")?.txHash).toBeNull();
    after.close();
  });

  it("a done action stays done across a restart", () => {
    const before = openJournal(dbPath);
    before.claim("reporter", "openEpoch", "2");
    before.recordDone("reporter", "openEpoch", "2", "0xabc");
    before.close();

    const after = openJournal(dbPath);
    expect(after.claim("reporter", "openEpoch", "2")).toBe("done");
    after.close();
  });
});

describe("journal — cursors", () => {
  let journal: Journal;
  beforeEach(() => {
    journal = openJournal(":memory:");
  });
  afterEach(() => journal.close());

  it("round-trips a bigint block number, and defaults to null", () => {
    expect(journal.getCursor("unichain-epoch-scan")).toBeNull();
    journal.setCursor("unichain-epoch-scan", 62_301_001n);
    expect(journal.getCursor("unichain-epoch-scan")).toBe(62_301_001n);
    journal.setCursor("unichain-epoch-scan", 62_302_000n);
    expect(journal.getCursor("unichain-epoch-scan")).toBe(62_302_000n);
  });
});

describe("journal — subscription registry", () => {
  let journal: Journal;
  beforeEach(() => {
    journal = openJournal(":memory:");
  });
  afterEach(() => journal.close());

  it("upserts, lists (optionally by epoch) and drops subscriptions", () => {
    journal.upsertSubscription(2n, "0x7975E591c26e6c6D9B0CFd9A81f6d61A921C080c", "active", {
      ratePerSecond: "100",
    });
    journal.upsertSubscription(2n, "0xkeeper", "active");
    journal.upsertSubscription(3n, "0xother", "active");

    expect(journal.listSubscriptions()).toHaveLength(3);
    expect(journal.listSubscriptions(2n)).toHaveLength(2);
    expect(journal.listSubscriptions("2")).toHaveLength(2); // string/bigint keys are equivalent

    const [sub] = journal.listSubscriptions(2n).filter((s) => s.subscriber === "0x7975E591c26e6c6D9B0CFd9A81f6d61A921C080c");
    expect(sub?.payload).toEqual({ ratePerSecond: "100" });

    journal.dropSubscription(2n, "0xkeeper");
    expect(journal.listSubscriptions(2n)).toHaveLength(1);
  });

  it("upserting the same (epochId, subscriber) again updates rather than duplicating", () => {
    journal.upsertSubscription(2n, "0xabc", "active");
    journal.upsertSubscription(2n, "0xabc", "dropped");
    const subs = journal.listSubscriptions(2n);
    expect(subs).toHaveLength(1);
    expect(subs[0]?.status).toBe("dropped");
  });
});
