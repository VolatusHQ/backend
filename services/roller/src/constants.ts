/** The journal `service` name every action/cursor in this package is filed under. */
export const SERVICE = "roller";

/**
 * The pool this service rolls epochs for — the same measured WETH/mUSDC pool
 * every other service reads (`packages/onchain`'s `MEASURED_POOL_ID`). The
 * roller does not discover pools from logs the way `reporter` discovers
 * epochs; it only ever cares about the one currently active epoch on this id.
 */
export { MEASURED_POOL_ID } from "@volatus/onchain";
