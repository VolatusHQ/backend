/**
 * Ported from `services/reporter/src/journalReconcile.ts` — it is generic
 * over `Journal`/`PublicClient`/`Logger` from `@volatus/service-kit` with no
 * reporter-specific coupling, so the logic is copied verbatim rather than
 * re-derived. See that file for the full case-by-case rationale; the
 * summary: turn a `journal.claim()` result into a go/no-go decision, and on
 * an `in_flight` record left behind by a crash, reconcile by checking the
 * recorded tx hash's receipt rather than blindly resending.
 *
 * One difference from the reporter's use of this helper: `settle` and
 * `reportPayoff` are one-shot per epoch, so `isDoneOnChain` there is a
 * permanent flag (`epoch.settled`, `epoch.reported`). `adjust`/`fund` are
 * not one-shot — a mandate can send either many times over its life — so
 * this service's callers (`tick.ts`) give each attempt its own unique
 * journal key (`spend.ts`'s `nextSequence`) and pass an `isDoneOnChain` that
 * checks whether the *specific* target of that attempt already holds
 * on-chain, not a permanent flag.
 */

import type { Hex, PublicClient, TransactionReceipt } from "viem";
import type { Journal, Logger } from "@volatus/service-kit";

export type ClaimDecision = { proceed: true } | { proceed: false; reason: string };

export async function resolveClaim(params: {
  journal: Journal;
  service: string;
  action: string;
  key: string;
  /** Read-only client for the chain this action's tx would land on. */
  publicClient: PublicClient;
  /** Authoritative on-chain check for "did this specific attempt's effect already happen". */
  isDoneOnChain: () => Promise<boolean>;
  logger: Logger;
}): Promise<ClaimDecision> {
  const { journal, service, action, key, publicClient, isDoneOnChain, logger } = params;

  const claimResult = journal.claim(service, action, key);
  if (claimResult === "done") return { proceed: false, reason: "already recorded done in the journal" };
  if (claimResult === "fresh") return { proceed: true };

  // claimResult === "in_flight": reconcile rather than resend.
  const record = journal.get(service, action, key);
  const txHash = record?.txHash ?? null;

  if (txHash) {
    let receipt: TransactionReceipt | null;
    try {
      receipt = await publicClient.getTransactionReceipt({ hash: txHash as Hex });
    } catch {
      receipt = null; // not mined yet, or pruned -- either way, unresolved
    }

    if (receipt?.status === "success") {
      journal.recordDone(service, action, key, txHash, { reconciled: true });
      return { proceed: false, reason: `reconciled: prior tx ${txHash} already succeeded` };
    }
    if (receipt?.status === "reverted") {
      journal.recordFailed(service, action, key, `reconciled: prior tx ${txHash} reverted on-chain`);
      const reclaim = journal.claim(service, action, key);
      return reclaim === "fresh"
        ? { proceed: true }
        : { proceed: false, reason: `reclaim after reconciling a reverted tx returned "${reclaim}"` };
    }
    logger.info(`${action}(${key}): waiting on prior tx to confirm, not resending`, { txHash });
    return { proceed: false, reason: `prior tx ${txHash} still pending` };
  }

  // No hash was ever recorded -- the crash happened before recordSent.
  if (await isDoneOnChain()) {
    journal.recordDone(service, action, key, "reconciled-onchain-no-hash", { reconciled: true });
    return { proceed: false, reason: "reconciled: on-chain state already reflects this action" };
  }

  logger.warn(
    `${action}(${key}) is stuck in_flight with no recorded tx hash, and on-chain state shows it has not ` +
      "happened. Refusing to auto-resend -- a send may still be genuinely in flight. Resolve by hand: " +
      "confirm nothing is pending for this wallet, then journal.recordFailed(...) to make it reclaimable.",
    {},
  );
  return { proceed: false, reason: "blocked: in_flight with no hash and on-chain state incomplete" };
}
