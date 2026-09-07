/**
 * The delegation boundary — BACKEND_HANDOFF.md's "this is the security-critical
 * part" and PHASES.md § Custody.
 *
 * This service never holds a user's private key. It never generates one for
 * them either — PHASES.md § Custody is explicit that a bare EOA generated
 * and held server-side is custodial, is a single point of compromise, and
 * discards the delegation model README.md commits to. Instead, every write
 * this service ever makes goes through a `Signer`: an interface narrow
 * enough that a fully compromised Volatus backend, driving a `Signer`
 * however it likes, still cannot do anything except:
 *
 *   1. call `approveStreamSpend` — USDC.approve with spender pinned to
 *      `streamAddress`, for no other spender, ever;
 *   2. call `callStream` with one of `ALLOWED_STREAM_METHODS`
 *      (`subscribe` | `fund` | `adjust`), target pinned to `streamAddress`,
 *      for no other target, ever.
 *
 * There is no third method. There is no way to pass an arbitrary `to`
 * address into either call. `encodeStreamCall`/`encodeApprove` below are the
 * only calldata this package ever builds, and both are unit-tested for
 * exactly this: right selector, right argument order, right target.
 *
 * **What this interface enforces, and what it does not.** The interface
 * shape bounds what *this code* can ask a signer to do. Whether the signer
 * *itself* can be tricked into doing something else if this whole backend
 * is compromised is a property of the implementation, not the interface —
 * see `privySessionSigner.ts` and `localSigner.ts` for the two answers this
 * repo gives to that, and README.md § Delegation for which one actually
 * holds the stated security property.
 */

import { encodeFunctionData, type Address } from "viem";
import { erc20Abi, sigmaStreamAbi } from "@volatus/onchain";
import type { SendResult } from "@volatus/service-kit";

/** README.md's `sigma-hedger-v1` policy: `streamPremium -> subscribe|fund`, `adjustCoverage -> adjust`. */
export type StreamMethod = "subscribe" | "fund" | "adjust";

export const ALLOWED_STREAM_METHODS: readonly StreamMethod[] = ["subscribe", "fund", "adjust"];

/** Positional argument count per method — a second, structural check beyond the allowlist itself. */
const STREAM_METHOD_ARITY: Record<StreamMethod, number> = { subscribe: 3, fund: 2, adjust: 3 };

export interface Signer {
  address: Address;
  /** `USDC.approve(streamAddress, amount)`. The spender is never a parameter — see module doc. */
  approveStreamSpend(amount: bigint): Promise<SendResult>;
  /** One of `ALLOWED_STREAM_METHODS`, always sent to `streamAddress`. Rejects anything else without sending. */
  callStream(method: StreamMethod, args: readonly bigint[]): Promise<SendResult>;
}

function isAllowedStreamMethod(method: string): method is StreamMethod {
  return (ALLOWED_STREAM_METHODS as readonly string[]).includes(method);
}

/**
 * Encodes calldata for `SigmaStream.<method>(...args)`. Throws — deliberately,
 * this is a programming-error guard, not a runtime user input path — if
 * `method` is outside `ALLOWED_STREAM_METHODS` or `args` has the wrong arity.
 * Note the ordering this enforces nothing about beyond arity: `adjust`'s
 * three args are `(epochId, newRatePerSecond, newCoverageNotional)` in that
 * order, matching `contracts/src/SigmaStream.sol` and `sigmaStreamAbi`
 * exactly — callers (`tick.ts`) are responsible for passing them in that
 * order; `delegation/*.test.ts` decode the resulting calldata to check it.
 */
export function encodeStreamCall(method: StreamMethod, args: readonly bigint[]): `0x${string}` {
  if (!isAllowedStreamMethod(method)) {
    throw new Error(`encodeStreamCall: "${method}" is not an allowed SigmaStream method`);
  }
  if (args.length !== STREAM_METHOD_ARITY[method]) {
    throw new Error(`encodeStreamCall: ${method} takes ${STREAM_METHOD_ARITY[method]} args, got ${args.length}`);
  }
  return encodeFunctionData({ abi: sigmaStreamAbi, functionName: method, args } as Parameters<
    typeof encodeFunctionData
  >[0]);
}

/** `USDC.approve(spender, amount)`. `spender` is always the caller's pinned `streamAddress`. */
export function encodeApprove(spender: Address, amount: bigint): `0x${string}` {
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
}
