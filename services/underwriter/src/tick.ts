/**
 * One underwriter tick: read the market signal (Unichain), read the capacity
 * signal (Arc: `capacityPool`, `totalShares`, this agent's own `shares`),
 * extend and re-read the subscription registry to get utilization and
 * concentration, run the policy, check the spending cap, and — unless
 * `dryRun` — send. Used by both the `start` loop and the `status` command
 * (which always passes `dryRun: true`, see `status.ts`/`index.ts`).
 *
 * A failure reading one tracked subscription is logged and does not stop the
 * tick — mirrors `services/keeper`'s tick, for the same reason: one bad read
 * should not take down every other signal this tick was computing.
 *
 * **This is the only module (besides `capacity.ts`, which it calls) allowed
 * to broadcast `postCapacity`/`withdrawCapacity`.** Every other module in
 * this service stops at a `PolicyDecision`.
 */

import type { Address, Hex, PublicClient } from "viem";
import { sigmaStreamAbi } from "@volatus/onchain";
import type { AlertFn, Journal, Logger, SendResult, Wallet } from "@volatus/service-kit";
import { approveAndPostCapacity, sendWithdrawCapacity } from "./capacity.js";
import { checkSpendCap, loadSpendHistory, recordSpend, type CapDecision, type SpendCapTuning } from "./caps.js";
import { decide, type PolicyDecision, type PolicyTuning } from "./policy.js";
import {
  discoverSubscriptions,
  dropTrackedSubscription,
  isExposed,
  listTrackedSubscriptions,
  summarizeExposure,
  type DiscoverSubscriptionsResult,
  type ExposureSummary,
} from "./registry.js";
import { readMarketSignal, type MarketSignal } from "./signals.js";
import { sharePriceWad } from "./shares.js";

export interface TickDeps {
  journal: Journal;
  unichainClient: PublicClient;
  arcClient: PublicClient;
  streamAddress: Address;
  usdcAddress: Address;
  oracleAddress: Address;
  vaultAddress: Address;
  hookAddress: Address;
  poolId: Hex;
  logger: Logger;
  policyTuning: PolicyTuning;
  spendCapTuning: SpendCapTuning;
  seedBlock: bigint;
  /** Whether `tick.ts` may send a withdrawal the policy flagged `wouldBlockSubscriptions`.
   *  Default posture (see `config.ts`) is false: log loudly and refuse. */
  allowBlockingWithdrawals: boolean;
  /** This agent's own on-chain address — needed to read `shares(address)` even in a
   *  read-only context that never constructs a signer (`status`). */
  walletAddress: Address;
  /** Omit entirely in read-only contexts. Required to actually send anything. */
  wallet?: Wallet;
  dryRun: boolean;
  alert?: AlertFn;
  /** Injectable for tests. Unix seconds. */
  now?: () => bigint;
}

export interface TickSummary {
  nowTs: bigint;
  discovery: DiscoverSubscriptionsResult;
  market: MarketSignal;
  capacityPool: bigint;
  totalShares: bigint;
  sharePriceWad: bigint;
  ownShares: bigint;
  exposure: ExposureSummary;
  decision: PolicyDecision;
  capDecision?: CapDecision;
  approveSendResult?: SendResult;
  sendResult?: SendResult;
  mintedShares?: bigint;
  /** True when a "post" was skipped because `checkSpendCap` refused it. */
  blockedByCap?: boolean;
  /** True when a "withdraw" was skipped because it would block subscriptions and
   *  `allowBlockingWithdrawals` is not set. */
  blockedByGuard?: boolean;
  error?: string;
}

export async function runUnderwriterTick(deps: TickDeps): Promise<TickSummary> {
  const nowTs = deps.now ? deps.now() : BigInt(Math.floor(Date.now() / 1000));

  // `VolatusOracle.realizedVol`/`impliedVol` both revert `NoActiveEpoch` when
  // `activeEpoch(poolId) == 0` -- a real, if brief, window: the pool sits
  // there between an epoch settling and the next one opening (e.g. while
  // `services/roller` is mid-rollover). `readMarketSignal` does not guard
  // against that revert, so it is wrapped here rather than letting an
  // expected transient state crash the whole tick. Falls back to the same
  // "no data" shape `dataSufficient`/`oracleOk` already exist to represent
  // (see signals.ts's module doc) -- `policy.ts` already holds on that.
  let market: MarketSignal;
  try {
    market = await readMarketSignal({
      client: deps.unichainClient,
      oracleAddress: deps.oracleAddress,
      vaultAddress: deps.vaultAddress,
      hookAddress: deps.hookAddress,
      poolId: deps.poolId,
    });
  } catch (err) {
    deps.logger.warn("underwriter: readMarketSignal reverted (likely no active epoch mid-rollover) -- treating as no data this tick", {
      err: err instanceof Error ? err.message : String(err),
    });
    market = {
      oracleOk: false,
      impliedVolWad: 0n,
      realizedVolWad: 0n,
      hasActiveEpoch: false,
      accumulatorNow: 0n,
      startAccumulator: 0n,
      observations: 0,
      dataSufficient: false,
      spreadWad: null,
    };
  }

  const [capacityPool, totalShares, ownShares, latestArcBlock] = await Promise.all([
    deps.arcClient.readContract({ address: deps.streamAddress, abi: sigmaStreamAbi, functionName: "capacityPool" }),
    deps.arcClient.readContract({ address: deps.streamAddress, abi: sigmaStreamAbi, functionName: "totalShares" }),
    deps.arcClient.readContract({
      address: deps.streamAddress,
      abi: sigmaStreamAbi,
      functionName: "shares",
      args: [deps.walletAddress],
    }),
    deps.arcClient.getBlockNumber(),
  ]);

  const discovery = await discoverSubscriptions({
    journal: deps.journal,
    client: deps.arcClient,
    address: deps.streamAddress,
    toBlock: latestArcBlock,
    seedBlock: deps.seedBlock,
    logger: deps.logger,
  });

  const tracked = listTrackedSubscriptions(deps.journal);
  const exposures: { subscriber: Address; ratePerSecond: bigint; coverageNotional: bigint; claimed: boolean }[] = [];

  for (const sub of tracked) {
    try {
      const subscription = await deps.arcClient.readContract({
        address: deps.streamAddress,
        abi: sigmaStreamAbi,
        functionName: "subscription",
        args: [sub.epochId, sub.subscriber],
      });
      exposures.push({
        subscriber: sub.subscriber,
        ratePerSecond: subscription.ratePerSecond,
        coverageNotional: subscription.coverageNotional,
        claimed: subscription.claimed,
      });
      if (!isExposed(subscription)) {
        dropTrackedSubscription(
          deps.journal,
          sub.epochId,
          sub.subscriber,
          subscription.claimed ? "claimed" : "cancelled",
          deps.logger,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error("underwriter: failed to read a tracked subscription -- excluded from this tick's exposure", {
        epochId: sub.epochId.toString(),
        subscriber: sub.subscriber,
        err: message,
      });
    }
  }

  const exposure = summarizeExposure(exposures);

  const decision = decide(
    {
      oracleOk: market.oracleOk,
      dataSufficient: market.dataSufficient,
      spreadWad: market.spreadWad,
      capacityPool,
      totalShares,
      totalNotional: exposure.totalNotional,
      maxNotional: exposure.maxNotional,
      maxNotionalSubscriber: exposure.maxNotionalSubscriber,
      ownShares,
    },
    deps.policyTuning,
  );

  const summary: TickSummary = {
    nowTs,
    discovery,
    market,
    capacityPool,
    totalShares,
    sharePriceWad: sharePriceWad(capacityPool, totalShares),
    ownShares,
    exposure,
    decision,
  };

  if (decision.intent === "post") {
    await handlePost(deps, decision, nowTs, summary);
  } else if (decision.intent === "withdraw") {
    await handleWithdraw(deps, decision, summary);
  }

  return summary;
}

async function handlePost(deps: TickDeps, decision: PolicyDecision, nowTs: bigint, summary: TickSummary): Promise<void> {
  const amountUsdc = decision.postAmountUsdc!;
  const amountUsdcNumber = Number(amountUsdc) / 1e6;

  const capDecision = checkSpendCap(deps.spendCapTuning, loadSpendHistory(deps.journal), Number(nowTs), amountUsdcNumber);
  summary.capDecision = capDecision;

  if (!capDecision.allowed) {
    summary.blockedByCap = true;
    deps.logger.warn("underwriter: post refused by the spending cap enforced in this service's own code", {
      proposedUsdc: amountUsdcNumber,
      reason: capDecision.reason,
    });
    await deps.alert?.("warn", "underwriter: postCapacity refused by spending cap", { reason: capDecision.reason });
    return;
  }

  if (deps.dryRun) {
    deps.logger.info("underwriter: dry-run -- would post capacity", { amountUsdc: amountUsdcNumber, reason: decision.reason });
    return;
  }

  if (!deps.wallet) {
    deps.logger.error("underwriter: post is due but no wallet was provided (read-only context)");
    return;
  }

  const result = await approveAndPostCapacity({
    wallet: deps.wallet,
    client: deps.arcClient,
    usdcAddress: deps.usdcAddress,
    streamAddress: deps.streamAddress,
    amount: amountUsdc,
  });
  summary.approveSendResult = result.approveSendResult;
  summary.sendResult = result.postSendResult;
  summary.mintedShares = result.mintedShares;

  if (result.ok && result.postSendResult?.ok) {
    recordSpend(deps.journal, result.postSendResult.hash, amountUsdcNumber, Number(nowTs));
    deps.logger.info("underwriter: posted capacity", {
      amountUsdc: amountUsdcNumber,
      hash: result.postSendResult.hash,
      mintedShares: result.mintedShares?.toString(),
    });
  } else {
    summary.error = result.reason;
    deps.logger.error("underwriter: postCapacity failed", { reason: result.reason });
  }
}

async function handleWithdraw(deps: TickDeps, decision: PolicyDecision, summary: TickSummary): Promise<void> {
  const shareAmount = decision.withdrawShareAmount!;

  if (decision.wouldBlockSubscriptions && !deps.allowBlockingWithdrawals) {
    summary.blockedByGuard = true;
    deps.logger.warn(
      "underwriter: withdrawal WOULD BLOCK new subscriptions (projected capacityPool would fall below the " +
        "largest tracked subscriber's coverageNotional) -- refusing to send. This is surfaced, not routed " +
        "around: set UW_ALLOW_BLOCKING_WITHDRAWALS=1 to override.",
      { withdrawShareAmount: shareAmount.toString(), reason: decision.reason },
    );
    await deps.alert?.("warn", "underwriter: withdrawal would block new subscriptions -- refused", {
      reason: decision.reason,
      withdrawShareAmount: shareAmount.toString(),
    });
    return;
  }

  if (deps.dryRun) {
    deps.logger.info("underwriter: dry-run -- would withdraw capacity", {
      withdrawShareAmount: shareAmount.toString(),
      reason: decision.reason,
      wouldBlockSubscriptions: decision.wouldBlockSubscriptions,
    });
    return;
  }

  if (!deps.wallet) {
    deps.logger.error("underwriter: withdraw is due but no wallet was provided (read-only context)");
    return;
  }

  const sendResult = await sendWithdrawCapacity({ wallet: deps.wallet, streamAddress: deps.streamAddress, shareAmount });
  summary.sendResult = sendResult;
  if (sendResult.ok) {
    deps.logger.info("underwriter: withdrew capacity", { hash: sendResult.hash, withdrawShareAmount: shareAmount.toString() });
  } else {
    summary.error = sendResult.reason;
    deps.logger.error("underwriter: withdrawCapacity failed", { reason: sendResult.reason });
  }
}
