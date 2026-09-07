/**
 * BACKEND_HANDOFF.md § Service 3 step 1, verbatim: "Read `SigmaOracle.tryImpliedVol(poolId)`
 * on Unichain. If `ok == false`, do nothing — never act on a missing feed."
 *
 * This wrapper exists so that rule has exactly one call site to get right:
 * `tryImpliedVol` itself never throws (it wraps `impliedVol` in a `try/catch`
 * on the Solidity side precisely so callers get a clean `(false, 0)` instead
 * of a revert), and nothing here may turn that `false` into a guess.
 */

import type { Hex, PublicClient } from "viem";
import { sigmaOracleAbi, SIGMA_ORACLE } from "@volatus/onchain";

export type ImpliedVolResult = { ok: true; impliedVolWad: bigint } | { ok: false };

export async function readImpliedVol(client: PublicClient, poolId: Hex): Promise<ImpliedVolResult> {
  const [ok, impliedVolWad] = await client.readContract({
    address: SIGMA_ORACLE,
    abi: sigmaOracleAbi,
    functionName: "tryImpliedVol",
    args: [poolId],
  });
  return ok ? { ok: true, impliedVolWad } : { ok: false };
}
