/**
 * Spending caps, enforced in this service's own code — not by Circle.
 *
 * `.agents/skills/agent-wallet-policy/SKILL.md` is explicit: "Spending
 * policies are mainnet-only (testnet chains are rejected...)." Arc Testnet is
 * exactly that: a testnet chain. So `circle wallet limit set` cannot be used
 * here at all, and even if the underwriter ran on a mainnet wallet, that
 * policy is enforced by Circle's own infrastructure around *that wallet's*
 * transfers — it says nothing about whether a locally-signed transaction
 * from a plain private key (the `UNDERWRITER_WALLET_MODE=local` path this
 * service defaults to, since `CIRCLE_API_KEY`/`CIRCLE_ENTITY_SECRET` are not
 * provisioned in this environment — see `wallet/circleAgentWallet.ts`) is
 * capped by anything at all. On testnet, right now, nothing on chain stops
 * this agent from posting or withdrawing an arbitrary amount. The cap has to
 * live here, and it has to be checked before every send, not asserted in a
 * README and left unenforced.
 *
 * `checkSpendCap` is pure — it takes the spend history as data, not a
 * journal handle — so it is trivially unit-testable and so `tick.ts` can
 * build that history however it likes (today: from the journal's `actions`
 * table, via `spendHistoryFromJournal`).
 */

import type { Journal } from "@volatus/service-kit";

const SERVICE = "underwriter";
export const POST_CAPACITY_ACTION = "postCapacity";

export interface SpendRecord {
  /** Unix seconds the spend was recorded (when the send landed, not when it was proposed). */
  atSeconds: number;
  amountUsdc: number;
}

export interface SpendCapTuning {
  /** No single post may exceed this, independent of anything already spent. */
  perTxCapUsdc: number;
  /** Total posted within the trailing `periodSeconds` window may not exceed this. */
  periodCapUsdc: number;
  periodSeconds: number;
}

export interface CapDecision {
  allowed: boolean;
  reason: string;
  spentInPeriod: number;
  remainingInPeriod: number;
}

/**
 * Whether `proposedUsdc` may be sent right now, given `history` (every past spend this
 * service has recorded) and the caps in `tuning`. Two independent checks, either of which
 * can refuse: a flat per-transaction ceiling, and a rolling-window total. Both are checked
 * against the *proposed* amount before anything is sent — this is a pre-flight gate, not an
 * after-the-fact audit.
 */
export function checkSpendCap(
  tuning: SpendCapTuning,
  history: readonly SpendRecord[],
  nowSeconds: number,
  proposedUsdc: number,
): CapDecision {
  if (proposedUsdc > tuning.perTxCapUsdc) {
    return {
      allowed: false,
      reason: `proposed ${proposedUsdc} USDC exceeds the per-transaction cap of ${tuning.perTxCapUsdc} USDC`,
      spentInPeriod: 0,
      remainingInPeriod: 0,
    };
  }

  const windowStart = nowSeconds - tuning.periodSeconds;
  const spentInPeriod = history
    .filter((r) => r.atSeconds > windowStart)
    .reduce((sum, r) => sum + r.amountUsdc, 0);
  const remainingInPeriod = Math.max(0, tuning.periodCapUsdc - spentInPeriod);

  if (proposedUsdc > remainingInPeriod) {
    return {
      allowed: false,
      reason:
        `proposed ${proposedUsdc} USDC would exceed the rolling ${tuning.periodSeconds}s cap of ` +
        `${tuning.periodCapUsdc} USDC (already spent ${spentInPeriod} USDC in this window, ` +
        `${remainingInPeriod} USDC remaining)`,
      spentInPeriod,
      remainingInPeriod,
    };
  }

  return { allowed: true, reason: "within both caps", spentInPeriod, remainingInPeriod };
}

/**
 * Record a completed `postCapacity` send so future `checkSpendCap` calls see it. Keyed by
 * transaction hash — unique per send, and doubles as a natural idempotency key if the same
 * send were ever (mistakenly) recorded twice.
 */
export function recordSpend(journal: Journal, txHash: string, amountUsdc: number, nowSeconds: number): void {
  journal.recordDone(SERVICE, POST_CAPACITY_ACTION, txHash, txHash, { amountUsdc, atSeconds: nowSeconds });
}

/** Every recorded spend, oldest first — the `history` input `checkSpendCap` expects. */
export function loadSpendHistory(journal: Journal): SpendRecord[] {
  return journal
    .list(SERVICE)
    .filter((r) => r.action === POST_CAPACITY_ACTION && r.status === "done")
    .map((r) => r.result as SpendRecord);
}
