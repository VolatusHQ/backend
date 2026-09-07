/**
 * Job 1a — mirror a new vault epoch onto Arc (BACKEND_HANDOFF.md § Service 1).
 *
 * Discovery watches `SigmaVault.EpochOpened` on Unichain via
 * `getLogsChunked`, resuming from a journal cursor so a restart re-scans
 * only what it missed, not the whole chain. Mirroring is idempotent two
 * ways at once, per the handoff: an on-chain read (`stream.epoch(id)
 * .coverageEnd != 0`) checked before ever touching the journal, and the
 * journal's own `claim`/reconcile machinery for the crash-mid-send case.
 */

import { getAbiItem, parseEventLogs, type PublicClient } from "viem";
import {
  sigmaStreamAbi,
  sigmaVaultAbi,
  SIGMA_STREAM,
  SIGMA_VAULT,
} from "@volatus/onchain";
import { getLogsChunked, type Journal, type Wallet } from "@volatus/service-kit";
import { EPOCH_SCAN_CURSOR, SERVICE } from "./constants.js";
import { classifyOpenEpochRevert, FatalReporterError } from "./outcomes.js";
import { resolveClaim, type Logger } from "./journalReconcile.js";
import { computeCoverageEnd, computeReportDeadline, measureUnichainBlockTime, shouldMirrorEpoch } from "./time.js";
import type { AlertFn } from "@volatus/service-kit";

const epochOpenedEvent = getAbiItem({ abi: sigmaVaultAbi, name: "EpochOpened" });

export interface DiscoveryContext {
  journal: Journal;
  unichainClient: PublicClient;
  arcClient: PublicClient;
  arcWallet: Wallet;
  logger: Logger;
  alert: AlertFn;
  reportDeadlineMarginSeconds: bigint;
  scanStartBlock: bigint;
  dryRun: boolean;
}

/**
 * Scan `[cursor+1, latest]` (or `[scanStartBlock, latest]` with no cursor
 * yet) for `EpochOpened`, mirror every epoch found, then advance the cursor
 * to `latest` — but only on a real (non-dry) run, so a dry run never leaves
 * a side effect a later real run would have to account for (including the
 * cursor itself: a dry run always rescans from the last *real* run's
 * position, never its own).
 *
 * Returns every epoch id found in this pass. `tick.ts` unions this with
 * `listKnownEpochIds` (journal-derived) before running job 1b, so that a dry
 * run — which never writes to the journal — still previews settle/report for
 * epochs discovered in the very scan it just did, on an otherwise-empty
 * journal.
 */
export async function discoverAndMirrorEpochs(ctx: DiscoveryContext): Promise<bigint[]> {
  const latest = await ctx.unichainClient.getBlockNumber();
  const cursor = ctx.journal.getCursor(EPOCH_SCAN_CURSOR);
  const fromBlock = cursor !== null ? cursor + 1n : ctx.scanStartBlock;
  if (fromBlock > latest) return [];

  const { logs, prunedBefore } = await getLogsChunked({
    client: ctx.unichainClient,
    address: SIGMA_VAULT,
    event: epochOpenedEvent,
    fromBlock,
    toBlock: latest,
  });

  if (prunedBefore !== undefined) {
    ctx.logger.warn("EpochOpened backfill hit pruned Unichain history; some early epochs may be missed", {
      prunedBefore: prunedBefore.toString(),
      requestedFrom: fromBlock.toString(),
    });
  }

  const discovered: bigint[] = [];
  for (const log of logs) {
    const epochId = log.args.epochId;
    if (epochId === undefined) continue; // indexed arg always decodes; defensive only
    discovered.push(epochId);
    await mirrorEpoch({ ...ctx, epochId });
  }

  if (!ctx.dryRun) ctx.journal.setCursor(EPOCH_SCAN_CURSOR, latest);
  return discovered;
}

export interface MirrorEpochParams {
  epochId: bigint;
  journal: Journal;
  unichainClient: PublicClient;
  arcClient: PublicClient;
  arcWallet: Wallet;
  logger: Logger;
  alert: AlertFn;
  reportDeadlineMarginSeconds: bigint;
  dryRun: boolean;
}

export async function mirrorEpoch(params: MirrorEpochParams): Promise<void> {
  const key = params.epochId.toString();
  const readArcEpoch = () =>
    params.arcClient.readContract({
      address: SIGMA_STREAM,
      abi: sigmaStreamAbi,
      functionName: "epoch",
      args: [params.epochId],
    });

  // On-chain idempotency check FIRST, in addition to the journal claim
  // (BACKEND_HANDOFF.md). This also catches epoch 2, mirrored by hand before
  // this service ever ran: the journal wouldn't know about it otherwise, and
  // job 1b discovers "known epochs" from this journal action, so recording
  // it here is what lets settle/report ever get attempted for it.
  const alreadyOpen = (await readArcEpoch()).coverageEnd !== 0n;
  if (alreadyOpen) {
    if (!params.dryRun && params.journal.claim(SERVICE, "openEpoch", key) === "fresh") {
      params.journal.recordDone(SERVICE, "openEpoch", key, "already-open-onchain", { reconciled: true });
    }
    params.logger.info(`epoch ${key} already open on Arc, nothing to mirror`, { epochId: key });
    return;
  }

  const vaultEpoch = await params.unichainClient.readContract({
    address: SIGMA_VAULT,
    abi: sigmaVaultAbi,
    functionName: "epoch",
    args: [params.epochId],
  });

  const sample = await measureUnichainBlockTime(params.unichainClient);
  const coverageEnd = computeCoverageEnd({
    nowTimestamp: sample.latestTimestamp,
    currentBlock: sample.latestBlock,
    // `endBlock` is a solidity `uint48`; abitype resolves anything <= 48
    // bits to a plain `number`, not `bigint` -- everything in this module
    // works in bigint, so it is widened here at the one point it enters.
    endBlock: BigInt(vaultEpoch.endBlock),
    blockTimeNumeratorSeconds: sample.numeratorSeconds,
    blockTimeDenominatorBlocks: sample.denominatorBlocks,
  });
  const reportDeadline = computeReportDeadline(coverageEnd, params.reportDeadlineMarginSeconds);

  if (!shouldMirrorEpoch({ nowTimestamp: sample.latestTimestamp, reportDeadline })) {
    params.logger.warn(
      `epoch ${key}'s report window would already be closed before it could be mirrored -- not opening it on Arc`,
      { epochId: key, coverageEnd: coverageEnd.toString(), reportDeadline: reportDeadline.toString() },
    );
    if (!params.dryRun && params.journal.claim(SERVICE, "openEpoch", key) === "fresh") {
      params.journal.recordDone(SERVICE, "openEpoch", key, "skipped-stale", {
        coverageEnd: coverageEnd.toString(),
        reportDeadline: reportDeadline.toString(),
      });
    }
    return;
  }

  if (params.dryRun) {
    params.logger.info(`[dry run] would call openEpoch(${key}, ${coverageEnd}, ${reportDeadline})`, {
      epochId: key,
      coverageEnd: coverageEnd.toString(),
      reportDeadline: reportDeadline.toString(),
    });
    return;
  }

  const decision = await resolveClaim({
    journal: params.journal,
    service: SERVICE,
    action: "openEpoch",
    key,
    publicClient: params.arcClient,
    isDoneOnChain: async () => (await readArcEpoch()).coverageEnd !== 0n,
    logger: params.logger,
  });
  if (!decision.proceed) {
    params.logger.info(`skipping openEpoch(${key}): ${decision.reason}`, { epochId: key });
    return;
  }

  const result = await params.arcWallet.send({
    address: SIGMA_STREAM,
    abi: sigmaStreamAbi,
    functionName: "openEpoch",
    args: [params.epochId, coverageEnd, reportDeadline],
  });

  if (result.ok) {
    params.journal.recordDone(SERVICE, "openEpoch", key, result.hash, {
      coverageEnd: coverageEnd.toString(),
      reportDeadline: reportDeadline.toString(),
    });
    params.logger.info(`openEpoch(${key}) landed`, { epochId: key, hash: result.hash });
    return;
  }

  const outcome = classifyOpenEpochRevert(result.revertName);
  if (outcome.kind === "success") {
    params.journal.recordDone(SERVICE, "openEpoch", key, "already-open-onchain", { reconciled: true });
    return;
  }
  if (outcome.kind === "fatal") {
    params.journal.recordFailed(SERVICE, "openEpoch", key, outcome.reason);
    await params.alert("error", `reporter: FATAL -- ${outcome.reason}`, { epochId: key });
    throw new FatalReporterError(outcome.reason);
  }
  params.journal.recordFailed(SERVICE, "openEpoch", key, result.reason);
  params.logger.warn(`openEpoch(${key}) failed, will retry next tick`, { epochId: key, reason: result.reason });
}

/**
 * The event ABI item exported for direct use in tests that want to build a
 * realistic `getLogsChunked` fixture without re-deriving it.
 */
export { epochOpenedEvent };

/** Cross-check helper shared with `settle.ts`'s own event decode. Kept here
 * since it decodes the *vault's* ABI, same as the discovery scan above. */
export function decodeEpochSettledLogs(logs: Parameters<typeof parseEventLogs>[0]["logs"]) {
  return parseEventLogs({ abi: sigmaVaultAbi, eventName: "EpochSettled", logs });
}
