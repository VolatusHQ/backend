/**
 * Reads the mandate owner's Uniswap v4 position in the measured pool, and
 * the pool's current liquidity and tick — the inputs `gamma.ts` needs.
 *
 * Ported/adapted from `apps/web/app/app/lib/onchain/positions.ts`'s
 * `readOwnedPositions` and `v4.ts`'s `poolId`/`decodePositionInfo` (kept
 * locally in `./v4.ts` — see that file's header). That original is
 * browser-only (`"use client"`, reads through `wagmi/actions` and
 * `wagmiConfig`); this rewrites the same logic against a plain viem
 * `PublicClient`, which is what every backend service in this repo uses.
 * The filtering rules are identical: keep a token only if it is still owned
 * by `owner`, still has non-zero liquidity, and sits in the measured pool.
 *
 * v4 positions are ERC-721s with no enumeration (the original file's own
 * comment: "a holder's tokens come from scanning `Transfer(to = holder)`
 * logs"), so discovery is a chunked log scan — Unichain rejects a
 * `getLogs` range over 10,000 blocks (BRIEF.md), handled here by
 * `@volatus/service-kit`'s `getLogsChunked`, the same helper the keeper
 * uses for its own log discovery on Arc.
 */

import { getAbiItem, type Address, type PublicClient } from "viem";
import {
  MEASURED_POOL_ID,
  MEASURED_POOL_KEY,
  POSITION_MANAGER,
  STATE_VIEW,
  positionManagerAbi,
  stateViewAbi,
} from "@volatus/onchain";
import { getLogsChunked } from "@volatus/service-kit";
import { decodePositionInfo, poolId } from "./v4.js";

export interface OwnedPosition {
  tokenId: bigint;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
}

const TRANSFER_EVENT = getAbiItem({ abi: positionManagerAbi, name: "Transfer" });

export interface FindOwnedPositionsOptions {
  client: PublicClient;
  owner: Address;
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * The owner's live positions in the measured pool (`MEASURED_POOL_ID`),
 * found via a chunked `Transfer(to = owner)` log scan. A demo LP is expected
 * to hold at most one; nothing here assumes that — `tick.ts` decides how to
 * combine more than one if it ever finds more than one.
 */
export async function findOwnedPositions(opts: FindOwnedPositionsOptions): Promise<OwnedPosition[]> {
  const { logs } = await getLogsChunked({
    client: opts.client,
    address: POSITION_MANAGER,
    event: TRANSFER_EVENT,
    fromBlock: opts.fromBlock,
    toBlock: opts.toBlock,
  });

  const ids = [...new Set(logs.map((l) => l.args.id).filter((id): id is bigint => id !== undefined))];
  const measured = poolId(MEASURED_POOL_KEY);
  const found: OwnedPosition[] = [];

  for (const tokenId of ids) {
    try {
      const [currentOwner, liquidity, poolAndInfo] = await Promise.all([
        opts.client.readContract({
          address: POSITION_MANAGER,
          abi: positionManagerAbi,
          functionName: "ownerOf",
          args: [tokenId],
        }),
        opts.client.readContract({
          address: POSITION_MANAGER,
          abi: positionManagerAbi,
          functionName: "getPositionLiquidity",
          args: [tokenId],
        }),
        opts.client.readContract({
          address: POSITION_MANAGER,
          abi: positionManagerAbi,
          functionName: "getPoolAndPositionInfo",
          args: [tokenId],
        }),
      ]);

      if (currentOwner.toLowerCase() !== opts.owner.toLowerCase()) continue;
      if (liquidity === 0n) continue;
      if (poolId(poolAndInfo[0]) !== measured) continue;

      found.push({ tokenId, liquidity, ...decodePositionInfo(poolAndInfo[1]) });
    } catch {
      // A burned token reverts on ownerOf. Not an error — just gone. Same as the ported original.
    }
  }

  return found;
}

export interface MeasuredPoolState {
  liquidity: bigint;
  currentTick: number;
}

/** The measured pool's total liquidity and current tick, read from `StateView`. */
export async function readMeasuredPoolState(client: PublicClient): Promise<MeasuredPoolState> {
  const [liquidity, slot0] = await Promise.all([
    client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getLiquidity", args: [MEASURED_POOL_ID] }),
    client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [MEASURED_POOL_ID] }),
  ]);
  return { liquidity, currentTick: slot0[1] };
}
