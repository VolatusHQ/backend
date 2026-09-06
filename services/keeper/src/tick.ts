/**
 * One keeper tick: extend the registry from Arc's log history, then for
 * every actively tracked subscription, read its live on-chain state, project
 * it forward, gate a real `sync` on whether it is worth the gas, and (unless
 * `dryRun`) send it. Used by both the `start` loop and the `status` command
 * (which always passes `dryRun: true` — see `status.ts`).
 *
 * A failure on one subscription is logged and does not stop the rest of the
 * tick — one bad read or a transient RPC error should not take the whole
 * keeper down for every other subscriber.
 */

import type { Address, PublicClient } from "viem";
import { sigmaStreamAbi } from "@volatus/onchain";
import type { Journal, Logger, Wallet, SendResult } from "@volatus/service-kit";
import { estimateSyncGasCostUsdc } from "./gas.js";
import { shouldSync, type GateDecision } from "./gate.js";
import { projectSubscription, type ProjectedSubscription } from "./project.js";
import {
  discoverSubscriptions,
  dropTrackedSubscription,
  evaluateDropReason,
  listActiveSubscriptions,
  type DiscoverSubscriptionsResult,
  type DropReason,
} from "./registry.js";
import type { GateTuning } from "./config.js";

export interface TickDeps {
  journal: Journal;
  client: PublicClient;
  address: Address;
  /** The keeper's own address — needed for `estimateGas`'s `from`, even though `sync` is permissionless. */
  keeperAddress: Address;
  logger: Logger;
  tuning: GateTuning;
  seedBlock: bigint;
  /** Omit entirely in read-only contexts (e.g. `status`) that never construct a signer. */
  wallet?: Wallet;
  dryRun: boolean;
  /** Injectable for tests. Unix seconds. */
  now?: () => bigint;
}

export interface SubscriptionTickResult {
  epochId: bigint;
  subscriber: Address;
  /** Raw on-chain state as read this tick — before projection. */
  ratePerSecond: bigint;
  lastSync: bigint;
  coverageEnd: bigint;
  projected: ProjectedSubscription;
  decision: GateDecision;
  gasCostEstimateUsdc: bigint;
  sendResult?: SendResult;
  dropReason?: DropReason;
  error?: string;
}

export interface TickSummary {
  nowTs: bigint;
  discovery: DiscoverSubscriptionsResult;
  results: SubscriptionTickResult[];
}

export async function runKeeperTick(deps: TickDeps): Promise<TickSummary> {
  const nowTs = deps.now ? deps.now() : BigInt(Math.floor(Date.now() / 1000));
  const latestBlock = await deps.client.getBlockNumber();

  const discovery = await discoverSubscriptions({
    journal: deps.journal,
    client: deps.client,
    address: deps.address,
    toBlock: latestBlock,
    seedBlock: deps.seedBlock,
    logger: deps.logger,
  });

  const tracked = listActiveSubscriptions(deps.journal);
  const results: SubscriptionTickResult[] = [];

  for (const sub of tracked) {
    try {
      results.push(await tickOneSubscription(deps, sub.epochId, sub.subscriber, nowTs));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error("keeper: tick failed for a tracked subscription", {
        epochId: sub.epochId.toString(),
        subscriber: sub.subscriber,
        err: message,
      });
      results.push({
        epochId: sub.epochId,
        subscriber: sub.subscriber,
        ratePerSecond: 0n,
        lastSync: 0n,
        coverageEnd: 0n,
        projected: projectSubscription({ ratePerSecond: 0n, funded: 0n, lastSync: 0n, coveredSeconds: 0n }, 0n, 0n),
        decision: { due: false, reason: "nothing-elapsed", coverageRatio: 0 },
        gasCostEstimateUsdc: 0n,
        error: message,
      });
    }
  }

  return { nowTs, discovery, results };
}

async function tickOneSubscription(
  deps: TickDeps,
  epochId: bigint,
  subscriber: Address,
  nowTs: bigint,
): Promise<SubscriptionTickResult> {
  const [subscription, epoch, runwaySeconds] = await Promise.all([
    deps.client.readContract({
      address: deps.address,
      abi: sigmaStreamAbi,
      functionName: "subscription",
      args: [epochId, subscriber],
    }),
    deps.client.readContract({
      address: deps.address,
      abi: sigmaStreamAbi,
      functionName: "epoch",
      args: [epochId],
    }),
    deps.client.readContract({
      address: deps.address,
      abi: sigmaStreamAbi,
      functionName: "runwaySeconds",
      args: [epochId, subscriber],
    }),
  ]);

  const projected = projectSubscription(
    {
      ratePerSecond: subscription.ratePerSecond,
      funded: subscription.funded,
      lastSync: subscription.lastSync,
      coveredSeconds: subscription.coveredSeconds,
    },
    nowTs,
    epoch.coverageEnd,
  );

  let decision: GateDecision = { due: false, reason: "nothing-elapsed", coverageRatio: 0 };
  let gasCostEstimateUsdc = 0n;
  let sendResult: SendResult | undefined;

  if (projected.elapsedSeconds > 0n) {
    gasCostEstimateUsdc = await estimateSyncGasCostUsdc({
      client: deps.client,
      address: deps.address,
      abi: sigmaStreamAbi,
      epochId,
      subscriber,
      account: deps.keeperAddress,
    });

    decision = shouldSync({
      projected,
      coverageEnd: epoch.coverageEnd,
      gasCostEstimateUsdc,
      safetyFactor: deps.tuning.safetyFactor,
      maxSyncIntervalSeconds: deps.tuning.maxSyncIntervalSeconds,
      epochEndMarginSeconds: deps.tuning.epochEndMarginSeconds,
      drainMarginSeconds: deps.tuning.drainMarginSeconds,
    });

    if (decision.due) {
      if (deps.dryRun) {
        deps.logger.info("keeper: dry-run — would sync", {
          epochId: epochId.toString(),
          subscriber,
          reason: decision.reason,
          accruedPremium: projected.accruedPremium.toString(),
          gasCostEstimateUsdc: gasCostEstimateUsdc.toString(),
          coverageRatio: decision.coverageRatio,
        });
      } else if (deps.wallet) {
        sendResult = await deps.wallet.send({
          address: deps.address,
          abi: sigmaStreamAbi,
          functionName: "sync",
          args: [epochId, subscriber],
        });
        if (sendResult.ok) {
          deps.logger.info("keeper: synced", {
            epochId: epochId.toString(),
            subscriber,
            hash: sendResult.hash,
            reason: decision.reason,
            accruedPremium: projected.accruedPremium.toString(),
          });
        } else {
          deps.logger.error("keeper: sync send failed", {
            epochId: epochId.toString(),
            subscriber,
            reason: sendResult.reason,
            revertName: sendResult.revertName,
          });
        }
      } else {
        deps.logger.error("keeper: sync is due but no wallet was provided (read-only context)", {
          epochId: epochId.toString(),
          subscriber,
        });
      }
    }
  }

  // Evaluate the drop rule (and, if warranted, drop) *after* the send above, so a
  // subscription that just crossed coverageEnd or ran dry gets one last attempt at
  // sweeping whatever premium is still unswept before it leaves the registry.
  const dropReason = evaluateDropReason({
    ratePerSecond: subscription.ratePerSecond,
    funded: subscription.funded,
    coverageEnd: epoch.coverageEnd,
    runwaySeconds,
    now: nowTs,
  });
  if (dropReason) {
    dropTrackedSubscription(deps.journal, epochId, subscriber, dropReason, deps.logger);
  }

  return {
    epochId,
    subscriber,
    ratePerSecond: subscription.ratePerSecond,
    lastSync: subscription.lastSync,
    coverageEnd: epoch.coverageEnd,
    projected,
    decision,
    gasCostEstimateUsdc,
    sendResult,
    dropReason: dropReason ?? undefined,
  };
}
