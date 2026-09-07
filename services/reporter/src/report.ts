/**
 * Job 1b step 3 — report the settled payoff to Arc (BACKEND_HANDOFF.md §
 * Service 1). `buildReportPayoffArgs` is split out on its own because it is
 * the single most important line in this service to get right: `payoffWad`
 * is a WAD ratio in `[0, 1e18]` and crosses Unichain -> Arc **unchanged** —
 * it is not a 6dp USDC amount, and nothing here may rescale it (DECISIONS.md
 * §12, `packages/onchain`'s units table). `test/report.test.ts` asserts this
 * directly.
 */

import type { PublicClient } from "viem";
import { sigmaStreamAbi, SIGMA_STREAM, WAD } from "@volatus/onchain";
import type { AlertFn, Journal, Wallet } from "@volatus/service-kit";
import { SERVICE } from "./constants.js";
import { classifyReportPayoffRevert, FatalReporterError } from "./outcomes.js";
import { resolveClaim, type Logger } from "./journalReconcile.js";

/**
 * Pass `vaultPayoffWad` through untouched. No decimals conversion belongs
 * here: the contract does the WAD x 6dp multiplication internally when a
 * subscriber claims (`packages/onchain`'s README, "The one rule").
 */
export function buildReportPayoffArgs(
  epochId: bigint,
  vaultPayoffWad: bigint,
): { epochId: bigint; payoffWad: bigint } {
  if (vaultPayoffWad < 0n || vaultPayoffWad > WAD) {
    // Caught here, before ever reaching the chain, as a local sanity check --
    // the contract also enforces this (`PayoffOutOfRange`) but failing fast
    // with a clearer message is worth the extra check.
    throw new Error(`buildReportPayoffArgs: payoffWad ${vaultPayoffWad} is outside [0, ${WAD}] -- do not send it`);
  }
  return { epochId, payoffWad: vaultPayoffWad };
}

export interface ReportParams {
  epochId: bigint;
  payoffWad: bigint;
  journal: Journal;
  arcClient: PublicClient;
  arcWallet: Wallet;
  logger: Logger;
  alert: AlertFn;
  dryRun: boolean;
}

const readStreamEpoch = (client: PublicClient, epochId: bigint) =>
  client.readContract({ address: SIGMA_STREAM, abi: sigmaStreamAbi, functionName: "epoch", args: [epochId] });

export async function reportEpoch(params: ReportParams): Promise<void> {
  const key = params.epochId.toString();

  const streamEpoch = await readStreamEpoch(params.arcClient, params.epochId);
  if (streamEpoch.reported) {
    params.logger.info(`epoch ${key} already reported on Arc, nothing to do`, { epochId: key });
    return;
  }
  if (streamEpoch.coverageEnd === 0n) {
    params.logger.info(`epoch ${key} not yet mirrored on Arc -- job 1a has not opened it (or hasn't run yet)`, {
      epochId: key,
    });
    return;
  }

  const { payoffWad } = buildReportPayoffArgs(params.epochId, params.payoffWad);

  if (params.dryRun) {
    params.logger.info(`[dry run] would call reportPayoff(${key}, ${payoffWad})`, {
      epochId: key,
      payoffWad: payoffWad.toString(),
    });
    return;
  }

  const decision = await resolveClaim({
    journal: params.journal,
    service: SERVICE,
    action: "reportPayoff",
    key,
    publicClient: params.arcClient,
    isDoneOnChain: async () => (await readStreamEpoch(params.arcClient, params.epochId)).reported,
    logger: params.logger,
  });
  if (!decision.proceed) {
    params.logger.info(`skipping reportPayoff(${key}): ${decision.reason}`, { epochId: key });
    return;
  }

  const result = await params.arcWallet.send({
    address: SIGMA_STREAM,
    abi: sigmaStreamAbi,
    functionName: "reportPayoff",
    args: [params.epochId, payoffWad],
  });

  if (result.ok) {
    params.journal.recordDone(SERVICE, "reportPayoff", key, result.hash, { payoffWad: payoffWad.toString() });
    params.logger.info(`reportPayoff(${key}) landed`, { epochId: key, hash: result.hash });
    return;
  }

  const outcome = classifyReportPayoffRevert(result.revertName);
  if (outcome.kind === "success") {
    params.journal.recordDone(SERVICE, "reportPayoff", key, "already-reported-onchain", { reconciled: true });
    return;
  }
  if (outcome.kind === "fatal") {
    params.journal.recordFailed(SERVICE, "reportPayoff", key, outcome.reason);
    await params.alert("error", `reporter: FATAL -- ${outcome.reason}`, { epochId: key });
    throw new FatalReporterError(outcome.reason);
  }
  if (outcome.kind === "terminal") {
    // recordDone, not recordFailed: a `failed` record is reclaimable, and
    // re-sending a ReportWindowClosed/PayoffOutOfRange revert forever is
    // pure noise. `done` here means "permanently settled as a failure",
    // not "succeeded" -- the txHash column carries a sentinel, never a hash.
    params.journal.recordDone(SERVICE, "reportPayoff", key, "terminal-failure", { reason: outcome.reason });
    await params.alert("error", `reporter: epoch ${key} -- ${outcome.reason}`, { epochId: key });
    params.logger.error(`reportPayoff(${key}) terminally failed, will never retry`, {
      epochId: key,
      reason: outcome.reason,
    });
    return;
  }
  params.journal.recordFailed(SERVICE, "reportPayoff", key, result.reason);
  params.logger.warn(`reportPayoff(${key}) failed, will retry next tick`, { epochId: key, reason: result.reason });
}
