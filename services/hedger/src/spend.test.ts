import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openJournal, type Journal } from "@volatus/service-kit";
import { cumulativeSpentUsdc, fundActionName, nextSequence } from "./spend.js";
import { SERVICE } from "./constants.js";

describe("cumulativeSpentUsdc (in-memory)", () => {
  let journal: Journal;
  beforeEach(() => {
    journal = openJournal(":memory:");
  });
  afterEach(() => journal.close());

  it("is zero for a mandate with no recorded fund", () => {
    expect(cumulativeSpentUsdc(journal, "m1")).toBe(0n);
  });

  it("sums only done fund actions, ignoring in_flight/failed ones and other mandates", () => {
    const action = fundActionName("m1");

    journal.claim(SERVICE, action, "0");
    journal.recordDone(SERVICE, action, "0", "0xhash0", { amountUsdc: "1000000" });

    journal.claim(SERVICE, action, "1");
    journal.recordDone(SERVICE, action, "1", "0xhash1", { amountUsdc: "500000" });

    // A failed attempt must not count.
    journal.claim(SERVICE, action, "2");
    journal.recordFailed(SERVICE, action, "2", new Error("reverted"));

    // A different mandate's fund must not count toward this one's total.
    const otherAction = fundActionName("m2");
    journal.claim(SERVICE, otherAction, "0");
    journal.recordDone(SERVICE, otherAction, "0", "0xhash2", { amountUsdc: "9000000" });

    expect(cumulativeSpentUsdc(journal, "m1")).toBe(1_500_000n);
    expect(cumulativeSpentUsdc(journal, "m2")).toBe(9_000_000n);
  });
});

describe("nextSequence (in-memory)", () => {
  let journal: Journal;
  beforeEach(() => {
    journal = openJournal(":memory:");
  });
  afterEach(() => journal.close());

  it("starts at 0 and increments monotonically", () => {
    expect(nextSequence(journal, "seq:m1")).toBe(0n);
    expect(nextSequence(journal, "seq:m1")).toBe(1n);
    expect(nextSequence(journal, "seq:m1")).toBe(2n);
  });

  it("is independent per name", () => {
    expect(nextSequence(journal, "seq:m1")).toBe(0n);
    expect(nextSequence(journal, "seq:m2")).toBe(0n);
    expect(nextSequence(journal, "seq:m1")).toBe(1n);
  });
});

describe("cumulative spend survives a restart (real sqlite file, not :memory:)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hedger-spend-"));
    dbPath = join(dir, "journal.sqlite");
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("a fund recorded before a restart is still counted after reopening the journal file", () => {
    const mandateId = "restart-mandate";
    const action = fundActionName(mandateId);

    // Process 1: mandate cap is 5 USDC (6dp); one fund of 3 USDC lands.
    const first = openJournal(dbPath);
    first.claim(SERVICE, action, "0");
    first.recordDone(SERVICE, action, "0", "0xabc", { amountUsdc: "3000000" });
    expect(cumulativeSpentUsdc(first, mandateId)).toBe(3_000_000n);
    first.close();

    // Process 2: reopens the same file — a real restart, not the same object.
    const second = openJournal(dbPath);
    expect(cumulativeSpentUsdc(second, mandateId)).toBe(3_000_000n);

    // A naive in-memory counter would have reset to 0 here and let a second
    // fund push cumulative spend to 3 + 3 = 6, over a 5 USDC cap. The
    // journal-backed total correctly still reads 3, so a cap check against
    // it after this second fund would correctly see 6 and refuse it.
    second.claim(SERVICE, action, "1");
    second.recordDone(SERVICE, action, "1", "0xdef", { amountUsdc: "3000000" });
    expect(cumulativeSpentUsdc(second, mandateId)).toBe(6_000_000n);
    second.close();
  });

  it("the sequence counter also survives a restart, so a fresh process never reuses a journal key", () => {
    const name = "seq:restart-mandate";
    const first = openJournal(dbPath);
    expect(nextSequence(first, name)).toBe(0n);
    expect(nextSequence(first, name)).toBe(1n);
    first.close();

    const second = openJournal(dbPath);
    expect(nextSequence(second, name)).toBe(2n);
    second.close();
  });
});
