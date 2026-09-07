import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openJournal, type Journal } from "@volatus/service-kit";
import { listKnownEpochIds } from "../src/knownEpochs.js";

describe("listKnownEpochIds", () => {
  let journal: Journal;
  beforeEach(() => {
    journal = openJournal(":memory:");
  });
  afterEach(() => journal.close());

  it("returns every epoch id ever filed under the openEpoch action, sorted ascending", () => {
    journal.claim("reporter", "openEpoch", "3");
    journal.claim("reporter", "openEpoch", "1");
    journal.claim("reporter", "openEpoch", "2");
    expect(listKnownEpochIds(journal)).toEqual([1n, 2n, 3n]);
  });

  it("ignores other actions and other services", () => {
    journal.claim("reporter", "openEpoch", "2");
    journal.claim("reporter", "settle", "2");
    journal.claim("reporter", "reportPayoff", "2");
    journal.claim("keeper", "openEpoch", "9");
    expect(listKnownEpochIds(journal)).toEqual([2n]);
  });

  it("includes an epoch regardless of its recorded outcome (sent, skipped-stale, already-open)", () => {
    journal.claim("reporter", "openEpoch", "1");
    journal.recordDone("reporter", "openEpoch", "1", "skipped-stale");
    journal.claim("reporter", "openEpoch", "2");
    journal.recordDone("reporter", "openEpoch", "2", "already-open-onchain");
    journal.claim("reporter", "openEpoch", "3");
    journal.recordFailed("reporter", "openEpoch", "3", "rpc hiccup");
    expect(listKnownEpochIds(journal)).toEqual([1n, 2n, 3n]);
  });
});
