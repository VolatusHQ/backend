/**
 * Chunked `eth_getLogs`, because neither chain will serve an arbitrary range
 * in one call and Arc additionally throws its history away.
 *
 * `CHAIN_LOG_LIMITS` below is measured, not assumed — probed against the
 * live RPCs on 2026-09-05 with `cast logs`:
 *
 *   Unichain Sepolia (1301): a 9,000- and an exact 10,000-block range both
 *   succeeded; 10,001 was rejected:
 *     `{"code":-32602,"message":"block range greater than 10000 max"}`
 *
 *   Arc Testnet (5042002): ranges up to 29,000 blocks succeeded; 30,000 was
 *   rejected:
 *     `error code -32012: requested range too large`
 *   (the brief's "~20,000" was a conservative first estimate; the measured
 *   ceiling is between 29,000 and 30,000 — `maxRange` below stays well under
 *   both, per BRIEF.md's specified default, since the exact ceiling can move).
 *
 *   Arc also discards history below some pruning horizon. `fromBlock: 0`
 *   returned:
 *     `error code 4444: pruned history unavailable`
 *   There was no history-available floor exposed by the RPC to query ahead
 *   of time — the only way to find it is to hit the error, which is exactly
 *   what `getLogsChunked` does below, chunk by chunk.
 *
 * `client` and `event`/`abi` are passed in by the caller (typically
 * `unichainClient`/`arcClient` from `@volatus/onchain`, and an event picked
 * off an ABI exported from there) — this module only needs viem's generic
 * `PublicClient`/`AbiEvent` types, see this package's README.
 */

import type { AbiEvent, Address, GetLogsParameters, GetLogsReturnType, PublicClient } from "viem";

/**
 * Chunk sizes safely under the measured ceilings for each chain, keyed by
 * chain id. Used as the default `maxRange` when the caller does not pass one
 * and `client.chain.id` matches a known chain.
 */
export const CHAIN_LOG_LIMITS: Record<number, bigint> = {
  1301: 9_000n, // Unichain Sepolia — measured hard cap is 10,000 blocks.
  5042002: 18_000n, // Arc Testnet — measured cap is between 29,000 and 30,000 blocks.
};

const DEFAULT_MAX_RANGE = 9_000n;

const PRUNED_HISTORY_RE = /4444|pruned history unavailable/i;

function isPrunedHistoryError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return PRUNED_HISTORY_RE.test(message);
}

export interface GetLogsChunkedOptions<abiEvent extends AbiEvent> {
  client: PublicClient;
  address: Address | Address[];
  event: abiEvent;
  fromBlock: bigint;
  toBlock: bigint;
  /** Blocks per `eth_getLogs` call. Defaults from `CHAIN_LOG_LIMITS[client.chain.id]`, else 9,000. */
  maxRange?: bigint;
}

export interface GetLogsChunkedResult<abiEvent extends AbiEvent> {
  logs: GetLogsReturnType<abiEvent>;
  /**
   * Set when one or more chunks failed with Arc's pruning error. History
   * below this block number is not available and was not scanned — `logs`
   * covers `[prunedBefore, toBlock]` only, not the full requested range.
   */
  prunedBefore?: bigint;
}

/**
 * Scan `[fromBlock, toBlock]` in `maxRange`-sized chunks. Chunks are
 * contiguous and non-overlapping: chunk N is `[start, start + maxRange - 1]`
 * clamped to `toBlock`, and chunk N+1 starts at `end + 1` — so a range that
 * is not an exact multiple of `maxRange` still covers every block exactly
 * once, with a shorter final chunk rather than a gap or a re-scanned tail.
 *
 * A pruning error on a chunk does not fail the whole scan: that chunk is
 * skipped, `prunedBefore` is raised to mark the floor, and the scan
 * continues into newer blocks. Any other error propagates — a range-too-
 * large or a transient RPC failure is a bug in this function's chunking or
 * an outage, not a backfill boundary to route around silently.
 */
export async function getLogsChunked<abiEvent extends AbiEvent>(
  opts: GetLogsChunkedOptions<abiEvent>,
): Promise<GetLogsChunkedResult<abiEvent>> {
  const { client, address, event, fromBlock, toBlock } = opts;
  if (toBlock < fromBlock) {
    throw new Error(`getLogsChunked: toBlock (${toBlock}) is before fromBlock (${fromBlock})`);
  }

  const chainId = client.chain?.id;
  const maxRange = opts.maxRange ?? (chainId !== undefined ? CHAIN_LOG_LIMITS[chainId] : undefined) ?? DEFAULT_MAX_RANGE;
  if (maxRange <= 0n) {
    throw new Error(`getLogsChunked: maxRange must be positive, got ${maxRange}`);
  }

  const logs: GetLogsReturnType<abiEvent>[number][] = [];
  let prunedBefore: bigint | undefined;

  let start = fromBlock;
  while (start <= toBlock) {
    const rangeEnd = start + maxRange - 1n;
    const end = rangeEnd > toBlock ? toBlock : rangeEnd;

    try {
      const chunk = await client.getLogs({
        address,
        event,
        fromBlock: start,
        toBlock: end,
      } as GetLogsParameters<abiEvent>);
      logs.push(...(chunk as GetLogsReturnType<abiEvent>));
    } catch (err) {
      if (!isPrunedHistoryError(err)) throw err;
      const floor = end + 1n;
      prunedBefore = prunedBefore === undefined || floor > prunedBefore ? floor : prunedBefore;
    }

    start = end + 1n;
  }

  const result = { logs: logs as GetLogsReturnType<abiEvent> } as GetLogsChunkedResult<abiEvent>;
  if (prunedBefore !== undefined) result.prunedBefore = prunedBefore;
  return result;
}
