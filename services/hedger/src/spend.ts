/**
 * The mandate's cumulative-spend ledger — "cumulative spend is tracked in
 * the journal so a restart cannot forget it" (this service's brief, and the
 * same guarantee `@volatus/service-kit`'s journal already gives the reporter
 * and keeper for their own idempotency). There is no in-memory running
 * total anywhere in this package: every cap check re-derives the total from
 * the journal's `actions` table, so a crash mid-tick can never lose track of
 * money already committed.
 *
 * Only `fund` counts against the cap — it is the only action that moves the
 * user's USDC out of their own control into the stream. `adjust` re-prices
 * a rate; it does not move principal, and its own gas is the signer's
 * concern (see `src/delegation/`), not the mandate's premium budget.
 *
 * Journal key convention: action name is `fund:<mandate.id>` so
 * `journal.list(SERVICE)` naturally partitions by mandate without a key
 * prefix scan, and the `key` column is a monotonic per-mandate sequence
 * number from `nextSequence` below — `fund` (unlike `reportPayoff` or
 * `settle`) can legitimately happen many times over a mandate's life, so it
 * cannot be keyed by epoch id the way the reporter keys its one-shot actions.
 */

import type { Journal } from "@volatus/service-kit";
import { SERVICE } from "./constants.js";

export function fundActionName(mandateId: string): string {
  return `fund:${mandateId}`;
}

export function adjustActionName(mandateId: string): string {
  return `adjust:${mandateId}`;
}

export interface FundResult {
  amountUsdc: string;
}

/**
 * Sum of every `fund` recorded `done` for this mandate. Reads the journal
 * fresh every call — this is the whole point: it must survive a restart
 * without help from anything held in process memory.
 */
export function cumulativeSpentUsdc(journal: Journal, mandateId: string): bigint {
  const action = fundActionName(mandateId);
  return journal
    .list(SERVICE)
    .filter((r) => r.action === action && r.status === "done")
    .reduce((sum, r) => {
      const result = r.result as FundResult | null;
      if (!result || typeof result.amountUsdc !== "string") return sum;
      return sum + BigInt(result.amountUsdc);
    }, 0n);
}

/**
 * A monotonic counter per `(mandateId, kind)`, persisted as a journal
 * cursor. Gives every `fund`/`adjust` attempt a unique, restart-safe journal
 * key without reusing an epoch id (which, unlike the reporter's one-shot
 * actions, is not unique per attempt here).
 */
export function nextSequence(journal: Journal, name: string): bigint {
  const current = journal.getCursor(name) ?? -1n;
  const next = current + 1n;
  journal.setCursor(name, next);
  return next;
}
