/**
 * Turns a `journal.claim()` result into a go/no-go decision, and does the
 * work of reconciling an `in_flight` record left behind by a crash — the
 * case `@volatus/service-kit`'s own docs call out: "A crashed in-flight
 * action comes back in_flight, never fresh — so you reconcile by looking up
 * the tx hash rather than blindly re-sending."
 *
 * Three sub-cases inside `in_flight`, in the order this module checks them:
 *
 *   1. A tx hash was recorded (`recordSent` ran before the crash). Look up
 *      its receipt. Landed successfully -> `recordDone` and treat as already
 *      done. Reverted on-chain -> `recordFailed` (safe: it definitely did not
 *      take effect) and re-claim, which is now reclaimable and returns
 *      `fresh`. Not found yet (still pending, or the node dropped it) -> do
 *      **not** resend; report "blocked" and let the next tick check again.
 *   2. No tx hash at all — the process died between `claim()` and ever
 *      calling `recordSent`. There is no hash to check, so the only honest
 *      signal is the on-chain effect itself (`isDoneOnChain`): if it already
 *      holds, some attempt clearly landed -> `recordDone` and move on. If it
 *      does not, this is the genuinely ambiguous case (a send could still be
 *      in flight at the RPC/mempool level) — refuse to guess and report
 *      "blocked" rather than resend, exactly per the journal's own contract.
 *      An operator resolves it by hand (confirm nothing pending, then
 *      `journal.recordFailed` to make it reclaimable).
 */

import type { Hex, PublicClient, TransactionReceipt } from "viem";
import type { Journal, Logger } from "@volatus/service-kit";

export type { Logger };

export type ClaimDecision = { proceed: true } | { proceed: false; reason: string };

export async function resolveClaim(params: {
  journal: Journal;
  service: string;
  action: string;
  key: string;
  /** Read-only client for the chain this action's tx would land on. */
  publicClient: PublicClient;
  /** Authoritative on-chain check for "did this action's effect already happen". */
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
