/**
 * Job 1b step 1 — settle on Unichain (BACKEND_HANDOFF.md § Service 1).
 *
 * `SigmaVault.settle` is permissionless: this call needs the reporter
 * wallet's ETH for gas, not its privilege. It also calls
 * `hook.releaseSnapshot` itself, so nothing here nudges a swap to make
 * settlement possible.
 */

import type { PublicClient } from "viem";
import { sigmaVaultAbi, SIGMA_VAULT } from "@volatus/onchain";
import type { AlertFn, Journal, Wallet } from "@volatus/service-kit";
import { SERVICE } from "./constants.js";
import { decodeEpochSettledLogs } from "./discovery.js";
import { classifySettleRevert } from "./outcomes.js";
import { resolveClaim, type Logger } from "./journalReconcile.js";

export interface SettleParams {
  epochId: bigint;
  journal: Journal;
  unichainClient: PublicClient;
  unichainWallet: Wallet;
  logger: Logger;
  alert: AlertFn;
  dryRun: boolean;
}

export interface SettleResult {
  settled: boolean;
  payoffWad: bigint | null;
}

const readVaultEpoch = (client: PublicClient, epochId: bigint) =>
  client.readContract({ address: SIGMA_VAULT, abi: sigmaVaultAbi, functionName: "epoch", args: [epochId] });

export async function settleEpoch(params: SettleParams): Promise<SettleResult> {
  const key = params.epochId.toString();

  const vaultEpoch = await readVaultEpoch(params.unichainClient, params.epochId);
  if (vaultEpoch.settled) {
    return { settled: true, payoffWad: vaultEpoch.payoffWad };
  }

  const currentBlock = await params.unichainClient.getBlockNumber();
  if (currentBlock < vaultEpoch.endBlock) {
    params.logger.info(`epoch ${key} not yet over on Unichain, nothing to settle`, {
      epochId: key,
      endBlock: vaultEpoch.endBlock.toString(),
      currentBlock: currentBlock.toString(),
    });
    return { settled: false, payoffWad: null };
  }

  if (params.dryRun) {
    params.logger.info(`[dry run] would call settle(${key})`, {
      epochId: key,
      endBlock: vaultEpoch.endBlock.toString(),
      currentBlock: currentBlock.toString(),
    });
    return { settled: false, payoffWad: null };
  }

  const decision = await resolveClaim({
    journal: params.journal,
    service: SERVICE,
    action: "settle",
    key,
    publicClient: params.unichainClient,
    isDoneOnChain: async () => (await readVaultEpoch(params.unichainClient, params.epochId)).settled,
    logger: params.logger,
  });
  if (!decision.proceed) {
    params.logger.info(`skipping settle(${key}): ${decision.reason}`, { epochId: key });
    const e = await readVaultEpoch(params.unichainClient, params.epochId);
    return { settled: e.settled, payoffWad: e.settled ? e.payoffWad : null };
  }

  const result = await params.unichainWallet.send({
    address: SIGMA_VAULT,
    abi: sigmaVaultAbi,
    functionName: "settle",
    args: [params.epochId],
  });

  if (result.ok) {
    const e = await readVaultEpoch(params.unichainClient, params.epochId);

    // Cross-check against the EpochSettled event emitted by this very tx,
    // per BACKEND_HANDOFF.md: "Or take it from the EpochSettled(epochId,
    // realizedVariance, payoff) event." A mismatch here would mean this
    // service misread the struct, and reporting either number without
    // understanding why they disagree would be reporting a wrong payoff --
    // exactly the trust bound DECISIONS.md §12 draws around this service.
    const decoded = decodeEpochSettledLogs(result.receipt.logs).find((l) => l.args.epochId === params.epochId);
    if (decoded && decoded.args.payoff !== e.payoffWad) {
      await params.alert(
        "error",
        `reporter: settle(${key}) succeeded but EpochSettled's payoff (${decoded.args.payoff}) ` +
          `disagrees with epoch(${key}).payoffWad (${e.payoffWad}) -- refusing to report either value`,
        { epochId: key },
      );
      params.journal.recordFailed(SERVICE, "settle", key, "payoff mismatch between EpochSettled event and epoch() read");
      return { settled: false, payoffWad: null };
    }

    params.journal.recordDone(SERVICE, "settle", key, result.hash, { payoffWad: e.payoffWad.toString() });
    params.logger.info(`settle(${key}) landed`, { epochId: key, hash: result.hash, payoffWad: e.payoffWad.toString() });
    return { settled: true, payoffWad: e.payoffWad };
  }

  const outcome = classifySettleRevert(result.revertName);
  if (outcome.kind === "success") {
    params.journal.recordDone(SERVICE, "settle", key, "already-settled-onchain", { reconciled: true });
    const e = await readVaultEpoch(params.unichainClient, params.epochId);
    return { settled: true, payoffWad: e.payoffWad };
  }

  params.journal.recordFailed(SERVICE, "settle", key, result.reason);
  params.logger.warn(`settle(${key}) failed, will retry next tick`, { epochId: key, reason: result.reason });
  return { settled: false, payoffWad: null };
}
