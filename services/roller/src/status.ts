/**
 * `status` command — a read-only picture of the one pool this service rolls:
 * the latest epoch found for it, whether it has ended, and whether its vol
 * pool is registered. Unlike `reporter/src/status.ts` (which iterates every
 * epoch the vault has ever seen, across every pool), this only ever cares
 * about `MEASURED_POOL_ID`'s current/latest epoch -- the same narrow read
 * `roll.ts` itself uses, so `status` and a real tick can never disagree
 * about what "the current epoch" means.
 */

import type { PublicClient } from "viem";
import { sigmaOracleVolPoolAbi, sigmaVaultAbi, wadToRatio, MEASURED_POOL_ID, SIGMA_ORACLE, SIGMA_VAULT } from "@volatus/onchain";
import { findLatestEpochForPool } from "./roll.js";

export interface RollerStatusReport {
  poolId: `0x${string}`;
  currentBlock: bigint;
  epochId: bigint | null;
  epoch: {
    endBlock: bigint;
    settled: boolean;
    payoffWad: bigint;
    strikeWad: bigint;
    capWad: bigint;
  } | null;
  activeEpochId: bigint;
  volPoolRegistered: boolean;
  blocksRemaining: bigint | null;
}

export async function buildRollerStatus(client: PublicClient): Promise<RollerStatusReport> {
  const poolId = MEASURED_POOL_ID;
  const [currentBlock, activeEpochId] = await Promise.all([
    client.getBlockNumber(),
    client.readContract({ address: SIGMA_VAULT, abi: sigmaVaultAbi, functionName: "activeEpoch", args: [poolId] }),
  ]);

  const epochId = await findLatestEpochForPool(client, poolId);
  if (epochId === null) {
    return { poolId, currentBlock, epochId: null, epoch: null, activeEpochId, volPoolRegistered: false, blocksRemaining: null };
  }

  const [e, volPool] = await Promise.all([
    client.readContract({ address: SIGMA_VAULT, abi: sigmaVaultAbi, functionName: "epoch", args: [epochId] }),
    client.readContract({ address: SIGMA_ORACLE, abi: sigmaOracleVolPoolAbi, functionName: "volPool", args: [epochId] }),
  ]);

  // `endBlock` is a solidity `uint48`; abitype resolves <= 48 bits to
  // `number`, not `bigint` -- widened here, same as reporter/src/status.ts.
  const endBlock = BigInt(e.endBlock);

  return {
    poolId,
    currentBlock,
    epochId,
    epoch: { endBlock, settled: e.settled, payoffWad: e.payoffWad, strikeWad: e.strikeWad, capWad: e.capWad },
    activeEpochId,
    volPoolRegistered: volPool.registered,
    blocksRemaining: e.settled ? null : endBlock - currentBlock,
  };
}

export function formatRollerStatus(report: RollerStatusReport): string {
  const lines: string[] = [];
  lines.push(`Unichain now: block ${report.currentBlock}`);
  lines.push(`Pool: ${report.poolId}`);
  lines.push("");

  if (report.epochId === null) {
    lines.push("No epoch has ever been opened for this pool -- bootstrap one by hand first.");
    return lines.join("\n");
  }

  const e = report.epoch!;
  lines.push(`Latest epoch: ${report.epochId}`);
  lines.push(`  endBlock=${e.endBlock} settled=${e.settled} payoffWad=${e.payoffWad} (${(wadToRatio(e.payoffWad) * 100).toFixed(4)}%)`);
  lines.push(`  strikeWad=${e.strikeWad} capWad=${e.capWad}`);
  lines.push(`  active on pool: ${report.activeEpochId === report.epochId ? "yes" : report.activeEpochId === 0n ? "no -- settled, awaiting roll" : `no -- epoch ${report.activeEpochId} is`}`);
  lines.push(`  vol pool registered: ${report.volPoolRegistered}`);
  if (report.blocksRemaining !== null) {
    lines.push(`  blocks remaining: ${report.blocksRemaining}${report.blocksRemaining <= 0n ? " (ENDED, ready to settle)" : ""}`);
  }

  return lines.join("\n");
}
