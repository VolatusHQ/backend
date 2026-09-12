/**
 * A capped, in-memory ring buffer of `(implied, realized, dataSufficient)`
 * samples, taken once per tick, and served at `GET /vol-history` — the
 * trailing-history source the frontend's severity/tier score percentile-ranks
 * against (see `packages/onchain/src/severity.ts`). Deliberately in-memory,
 * not the journal's sqlite file: this is a demo-liveliness convenience, not
 * protocol state, and Render's free tier wipes local disk on every cold
 * start anyway (see `roll.ts`'s module doc) -- a ring buffer that resets on
 * restart is honest about what it is, rather than pretending to durability
 * it does not have.
 *
 * Reuses `readMarketSignal`/`evaluateMarketSignal` from `signals.ts` (copied
 * from `underwriter`, same per-service duplication convention as
 * `journalReconcile.ts`) so a sample's `dataSufficient`/`spreadWad` mean
 * exactly what they mean everywhere else in this codebase.
 */

import type { PublicClient } from "viem";
import { SIGMA_HOOK, SIGMA_ORACLE, SIGMA_VAULT } from "@volatus/onchain";
import type { Logger } from "./journalReconcile.js";
import { readMarketSignal, type MarketSignal } from "./signals.js";

export interface VolSample {
  ts: number; // unix seconds
  impliedVolWad: string; // bigint, stringified for JSON
  realizedVolWad: string;
  dataSufficient: boolean;
  spreadWad: string | null;
}

export interface HistoryStore {
  sampleOnce(client: PublicClient, poolId: `0x${string}`, logger: Logger): Promise<VolSample>;
  list(poolId: `0x${string}`): VolSample[];
}

function toSample(ts: number, signal: MarketSignal): VolSample {
  return {
    ts,
    impliedVolWad: signal.impliedVolWad.toString(),
    realizedVolWad: signal.realizedVolWad.toString(),
    dataSufficient: signal.dataSufficient,
    spreadWad: signal.spreadWad === null ? null : signal.spreadWad.toString(),
  };
}

/** `capacity` bounds memory, not correctness -- old samples just fall off the
 *  front. 500 points at a tick every ~30-60s is several hours of history,
 *  ample for a percentile baseline in a demo. */
export function makeHistoryStore(capacity = 500): HistoryStore {
  const byPool = new Map<string, VolSample[]>();

  async function sampleOnce(client: PublicClient, poolId: `0x${string}`, logger: Logger): Promise<VolSample> {
    // `VolatusOracle.realizedVol`/`impliedVol` both revert `NoActiveEpoch`
    // when `activeEpoch(poolId) == 0` -- a real, if brief, window this
    // service itself creates every rollover (settled, not yet reopened).
    // `readMarketSignal` (copied from underwriter/src/signals.ts) does not
    // guard against that revert, so this call is wrapped rather than
    // crashing the whole tick over a transient, expected state.
    let signal: MarketSignal;
    try {
      signal = await readMarketSignal({
        client,
        oracleAddress: SIGMA_ORACLE,
        vaultAddress: SIGMA_VAULT,
        hookAddress: SIGMA_HOOK,
        poolId,
      });
    } catch (err) {
      logger.warn("history: readMarketSignal reverted, recording a no-data sample instead of crashing the tick", {
        err: err instanceof Error ? err.message : String(err),
      });
      signal = { oracleOk: false, impliedVolWad: 0n, realizedVolWad: 0n, hasActiveEpoch: false, accumulatorNow: 0n, startAccumulator: 0n, observations: 0, dataSufficient: false, spreadWad: null };
    }
    const sample = toSample(Math.floor(Date.now() / 1000), signal);

    const key = poolId.toLowerCase();
    const series = byPool.get(key) ?? [];
    series.push(sample);
    if (series.length > capacity) series.splice(0, series.length - capacity);
    byPool.set(key, series);

    return sample;
  }

  function list(poolId: `0x${string}`): VolSample[] {
    return byPool.get(poolId.toLowerCase()) ?? [];
  }

  return { sampleOnce, list };
}
