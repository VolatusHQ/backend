/**
 * Live push feed for the frontend's trading chart and market header, over a
 * genuine WebSocket.
 *
 * This service is the one thing in the stack that is a persistent process
 * (Render) rather than a serverless function (the frontend, on Vercel) —
 * that's what actually makes a socket possible: a request handler that
 * returns and forgets can't hold one open, but `serve` mode never exits.
 *
 * It polls rather than `eth_subscribe`s: the public Unichain Sepolia RPC
 * (`UNICHAIN_SEPOLIA_RPC`) is plain HTTP, with no wss:// endpoint to
 * subscribe against. A short `getLogs` poll is what a real subscription
 * would amount to here anyway — the socket facing the browser is real, what
 * sits behind it is a fast poll instead of a push from the node itself.
 *
 * One loop per process, not one per client: every connected browser gets the
 * same broadcast rather than each opening its own chain poll.
 */

import type { Hex, PublicClient } from "viem";
import { parseAbiItem } from "viem";
import {
  MEASURED_POOL_ID,
  POOL_MANAGER,
  SIGMA_HOOK,
  SIGMA_ORACLE,
  SIGMA_VAULT,
  sigmaOracleVolPoolAbi,
  sigmaVaultAbi,
} from "@volatus/onchain";
import { runLoop, type RunningLoop } from "@volatus/service-kit";
import type { Logger } from "./journalReconcile.js";
import { readMarketSignal } from "./signals.js";

const SWAP_EVENT = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

const USDC_DECIMALS = 6;

/**
 * VAR-LONG's price in mUSDC from a vol-pool swap's `sqrtPriceX96`. Same math
 * as the frontend's `onchain/v4.ts#varLongPrice`, duplicated here rather than
 * shared across the two separate repos — same per-service duplication
 * convention `signals.ts`'s module doc already uses for `hookExtraAbi`.
 */
function varLongPriceFromSqrtX96(sqrtPriceX96: bigint, longIsCurrency0: boolean): number {
  const raw = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  return longIsCurrency0 ? raw : 1 / raw;
}

export type LiveEvent =
  /** The epoch (and its vol pool) this feed is currently watching. Sent the
   *  moment it changes, so a connected client knows to drop whatever candles
   *  it built against the previous, now-stale pool and start clean — the
   *  same "a new epoch is a new pool with no history" rule the frontend's
   *  server-rendered `getVarLongTrades()` already follows. `poolId: null`
   *  means no epoch is live right now. */
  | { type: "epoch"; epochId: string | null; poolId: Hex | null }
  /** One new swap in the currently-watched vol pool — same shape as the
   *  `Trade` the initial server render already hands the chart, so the
   *  client can push these onto the same array. */
  | { type: "trade"; time: number; price: number; volume: number }
  /** Cheap to compute alongside the swap poll (one extra oracle/hook read),
   *  so the header's price/vol figures can go live too, not only the chart. */
  | { type: "market"; impliedVolWad: string; realizedVolWad: string; dataSufficient: boolean };

export interface LiveFeedDeps {
  client: PublicClient;
  logger: Logger;
  onEvent: (event: LiveEvent) => void;
  pollIntervalMs?: number;
}

/**
 * Starts the poll loop. Returns the same `RunningLoop` handle `runLoop`
 * everything else in this service uses, so `index.ts` stops it the same way
 * it would stop the tick loop.
 *
 * Watermarked, not replayed: a freshly-detected epoch starts watching from
 * the current block, not `epoch.startBlock` — the connecting client's own
 * page load already fetched that epoch's history via `getVarLongTrades()`,
 * so replaying it here would just duplicate it. The gap this leaves (a swap
 * landing between that page's SSR read and its socket opening) is a few
 * seconds wide at most and not worth closing for a demo feed.
 */
export function startLiveFeed(deps: LiveFeedDeps): RunningLoop {
  const { client, logger, onEvent, pollIntervalMs = 4000 } = deps;

  let watchedEpochId: bigint | null = null;
  let watchedPoolId: Hex | null = null;
  let longIsCurrency0 = false;
  let fromBlock: bigint | null = null;
  // `watchedEpochId === null` alone can't tell "never checked" from "checked,
  // and there genuinely is no active epoch" apart -- both look the same. This
  // flag is what makes the very first poll always emit an `epoch` event, even
  // when that event says `poolId: null`, instead of silently doing nothing
  // because "null to null" reads as no change.
  let epochKnown = false;

  async function pollTrades(): Promise<void> {
    const activeEpochId = await client.readContract({
      address: SIGMA_VAULT,
      abi: sigmaVaultAbi,
      functionName: "activeEpoch",
      args: [MEASURED_POOL_ID],
    });

    if (activeEpochId === 0n) {
      if (!epochKnown || watchedEpochId !== null) {
        watchedEpochId = null;
        watchedPoolId = null;
        fromBlock = null;
        epochKnown = true;
        onEvent({ type: "epoch", epochId: null, poolId: null });
      }
      return;
    }

    if (!epochKnown || activeEpochId !== watchedEpochId) {
      const vp = await client.readContract({
        address: SIGMA_ORACLE,
        abi: sigmaOracleVolPoolAbi,
        functionName: "volPool",
        args: [activeEpochId],
      });
      watchedEpochId = activeEpochId;
      watchedPoolId = vp.registered ? vp.poolId : null;
      longIsCurrency0 = vp.longIsCurrency0;
      fromBlock = watchedPoolId ? (await client.getBlockNumber()) + 1n : null;
      epochKnown = true;
      onEvent({ type: "epoch", epochId: activeEpochId.toString(), poolId: watchedPoolId });
    }

    if (!watchedPoolId || fromBlock === null) return;

    const toBlock = await client.getBlockNumber();
    if (toBlock < fromBlock) return;

    const logs = await client.getLogs({
      address: POOL_MANAGER,
      event: SWAP_EVENT,
      args: { id: watchedPoolId },
      fromBlock,
      toBlock,
    });
    fromBlock = toBlock + 1n;
    if (logs.length === 0) return;

    const blocks = [...new Set(logs.map((l) => l.blockNumber))];
    const times = new Map<bigint, number>();
    await Promise.all(
      blocks.map(async (b) => {
        const block = await client.getBlock({ blockNumber: b });
        times.set(b, Number(block.timestamp));
      }),
    );

    for (const log of logs) {
      const price = varLongPriceFromSqrtX96(log.args.sqrtPriceX96 ?? 0n, longIsCurrency0);
      // Same exhausted-liquidity guard the frontend's `getVarLongTrades()` applies —
      // a swap that pins the pool's thin seeded range squares out to a price the
      // chart can't hold. Drop it here too, so the two feeds never disagree.
      if (!Number.isFinite(price) || price <= 0 || price >= 1e9) continue;
      const usdc = (longIsCurrency0 ? log.args.amount1 : log.args.amount0) ?? 0n;
      onEvent({
        type: "trade",
        time: times.get(log.blockNumber) ?? 0,
        price,
        volume: Number(usdc < 0n ? -usdc : usdc) / 10 ** USDC_DECIMALS,
      });
    }
  }

  async function pollMarket(): Promise<void> {
    // `pollTrades` runs first every tick and is the one source of truth for
    // whether an epoch is active. Skip the read (and its `NoActiveEpoch`
    // revert) entirely rather than triggering, catching, and logging it every
    // single poll during a settle-to-reopen gap.
    if (watchedEpochId === null) return;
    try {
      const signal = await readMarketSignal({
        client,
        oracleAddress: SIGMA_ORACLE,
        vaultAddress: SIGMA_VAULT,
        hookAddress: SIGMA_HOOK,
        poolId: MEASURED_POOL_ID,
      });
      onEvent({
        type: "market",
        impliedVolWad: signal.impliedVolWad.toString(),
        realizedVolWad: signal.realizedVolWad.toString(),
        dataSufficient: signal.dataSufficient,
      });
    } catch (err) {
      // `readMarketSignal` reverts `NoActiveEpoch` in the same settle-to-reopen
      // gap `history.ts`'s `sampleOnce` already documents. Skip this poll's
      // market broadcast rather than taking down the trade side over it.
      logger.warn("live feed: market signal read failed, skipping this poll's market broadcast", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return runLoop({
    name: "roller-live-feed",
    intervalMs: pollIntervalMs,
    jitterMs: 0, // a steady cadence matters more here than spreading load
    logger,
    tick: async () => {
      await pollTrades();
      await pollMarket();
    },
  });
}
