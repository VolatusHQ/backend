/**
 * The underwriter's own record of who is subscribed, and how exposed the
 * pool is to each of them — utilization and concentration
 * (`BACKEND_HANDOFF.md` § Service 4).
 *
 * **Scope, stated plainly.** This aggregates exposure across every
 * `(epochId, subscriber)` pair this service has ever discovered via
 * `Subscribed` logs, regardless of epoch. `SigmaStream.subscribe` checks a
 * *single* new subscription's `coverageNotional` against the live
 * `capacityPool` (`contracts/src/SigmaStream.sol`); it does not track a
 * running total, so the sum this module computes — "how much notional is
 * outstanding against this one pool, aggregated across every subscriber" —
 * is a genuinely different, and generally larger, number than anything the
 * contract itself checks. That gap is real and is exactly why this signal is
 * useful: the contract's per-call check cannot see aggregate concentration,
 * and this module exists to surface it instead of assuming the contract
 * already prevents it.
 *
 * **Why this does not reuse the keeper's `Journal.subscriptions` table.**
 * `@volatus/service-kit`'s journal exposes a global `subscriptions` table
 * (`upsertSubscription` / `listSubscriptions` / `dropSubscription`) that is
 * *not* namespaced by service — `services/keeper` already writes rows there
 * with its own status lifecycle (dropped on cancel/drain/epoch-end). Writing
 * to that same table from this service risks reviving a row the keeper
 * dropped, or racing its own upserts, purely as an accident of two
 * independently-built services sharing one SQLite file. The journal's
 * `actions` table, by contrast, *is* namespaced by a `service` string
 * (`claim`/`recordDone`/`recordFailed`/`list`, keyed by `(service, action,
 * key)`), so this module uses that instead, under `service: "underwriter"` —
 * a deliberate reuse of a generic primitive for a purpose ("the set of
 * subscriptions I'm tracking") slightly broader than its doc comment's
 * literal "did I send this transaction," but one that keeps the two services
 * from ever touching each other's state. The `getCursor`/`setCursor` block
 * scan cursor is a plain namespaced string key (`"underwriter:..."`) in the
 * same shared `kv` table as the keeper's `"keeper:..."` cursor — safe by
 * construction as long as the prefixes differ, which they do.
 */

import { getAbiItem, type Address, type PublicClient } from "viem";
import { sigmaStreamAbi } from "@volatus/onchain";
import { getLogsChunked, type Journal, type Logger } from "@volatus/service-kit";
import { mulDivDown } from "./shares.js";

const SERVICE = "underwriter";
const ACTION = "trackedSubscription";
const WAD = 10n ** 18n;

export const SUBSCRIBED_CURSOR = "underwriter:subscribed:cursor";
export const PRUNED_BEFORE_CURSOR = "underwriter:subscribed:prunedBefore";

/** The `Subscribed` event, pulled once off the shared ABI rather than re-declared here. */
export const subscribedEvent = getAbiItem({ abi: sigmaStreamAbi, name: "Subscribed" });

function trackedKey(epochId: bigint, subscriber: Address): string {
  return `${epochId.toString()}:${subscriber.toLowerCase()}`;
}

export interface TrackedSubscription {
  epochId: bigint;
  subscriber: Address;
}

interface TrackedPayload {
  epochId: string;
  subscriber: Address;
  discoveredAtBlock: string;
}

export interface DiscoverSubscriptionsOptions {
  journal: Journal;
  client: PublicClient;
  address: Address;
  /** Usually the latest block; passed in so a fake client in tests never calls a real RPC. */
  toBlock: bigint;
  /** Checkpoint to start from when the journal has no cursor yet. */
  seedBlock: bigint;
  logger: Logger;
}

export interface DiscoverSubscriptionsResult {
  scannedFrom: bigint;
  scannedTo: bigint;
  newSubscriptions: number;
  /** Set when this scan (or a previous one) hit Arc's pruning floor. History
   *  below this block was never visible to log scanning. */
  prunedBefore?: bigint;
}

export async function discoverSubscriptions(
  opts: DiscoverSubscriptionsOptions,
): Promise<DiscoverSubscriptionsResult> {
  const cursor = opts.journal.getCursor(SUBSCRIBED_CURSOR);
  const fromBlock = cursor !== null ? cursor + 1n : opts.seedBlock;
  const existingPrunedBefore = opts.journal.getCursor(PRUNED_BEFORE_CURSOR) ?? undefined;

  if (fromBlock > opts.toBlock) {
    return { scannedFrom: fromBlock, scannedTo: opts.toBlock, newSubscriptions: 0, prunedBefore: existingPrunedBefore };
  }

  const { logs, prunedBefore } = await getLogsChunked({
    client: opts.client,
    address: opts.address,
    event: subscribedEvent,
    fromBlock,
    toBlock: opts.toBlock,
  });

  let newSubscriptions = 0;
  for (const log of logs) {
    const args = log.args as { epochId?: bigint; subscriber?: Address };
    if (args.epochId === undefined || args.subscriber === undefined) continue;

    const key = trackedKey(args.epochId, args.subscriber);
    if (opts.journal.get(SERVICE, ACTION, key)) continue; // already tracked (active or previously dropped)

    const payload: TrackedPayload = {
      epochId: args.epochId.toString(),
      subscriber: args.subscriber,
      discoveredAtBlock: (log.blockNumber ?? 0n).toString(),
    };
    // Not really "a sent transaction" -- see module doc for why the actions table is reused
    // here as a namespaced key/value record rather than the journal's shared subscriptions
    // table. "n/a-discovered-from-log" makes that reuse legible in a journal dump.
    opts.journal.recordDone(SERVICE, ACTION, key, "n/a-discovered-from-log", payload);
    newSubscriptions += 1;
    opts.logger.info("underwriter: discovered subscription from Subscribed log", {
      epochId: payload.epochId,
      subscriber: payload.subscriber,
      block: payload.discoveredAtBlock,
    });
  }

  opts.journal.setCursor(SUBSCRIBED_CURSOR, opts.toBlock);

  const effectivePrunedBefore = prunedBefore ?? existingPrunedBefore;
  if (prunedBefore !== undefined) {
    opts.journal.setCursor(PRUNED_BEFORE_CURSOR, prunedBefore);
    opts.logger.warn(
      "underwriter: Arc pruned history below this block -- a subscription created earlier is invisible " +
        "to log scanning and will never be discovered this way. Track it with seedSubscription() if it still exists.",
      { prunedBefore: prunedBefore.toString() },
    );
  }

  return { scannedFrom: fromBlock, scannedTo: opts.toBlock, newSubscriptions, prunedBefore: effectivePrunedBefore };
}

/** Manually register a subscription the log scan cannot see (predates `prunedBefore`, or an
 *  operator wants it tracked ahead of ever observing its `Subscribed` log). Idempotent. */
export function seedSubscription(journal: Journal, epochId: bigint, subscriber: Address): void {
  const key = trackedKey(epochId, subscriber);
  if (journal.get(SERVICE, ACTION, key)) return;
  const payload: TrackedPayload = { epochId: epochId.toString(), subscriber, discoveredAtBlock: "0" };
  journal.recordDone(SERVICE, ACTION, key, "n/a-seeded", payload);
}

/** Every `(epochId, subscriber)` pair this service currently tracks — not yet dropped. */
export function listTrackedSubscriptions(journal: Journal): TrackedSubscription[] {
  return journal
    .list(SERVICE)
    .filter((r) => r.action === ACTION && r.status !== "failed")
    .map((r) => {
      const payload = r.result as TrackedPayload;
      return { epochId: BigInt(payload.epochId), subscriber: payload.subscriber };
    });
}

/** Stop tracking a pair (cancelled or claimed — see `isExposed`). `status: "failed"` here means
 *  "no longer tracked," reusing the journal's action-state machine rather than a bespoke one. */
export function dropTrackedSubscription(
  journal: Journal,
  epochId: bigint,
  subscriber: Address,
  reason: string,
  logger: Logger,
): void {
  logger.info("underwriter: dropping subscription from the exposure registry", {
    epochId: epochId.toString(),
    subscriber,
    reason,
  });
  journal.recordFailed(SERVICE, ACTION, trackedKey(epochId, subscriber), reason);
}

/* ------------------------------------------------------------------ */
/* Pure aggregation — utilization and concentration                    */
/* ------------------------------------------------------------------ */

export interface SubscriptionExposure {
  subscriber: Address;
  ratePerSecond: bigint;
  coverageNotional: bigint;
  claimed: boolean;
}

export interface ExposureSummary {
  /** Sum of `coverageNotional` across every still-exposed subscription tracked. */
  totalNotional: bigint;
  /** The single largest still-exposed subscription's `coverageNotional`. */
  maxNotional: bigint;
  maxNotionalSubscriber: Address | null;
  activeCount: number;
}

/** A subscription still represents forward risk to the pool: never cancelled
 *  (`ratePerSecond == 0` is the contract's own "no subscription" invariant —
 *  `contracts/src/SigmaStream.sol`'s `NoSubscription`/`_sync` both read it) and not yet
 *  claimed (claiming is terminal — `AlreadyClaimed` — and settles the subscriber's exposure). */
export function isExposed(sub: Pick<SubscriptionExposure, "ratePerSecond" | "claimed">): boolean {
  return sub.ratePerSecond !== 0n && !sub.claimed;
}

export function summarizeExposure(subs: readonly SubscriptionExposure[]): ExposureSummary {
  let totalNotional = 0n;
  let maxNotional = 0n;
  let maxNotionalSubscriber: Address | null = null;
  let activeCount = 0;

  for (const s of subs) {
    if (!isExposed(s)) continue;
    activeCount += 1;
    totalNotional += s.coverageNotional;
    if (s.coverageNotional > maxNotional) {
      maxNotional = s.coverageNotional;
      maxNotionalSubscriber = s.subscriber;
    }
  }

  return { totalNotional, maxNotional, maxNotionalSubscriber, activeCount };
}

/** `numerator / denominator` as a WAD ratio, floored (same rounding direction as
 *  `shares.ts`). `0n` when `denominator` is `0` — display/decision use only, matching
 *  `sharePriceWad`'s "0 is a sentinel, not a real value" convention. Can legitimately
 *  exceed `1e18` (100%): aggregate sold notional is not capped by the contract — see
 *  module doc. */
export function ratioWad(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n;
  return mulDivDown(numerator, WAD, denominator);
}
