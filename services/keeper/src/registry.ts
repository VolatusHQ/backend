/**
 * The subscription registry: which (epochId, subscriber) pairs the keeper is
 * responsible for syncing.
 *
 * `Subscribed` logs on Arc are how the registry *grows*, but Arc prunes
 * history (BRIEF.md, `@volatus/service-kit`'s `logs.ts`) so a log scan can
 * never be the registry's source of truth — only ever an additive input to
 * it. `@volatus/service-kit`'s journal (`upsertSubscription` /
 * `listSubscriptions` / `dropSubscription`, keyed by `(epochId, subscriber)`)
 * is authoritative: once a subscription is written there, it stays tracked
 * until this module explicitly drops it, independent of whether a later log
 * scan could still see the block it was created in.
 *
 * `discoverSubscriptions` chunks forward from a persisted cursor
 * (`getCursor`/`setCursor`) so a restart resumes rather than rescanning.
 * When a chunk fails with Arc's pruning error, `getLogsChunked` already skips
 * it and keeps going into newer blocks (`prunedBefore` marks the floor); this
 * module records that floor under its own cursor key and says plainly, in
 * the log line, that anything before it never entered the registry via log
 * scanning and must be added with `seedSubscription`.
 */

import { getAbiItem, type Address, type PublicClient } from "viem";
import { sigmaStreamAbi } from "@volatus/onchain";
import { getLogsChunked, type Journal, type Logger } from "@volatus/service-kit";

export const SUBSCRIBED_CURSOR = "keeper:subscribed:cursor";
export const PRUNED_BEFORE_CURSOR = "keeper:subscribed:prunedBefore";

/** The `Subscribed` event, pulled once off the shared ABI rather than re-declared here. */
export const subscribedEvent = getAbiItem({ abi: sigmaStreamAbi, name: "Subscribed" });

export interface TrackedSubscription {
  epochId: bigint;
  subscriber: Address;
}

export interface DiscoveredSubscriptionPayload {
  epochId: string;
  subscriber: Address;
  /** The rate/notional at the moment `subscribe` was called — informational only.
   *  Live accrual state is always re-read from the chain, never from this payload. */
  initialRatePerSecond: string;
  initialCoverageNotional: string;
  discoveredAtBlock: string;
  source: "log" | "seed";
}

export interface DiscoverSubscriptionsOptions {
  journal: Journal;
  client: PublicClient;
  address: Address;
  /** Usually the latest block; passed in so a fake client in tests never calls a real RPC. */
  toBlock: bigint;
  /** Checkpoint to start from when the journal has no cursor yet — BACKEND_HANDOFF.md's
   *  "seed from a configurable checkpoint block." */
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
    const args = log.args as { epochId?: bigint; subscriber?: Address; ratePerSecond?: bigint; coverage?: bigint };
    if (args.epochId === undefined || args.subscriber === undefined) continue;

    const already = opts.journal
      .listSubscriptions(args.epochId)
      .some((s) => s.subscriber.toLowerCase() === args.subscriber!.toLowerCase());
    if (already) continue;

    const payload: DiscoveredSubscriptionPayload = {
      epochId: args.epochId.toString(),
      subscriber: args.subscriber,
      initialRatePerSecond: (args.ratePerSecond ?? 0n).toString(),
      initialCoverageNotional: (args.coverage ?? 0n).toString(),
      discoveredAtBlock: (log.blockNumber ?? 0n).toString(),
      source: "log",
    };
    opts.journal.upsertSubscription(args.epochId, args.subscriber, "active", payload);
    newSubscriptions += 1;
    opts.logger.info("keeper: discovered subscription from Subscribed log", {
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
      "keeper: Arc pruned history below this block — anything subscribed before it is invisible to log " +
        "scanning and will never be discovered this way. Track it with seedSubscription() if it still exists.",
      { prunedBefore: prunedBefore.toString() },
    );
  }

  return { scannedFrom: fromBlock, scannedTo: opts.toBlock, newSubscriptions, prunedBefore: effectivePrunedBefore };
}

/**
 * Manually register a subscription the log scan cannot see — either because
 * it predates `prunedBefore`, or because an operator wants to track it ahead
 * of ever seeing its `Subscribed` log. Idempotent: upserting an
 * already-tracked pair just refreshes its payload.
 */
export function seedSubscription(
  journal: Journal,
  epochId: bigint,
  subscriber: Address,
  payload: Partial<Omit<DiscoveredSubscriptionPayload, "source">> = {},
): void {
  journal.upsertSubscription(epochId, subscriber, "active", {
    epochId: epochId.toString(),
    subscriber,
    initialRatePerSecond: "0",
    initialCoverageNotional: "0",
    discoveredAtBlock: "0",
    ...payload,
    source: "seed",
  } satisfies DiscoveredSubscriptionPayload);
}

/** Every `(epochId, subscriber)` pair the registry currently considers active. */
export function listActiveSubscriptions(journal: Journal): TrackedSubscription[] {
  return journal
    .listSubscriptions()
    .filter((s) => s.status === "active")
    .map((s) => ({ epochId: BigInt(s.epochId), subscriber: s.subscriber as Address }));
}

export type DropReason = "cancelled" | "drained" | "epoch-ended";

export interface OnChainSubscriptionState {
  ratePerSecond: bigint;
  funded: bigint;
  coverageEnd: bigint;
  /** The contract's own `runwaySeconds` view — `funded / ratePerSecond` as of the last real sync,
   *  deliberately NOT the off-chain projection: a subscription is only dropped once the chain
   *  itself, not a guess, confirms it is drained. */
  runwaySeconds: bigint;
  now: bigint;
}

/**
 * BACKEND_HANDOFF.md § Service 2: "drop a subscription when any of:
 * ratePerSecond == 0 (cancelled), runwaySeconds == 0 && funded == 0
 * (drained), or the epoch is past coverageEnd." Checked in that order.
 */
export function evaluateDropReason(state: OnChainSubscriptionState): DropReason | null {
  if (state.ratePerSecond === 0n) return "cancelled";
  if (state.runwaySeconds === 0n && state.funded === 0n) return "drained";
  if (state.now > state.coverageEnd) return "epoch-ended";
  return null;
}

export function dropTrackedSubscription(
  journal: Journal,
  epochId: bigint,
  subscriber: Address,
  reason: DropReason,
  logger: Logger,
): void {
  logger.info("keeper: dropping subscription from the registry", {
    epochId: epochId.toString(),
    subscriber,
    reason,
  });
  journal.dropSubscription(epochId, subscriber);
}
