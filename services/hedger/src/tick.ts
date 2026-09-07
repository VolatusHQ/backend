/**
 * One hedger pass for one mandate: read the oracle, the LP's v4 position,
 * and the live subscription; compute a target; adjust and/or fund if the
 * mandate says it is due; report everything either way. Used by `start`'s
 * loop, by `status` (always `dryRun: true`, no `signer`), and by the single
 * permitted live demonstration (`once`).
 *
 * Read order mirrors BACKEND_HANDOFF.md § Service 3 exactly:
 *
 *   1. `tryImpliedVol` — `ok === false` stops everything below it. There is
 *      no way to reach a target, an adjust decision, or a fund decision
 *      without a real `impliedVolWad`, because `ImpliedVolResult`'s `false`
 *      branch simply does not carry one — this is enforced by the type,
 *      not just by an `if`.
 *   2. the LP's v4 position + the pool's current liquidity/tick (`gamma.ts`).
 *   3. the live subscription and epoch on Arc.
 *   4. `pricing.ts`'s target, `drift.ts`'s adjust decision, `fundGate.ts`'s
 *      fund decision (evaluated against the freshest subscription state —
 *      re-read once after a successful adjust, since `adjust` runs `_sync`
 *      internally and moves `funded`/`lastSync`).
 *
 * A failure sending one action does not stop this function early; it is
 * recorded and the tick's result reports it, matching the keeper/reporter's
 * own "one bad send should not take the whole tick down" convention.
 */

import type { Address, Hex, PublicClient } from "viem";
import { erc20Abi, sigmaStreamAbi } from "@volatus/onchain";
import type { Journal, Logger, SendResult } from "@volatus/service-kit";
import { SERVICE } from "./constants.js";
import type { AdjustDecision } from "./drift.js";
import { shouldAdjust } from "./drift.js";
import type { FundDecision } from "./fundGate.js";
import { shouldFund } from "./fundGate.js";
import type { PositionSignal } from "./gamma.js";
import { computePositionSignal } from "./gamma.js";
import { resolveClaim } from "./journalReconcile.js";
import type { Mandate } from "./mandate.js";
import { mandateExpired } from "./mandate.js";
import { classifyAdjustRevert, classifyFundRevert, FatalHedgerError } from "./outcomes.js";
import type { ImpliedVolResult } from "./oracle.js";
import { readImpliedVol } from "./oracle.js";
import { findOwnedPositions, readMeasuredPoolState } from "./position.js";
import type { CoverageTarget } from "./pricing.js";
import { computeTarget } from "./pricing.js";
import type { ProjectedSubscription } from "./runway.js";
import { projectSubscription } from "./runway.js";
import { adjustActionName, cumulativeSpentUsdc, fundActionName, nextSequence, type FundResult } from "./spend.js";
import type { Signer } from "./delegation/signer.js";

export interface SubscriptionView {
  ratePerSecond: bigint;
  coverageNotional: bigint;
  funded: bigint;
  lastSync: bigint;
  coveredSeconds: bigint;
}

export interface HedgerTickDeps {
  mandate: Mandate;
  journal: Journal;
  unichainClient: PublicClient;
  arcClient: PublicClient;
  logger: Logger;
  /** Omit entirely in read-only contexts (`status`) that never construct a signer. */
  signer?: Signer;
  dryRun: boolean;
  /** Floor for the v4 position log scan — see `config.ts`'s `MEASURED_VAULT_DEPLOY_BLOCK`. */
  positionScanFromBlock: bigint;
  /** Injectable for tests. Unix seconds. */
  now?: () => bigint;
}

export interface HedgerTickResult {
  nowTs: bigint;
  mandateExpired: boolean;
  ivResult: ImpliedVolResult;
  capacityPool: bigint;
  epochCoverageEnd: bigint;
  subscription: SubscriptionView;
  cumulativeSpentUsdc: bigint;
  /** Set once step 1 (the oracle) stops the tick — nothing past it runs. */
  skippedReason?: string;

  position?: PositionSignal;
  target?: CoverageTarget;
  adjustDecision?: AdjustDecision;
  adjustSendResult?: SendResult;
  projectedRunway?: ProjectedSubscription;
  fundDecision?: FundDecision;
  approveSendResult?: SendResult;
  fundSendResult?: SendResult;
}

async function readSubscription(client: PublicClient, mandate: Mandate): Promise<SubscriptionView> {
  return client.readContract({
    address: mandate.streamAddress,
    abi: sigmaStreamAbi,
    functionName: "subscription",
    args: [mandate.epochId, mandate.owner],
  });
}

export async function runHedgerTick(deps: HedgerTickDeps): Promise<HedgerTickResult> {
  const { mandate, journal, unichainClient, arcClient, logger, signer, dryRun } = deps;
  const nowTs = deps.now ? deps.now() : BigInt(Math.floor(Date.now() / 1000));
  const expired = mandateExpired(mandate, nowTs);

  const [epoch, subscription, capacityPool] = await Promise.all([
    arcClient.readContract({ address: mandate.streamAddress, abi: sigmaStreamAbi, functionName: "epoch", args: [mandate.epochId] }),
    readSubscription(arcClient, mandate),
    arcClient.readContract({ address: mandate.streamAddress, abi: sigmaStreamAbi, functionName: "capacityPool" }),
  ]);

  const spentSoFar = cumulativeSpentUsdc(journal, mandate.id);

  // Step 1 — the hard rule. `ImpliedVolResult`'s `ok: false` branch carries no
  // `impliedVolWad`, so nothing past this point can be computed without a
  // real feed value; there is no code path from here to an adjust or a fund.
  const ivResult = await readImpliedVol(unichainClient, mandate.poolId);
  if (!ivResult.ok) {
    logger.warn("hedger: SigmaOracle.tryImpliedVol returned ok=false — taking no action this tick", {
      mandateId: mandate.id,
      poolId: mandate.poolId,
    });
    return {
      nowTs,
      mandateExpired: expired,
      ivResult,
      capacityPool,
      epochCoverageEnd: epoch.coverageEnd,
      subscription,
      cumulativeSpentUsdc: spentSoFar,
      skippedReason: "oracle: tryImpliedVol returned ok=false — no action taken (hard rule)",
    };
  }

  // Step 2 — gamma exposure.
  const [positions, poolState, latestUnichainBlock] = await Promise.all([
    findOwnedPositions({
      client: unichainClient,
      owner: mandate.owner,
      fromBlock: deps.positionScanFromBlock,
      toBlock: await unichainClient.getBlockNumber(),
    }),
    readMeasuredPoolState(unichainClient),
    unichainClient.getBlockNumber(),
  ]);
  void latestUnichainBlock; // read once above via findOwnedPositions' own toBlock argument; kept for clarity, not reused.

  const biggest = positions.reduce<(typeof positions)[number] | null>(
    (best, p) => (best === null || p.liquidity > best.liquidity ? p : best),
    null,
  );
  const position = computePositionSignal(biggest, poolState.liquidity, poolState.currentTick);

  // Step 3 was already read above (subscription, epoch, capacityPool).

  // Step 4 — target, then the two gated actions.
  const target = computeTarget({
    mandate,
    ivWad: ivResult.impliedVolWad,
    positionFound: position.found,
    positionWeightWad: position.positionWeightWad,
    capacityPool,
    currentCoverageNotional: subscription.coverageNotional,
  });

  const adjustDecision = shouldAdjust(
    { ratePerSecond: subscription.ratePerSecond, coverageNotional: subscription.coverageNotional },
    target,
    mandate.driftToleranceBps,
  );

  let adjustSendResult: SendResult | undefined;
  if (adjustDecision.due) {
    if (expired) {
      logger.warn("hedger: adjust is due but the mandate has expired — refusing", { mandateId: mandate.id });
    } else if (dryRun || !signer) {
      logger.info("hedger: [dry-run] would adjust", {
        mandateId: mandate.id,
        epochId: mandate.epochId.toString(),
        reason: adjustDecision.reason,
        fromRate: subscription.ratePerSecond.toString(),
        toRate: target.ratePerSecond.toString(),
        fromNotional: subscription.coverageNotional.toString(),
        toNotional: target.coverageNotional.toString(),
      });
    } else {
      adjustSendResult = await sendAdjust({ mandate, journal, arcClient, logger, signer, target });
    }
  }

  // Fund gate uses the freshest subscription state — `adjust` runs `_sync`
  // internally, so a successful adjust just moved `funded`/`lastSync`.
  const latestSubscription = adjustSendResult?.ok ? await readSubscription(arcClient, mandate) : subscription;
  const projectedRunway = projectSubscription(
    {
      ratePerSecond: latestSubscription.ratePerSecond,
      funded: latestSubscription.funded,
      lastSync: latestSubscription.lastSync,
      coveredSeconds: latestSubscription.coveredSeconds,
    },
    nowTs,
    epoch.coverageEnd,
  );

  const fundDecision = shouldFund({
    ratePerSecond: latestSubscription.ratePerSecond,
    projected: projectedRunway,
    mandate,
    cumulativeSpentUsdc: spentSoFar,
  });

  let approveSendResult: SendResult | undefined;
  let fundSendResult: SendResult | undefined;
  if (fundDecision.due) {
    if (expired) {
      logger.warn("hedger: fund is due but the mandate has expired — refusing", { mandateId: mandate.id });
    } else if (dryRun || !signer) {
      logger.info("hedger: [dry-run] would fund", {
        mandateId: mandate.id,
        epochId: mandate.epochId.toString(),
        amountUsdc: fundDecision.amountUsdc.toString(),
        reason: fundDecision.reason,
      });
    } else {
      const outcome = await sendFund({ mandate, journal, arcClient, logger, signer, amountUsdc: fundDecision.amountUsdc });
      approveSendResult = outcome.approveSendResult;
      fundSendResult = outcome.fundSendResult;
    }
  }

  return {
    nowTs,
    mandateExpired: expired,
    ivResult,
    capacityPool,
    epochCoverageEnd: epoch.coverageEnd,
    subscription,
    cumulativeSpentUsdc: spentSoFar,
    position,
    target,
    adjustDecision,
    adjustSendResult,
    projectedRunway,
    fundDecision,
    approveSendResult,
    fundSendResult,
  };
}

async function sendAdjust(params: {
  mandate: Mandate;
  journal: Journal;
  arcClient: PublicClient;
  logger: Logger;
  signer: Signer;
  target: CoverageTarget;
}): Promise<SendResult | undefined> {
  const { mandate, journal, arcClient, logger, signer, target } = params;
  const action = adjustActionName(mandate.id);
  const key = nextSequence(journal, `${action}:seq`).toString();

  const decision = await resolveClaim({
    journal,
    service: SERVICE,
    action,
    key,
    publicClient: arcClient,
    isDoneOnChain: async () => {
      const s = await readSubscription(arcClient, mandate);
      return s.ratePerSecond === target.ratePerSecond && s.coverageNotional === target.coverageNotional;
    },
    logger,
  });
  if (!decision.proceed) {
    logger.info(`hedger: skipping adjust(${key}): ${decision.reason}`, { mandateId: mandate.id });
    return undefined;
  }

  // adjust(epochId, newRatePerSecond, newCoverageNotional) — the exact order
  // ISigmaStream/sigmaStreamAbi declare. Never reorder, never rescale.
  const result = await signer.callStream("adjust", [mandate.epochId, target.ratePerSecond, target.coverageNotional]);

  if (result.ok) {
    journal.recordDone(SERVICE, action, key, result.hash, {
      ratePerSecond: target.ratePerSecond.toString(),
      coverageNotional: target.coverageNotional.toString(),
    });
    logger.info(`hedger: adjust(${key}) landed`, { mandateId: mandate.id, hash: result.hash });
    return result;
  }

  const outcome = classifyAdjustRevert(result.revertName);
  if (outcome.kind === "success") {
    journal.recordDone(SERVICE, action, key, "already-adjusted-onchain", { reconciled: true });
  } else if (outcome.kind === "terminal") {
    journal.recordDone(SERVICE, action, key, "terminal-failure", { reason: outcome.reason });
    logger.error(`hedger: adjust(${key}) terminally failed, will not retry`, { mandateId: mandate.id, reason: outcome.reason });
  } else if (outcome.kind === "fatal") {
    journal.recordFailed(SERVICE, action, key, outcome.reason);
    logger.error(`hedger: adjust(${key}) FATAL`, { mandateId: mandate.id, reason: outcome.reason });
    throw new FatalHedgerError(outcome.reason);
  } else {
    journal.recordFailed(SERVICE, action, key, result.reason);
    logger.warn(`hedger: adjust(${key}) failed, will retry next tick`, { mandateId: mandate.id, reason: result.reason });
  }
  return result;
}

async function sendFund(params: {
  mandate: Mandate;
  journal: Journal;
  arcClient: PublicClient;
  logger: Logger;
  signer: Signer;
  amountUsdc: bigint;
}): Promise<{ approveSendResult?: SendResult; fundSendResult?: SendResult }> {
  const { mandate, journal, arcClient, logger, signer, amountUsdc } = params;

  const allowance = await arcClient.readContract({
    address: mandate.usdcAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: [signer.address, mandate.streamAddress],
  });

  let approveSendResult: SendResult | undefined;
  if (allowance < amountUsdc) {
    // `fund` reverts on the ERC-20 allowance check before it ever reaches
    // SigmaStream's own logic without this — BACKEND_HANDOFF.md/README.md
    // both call this out explicitly as easy to miss.
    approveSendResult = await signer.approveStreamSpend(amountUsdc);
    if (!approveSendResult.ok) {
      logger.error("hedger: USDC approve to SigmaStream failed — skipping fund this tick", {
        mandateId: mandate.id,
        reason: approveSendResult.reason,
      });
      return { approveSendResult };
    }
  }

  const action = fundActionName(mandate.id);
  const key = nextSequence(journal, `${action}:seq`).toString();

  const decision = await resolveClaim({
    journal,
    service: SERVICE,
    action,
    key,
    publicClient: arcClient,
    // `funded` moves continuously via every `sync`, so there is no stable
    // on-chain flag that means "this specific top-up landed." Refuse to
    // guess in the no-hash crash case rather than risk double-funding —
    // same conservative choice `journalReconcile.ts`'s header documents.
    isDoneOnChain: async () => false,
    logger,
  });
  if (!decision.proceed) {
    logger.info(`hedger: skipping fund(${key}): ${decision.reason}`, { mandateId: mandate.id });
    return { approveSendResult };
  }

  const fundSendResult = await signer.callStream("fund", [mandate.epochId, amountUsdc]);

  if (fundSendResult.ok) {
    journal.recordDone(SERVICE, action, key, fundSendResult.hash, { amountUsdc: amountUsdc.toString() } satisfies FundResult);
    logger.info(`hedger: fund(${key}) landed`, { mandateId: mandate.id, hash: fundSendResult.hash, amountUsdc: amountUsdc.toString() });
    return { approveSendResult, fundSendResult };
  }

  const outcome = classifyFundRevert(fundSendResult.revertName);
  if (outcome.kind === "success") {
    journal.recordDone(SERVICE, action, key, "already-funded-onchain", { reconciled: true });
  } else if (outcome.kind === "terminal") {
    journal.recordDone(SERVICE, action, key, "terminal-failure", { reason: outcome.reason });
    logger.error(`hedger: fund(${key}) terminally failed, will not retry`, { mandateId: mandate.id, reason: outcome.reason });
  } else if (outcome.kind === "fatal") {
    journal.recordFailed(SERVICE, action, key, outcome.reason);
    throw new FatalHedgerError(outcome.reason);
  } else {
    journal.recordFailed(SERVICE, action, key, fundSendResult.reason);
    logger.warn(`hedger: fund(${key}) failed, will retry next tick`, { mandateId: mandate.id, reason: fundSendResult.reason });
  }
  return { approveSendResult, fundSendResult };
}
