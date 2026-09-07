/**
 * Off-chain mirror of `SigmaStream`'s share accounting
 * (`contracts/src/SigmaStream.sol`, `postCapacity` / `withdrawCapacity`).
 *
 * Both contract functions compute their result with OpenZeppelin's 3-argument
 * `Math.mulDiv(a, b, denominator)`, which rounds DOWN (floors). This file
 * reproduces that arithmetic exactly, including the rounding direction, using
 * BigInt division. BigInt division truncates toward zero, which is the same
 * as flooring for every value these functions ever see (amounts, shares and
 * `capacityPool` are all non-negative) — so `(a * b) / c` in TypeScript is a
 * bit-for-bit match for the contract's `Math.mulDiv(a, b, c)`, not an
 * approximation. There is no overflow concern here that the contract's
 * 512-bit-intermediate trick guards against: BigInt is arbitrary precision,
 * so the naive product is always exact.
 *
 * `sharePriceWad` is NOT a contract quantity — `SigmaStream` never computes a
 * "price per share" anywhere. It exists here purely for display and for the
 * policy module's decisions, so its own rounding direction (down, WAD-scaled)
 * is a choice this file makes, not one mirrored from the contract. It is
 * documented so a caller doesn't assume otherwise.
 */

const WAD = 10n ** 18n;

/**
 * `(a * b) / denominator`, floored. The one primitive both contract functions
 * below reduce to. Throws on a zero denominator rather than letting BigInt
 * division throw `RangeError: Division by zero` with a less specific message
 * — `Math.mulDiv` on-chain would revert (panic) in the same situation.
 */
export function mulDivDown(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new Error("shares: mulDivDown — division by zero (denominator is 0)");
  }
  if (a < 0n || b < 0n || denominator < 0n) {
    throw new Error("shares: mulDivDown — negative operand; every quantity here is non-negative on-chain");
  }
  return (a * b) / denominator;
}

/**
 * Value of one share, in WAD-scaled 6dp-USDC-per-share. Purely a display /
 * decision quantity (see module doc) — never fed back into an on-chain call.
 * `0n` when `totalShares` is `0` (no shares outstanding, e.g. before the
 * first `postCapacity` ever): the price is undefined at that point, and `0`
 * is the least misleading sentinel, not a real quote of "capacity is
 * worthless." Callers must check `totalShares === 0n` themselves before
 * treating this as a real price.
 */
export function sharePriceWad(capacityPool: bigint, totalShares: bigint): bigint {
  if (totalShares === 0n) return 0n;
  return mulDivDown(capacityPool, WAD, totalShares);
}

/**
 * Mirrors `postCapacity`'s `mintedShares` calculation exactly
 * (`contracts/src/SigmaStream.sol`):
 *
 *   mintedShares = capacityPool == 0 ? received : Math.mulDiv(received, totalShares, capacityPool);
 *
 * `received` there is `usdc.balanceOf(this)` before/after the transfer, i.e.
 * the amount actually received net of any transfer-fee token behaviour —
 * this function takes that net `amount` directly; it does not know about
 * fee-on-transfer tokens itself (USDC on Arc has none).
 */
export function projectPostCapacity(amount: bigint, capacityPool: bigint, totalShares: bigint): bigint {
  if (amount < 0n) throw new Error("shares: projectPostCapacity — negative amount");
  if (amount === 0n) return 0n;
  return capacityPool === 0n ? amount : mulDivDown(amount, totalShares, capacityPool);
}

/**
 * Mirrors `withdrawCapacity`'s `amount` calculation exactly:
 *
 *   amount = Math.mulDiv(shareAmount, capacityPool, totalShares);
 *
 * Throws when `totalShares` is `0` — the contract would revert with a
 * division-by-zero panic in the same situation (and `shares[msg.sender] -=
 * shareAmount` would already have underflowed for any nonzero `shareAmount`
 * before reaching the division, since nobody can hold shares when none
 * exist).
 */
export function projectWithdrawal(shareAmount: bigint, capacityPool: bigint, totalShares: bigint): bigint {
  if (shareAmount < 0n) throw new Error("shares: projectWithdrawal — negative shareAmount");
  if (totalShares === 0n) {
    throw new Error("shares: projectWithdrawal — totalShares is 0; the contract would panic (division by zero) too");
  }
  return mulDivDown(shareAmount, capacityPool, totalShares);
}
