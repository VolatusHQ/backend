/**
 * The "position gamma" half of the hedger's signal (BACKEND_HANDOFF.md §
 * Service 3: "Read the LP's v4 position and derive gamma exposure").
 *
 * **What this actually computes, stated honestly.** A concentrated-liquidity
 * position's true second-order price sensitivity depends on its liquidity,
 * the current price, and its range width, and (README.md's own v4.ts
 * comment) the measured pool's `sqrtPriceX96` "means nothing economically" —
 * it was initialized 1:1 in raw units as a substrate for measuring variance,
 * not a priced market. Computing a dollar gamma from it would be precision
 * theater over a number that isn't a price.
 *
 * What *is* well-defined regardless of whether the pool's price means
 * anything: the position's **share of the pool's total liquidity**,
 * `position.liquidity / pool.liquidity`, while the current tick sits inside
 * the position's range. That ratio is dimensionless, needs no price, and
 * answers the question this signal actually needs answered for sizing
 * coverage: "how much of this pool's variance exposure belongs to this LP,
 * relative to everyone else providing liquidity to it." It is a proportional
 * sizing heuristic, not a calibrated Black-Scholes-style gamma in dollars —
 * `pricing.ts` and README.md § Pricing say this again where it matters.
 *
 * Out of range, a v4 position holds a single asset and its value moves
 * linearly with price until price re-enters the range — no second-order
 * exposure to hedge — so weight is zero there regardless of size.
 */

import { WAD } from "./constants.js";

export interface PositionState {
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
}

export interface PositionSignal {
  /** Whether a live position was found for the mandate's owner in the measured pool at all. */
  found: boolean;
  /** Whether the current tick is inside [tickLower, tickUpper). Meaningless when `found` is false. */
  inRange: boolean;
  /** This position's share of the pool's total liquidity, WAD in [0, 1e18]. Zero when not found or out of range. */
  positionWeightWad: bigint;
}

export const NO_POSITION: PositionSignal = { found: false, inRange: false, positionWeightWad: 0n };

export function computePositionSignal(
  position: PositionState | null,
  poolLiquidity: bigint,
  currentTick: number,
): PositionSignal {
  if (position === null) return NO_POSITION;

  const inRange = currentTick >= position.tickLower && currentTick < position.tickUpper;
  if (!inRange || poolLiquidity <= 0n) {
    return { found: true, inRange, positionWeightWad: 0n };
  }

  const weightWad = (position.liquidity * WAD) / poolLiquidity;
  return { found: true, inRange, positionWeightWad: weightWad > WAD ? WAD : weightWad };
}
