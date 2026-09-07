/**
 * The set of epoch ids job 1b works through — every epoch job 1a has ever
 * filed an `openEpoch` journal record for, whatever its outcome (sent,
 * already-open, skipped-stale). Deriving this from the journal rather than
 * re-scanning logs keeps job 1b independent of the backfill cursor's pace.
 */

import type { Journal } from "@volatus/service-kit";
import { SERVICE } from "./constants.js";

export function listKnownEpochIds(journal: Journal): bigint[] {
  const ids = journal
    .list(SERVICE)
    .filter((record) => record.action === "openEpoch")
    .map((record) => BigInt(record.key));
  ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return ids;
}
