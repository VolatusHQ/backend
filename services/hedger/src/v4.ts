/**
 * Minimal, ported subset of `apps/web/app/app/lib/onchain/v4.ts` — just the
 * two pure functions `position.ts` needs. Copied rather than imported
 * because that file lives under `apps/web` (a "use client" module, wired to
 * wagmi) and this package must not depend on the frontend app; the math
 * itself is unchanged. See the original for the full v4 primitive set and
 * its comments on why a pool id must always be derived from, and checked
 * against, the key it claims to hash rather than trusted as a bare value.
 */

import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

const POOL_KEY_ABI = [
  {
    type: "tuple",
    components: [
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
    ],
  },
] as const;

/** `PoolId.toId()` — keccak of the abi-encoded key. */
export function poolId(key: PoolKey): Hex {
  return keccak256(encodeAbiParameters(POOL_KEY_ABI, [key]));
}

/**
 * `PositionInfo` is packed: 200 bits of truncated pool id, then tickUpper,
 * tickLower, and a subscriber flag in the low byte. Ticks are int24, so they
 * need sign extension — an unsigned read makes every negative lower tick come
 * back as ~16.7 million, which silently draws the wrong range.
 */
export function decodePositionInfo(info: bigint): { tickLower: number; tickUpper: number } {
  const mask = (1n << 24n) - 1n;
  return {
    tickLower: Number(BigInt.asIntN(24, (info >> 8n) & mask)),
    tickUpper: Number(BigInt.asIntN(24, (info >> 32n) & mask)),
  };
}
