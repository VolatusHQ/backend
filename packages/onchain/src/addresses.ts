/**
 * Deployed addresses. One place, so no backend service and no frontend
 * component ever holds a literal.
 *
 * Taken from the `run-latest.json` files under `contracts/broadcast` and
 * cross-checked against INTEGRATION.md § Addresses. Each was confirmed live by
 * direct `cast call` on 2026-09-04 — see PHASES.md § Ground truth for the
 * exact commands and what they returned.
 *
 * This file is the backend's copy of `apps/web/app/app/lib/onchain/addresses.ts`.
 * `test/drift.test.ts` asserts the two do not disagree — the one deliberate
 * exception is `SIGMA_STREAM`, below.
 */

import type { Address, Hex } from "viem";

/* ---------- Unichain Sepolia (1301) — measurement, collateral, settlement ---------- */

export const SIGMA_HOOK: Address = "0x9215C247Ec3C0082A4bfC26515427c2737D1d040";
export const SIGMA_VAULT: Address = "0xF45894c8384c440FC63Da67Bc6050e77FcaF4e83";
export const VARIANCE_TOKEN_IMPL: Address = "0xBE28c060b7F6Cb8C055430eA1CE75d8C577b2d21";

/**
 * Redeployed 2026-09-05, and the reason matters.
 *
 * `registerVolPool` is `curator`-only and `curator` is `immutable`. On the
 * original oracle (`0xd7602c41…a7c`) it is `0x364EDC06…5609` — the deployer
 * key nobody holds, the same one stranded as SigmaStream's `settlementReporter`
 * (PHASES.md § Ground truth). So no epoch after the first could ever have a vol
 * pool registered on it: no implied volatility, no price, nothing to trade,
 * permanently.
 *
 * The oracle holds no funds and stores nothing but that registry — it derives
 * everything else from the vault and the hook, which are unchanged — so
 * replacing it costs nothing and unblocks every future epoch. Integrators
 * reading the old address still get epoch 1's frozen answer; this is the live
 * one.
 */
export const SIGMA_ORACLE: Address = "0x94F50Fb5b417024F66A80d6515b52E25426C59e5";

export const MOCK_WETH: Address = "0xde45563c9c596fC761e3a18ABB66aE51904de0F4";
export const MOCK_USDC: Address = "0xd00FaDdE160cecbB3ad946BE3542b9553c5B582B";

/** Uniswap v4 on Unichain Sepolia. Confirmed by `eth_getCode` on 2026-09-04. */
export const POOL_MANAGER: Address = "0x00B036B58a818B1BC34d502D3fE730Db729e62AC";
export const POSITION_MANAGER: Address = "0xf969Aee60879C54bAAed9F3eD26147Db216Fd664";
export const STATE_VIEW: Address = "0xc199F1072a74D4e905ABa1A84d9a45E2546B6222";
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/**
 * The two v4-core *test* routers deployed alongside the protocol by
 * `DeployTestnet.s.sol`. They are testnet convenience, not protocol: the swap
 * router is how the vol pool is traded, which is how implied volatility moves.
 */
export const SWAP_ROUTER: Address = "0xf8b077ccc960089fdc0d633e90a6a991cbdb5eb8";
export const LP_ROUTER: Address = "0xc05f9c18ad53a4af485bf34840e3b062462546d6";

/**
 * The pool being *measured* — the mWETH/mUSDC v4 pool. Every oracle and hook
 * call is keyed by this, not by the variance pool's id.
 *
 * Verified: `keccak256(abi.encode(MEASURED_POOL_KEY))` equals this exactly.
 */
export const MEASURED_POOL_ID: Hex =
  "0xc60f25d0a8e2ec722cc0d7f2cff8179340bd5a034351319ada88292d23f21b89";

/** v4 sorts currencies by address. mUSDC (0xd00f…) sorts below mWETH (0xde45…). */
export const MEASURED_POOL_KEY = {
  currency0: MOCK_USDC,
  currency1: MOCK_WETH,
  fee: 3000,
  tickSpacing: 60,
  hooks: SIGMA_HOOK,
} as const;

/** Both pools were created with the same fee tier and spacing. */
export const POOL_FEE = 3000;
export const TICK_SPACING = 60;

/* ---------- Arc Testnet (5042002) — the premium stream ---------- */

/**
 * Redeployed 2026-09-05. The old address, `0xD7EeD2a64762A7038d64886882161bA1b1EfC074`,
 * is dead: its `settlementReporter` is `immutable` and was set at construction
 * to `0x364EDC06…5609`, a key nobody on the team holds, so no epoch on it
 * could ever be reported and every subscriber there is permanently limited to
 * the `reclaimUnreported` fail-safe. This deployment's `settlementReporter` is
 * `0xFf54812Fc9EC92E51a22f67a92Cd2c09a049E30c`, held by the team.
 *
 * `apps/web/app/app/lib/onchain/addresses.ts` still points at the old address
 * until the frontend is re-pointed (WIRING.md § Redeploy) — see
 * `test/drift.test.ts` for the explicit, temporary exemption.
 */
export const SIGMA_STREAM: Address = "0x6C35BEC76B7c43DDdbF0b46E3402D1461b4233D9";

/**
 * The only epoch mirrored onto Arc today. One place to bump when the vault
 * rolls to a new epoch and it gets mirrored across.
 *
 * Note this is the *Arc* epoch id. The Unichain vault runs its own epoch
 * counter, read live from `activeEpoch(poolId)` — never hardcoded, because the
 * vault rolls epochs and a stale constant would price the wrong market.
 */
export const LIVE_EPOCH_ID = 2n;

/**
 * The one real subscriber on `LIVE_EPOCH_ID` today — the deployer/demo LP,
 * matching `services/hedger/src/config.ts`'s `DEMO_OWNER_ADDRESS`. Not a
 * secret; it is a public address, and reading its subscription needs no
 * wallet connection — `readSubscription` is a plain view call keyed by any
 * address. `apps/web`'s copy of this file uses it to show a live subscriber's
 * coverage state publicly on `/app/markets` (HANDOFF.md § Frontend).
 */
export const DEMO_SUBSCRIBER_ADDRESS: Address = "0x7975E591c26e6c6D9B0CFd9A81f6d61A921C080c";

/**
 * The Arc block `SIGMA_STREAM` was deployed in.
 *
 * Log scanning must start here, never at 0. Arc prunes history — `fromBlock: 0`
 * returns `4444 pruned history unavailable` — and a full-range scan is tens of
 * millions of blocks, which trips the RPC's rate limit long before it finds
 * anything. Nothing before this block can carry an event from this contract,
 * because the contract did not exist yet.
 */
export const SIGMA_STREAM_DEPLOY_BLOCK = 60_484_110n;


/**
 * USDC on Arc as an ERC-20, 6 decimals. Also the native gas asset under an
 * 18-decimal view — the same funds seen two ways. See `chains.ts`.
 */
export const ARC_USDC: Address = "0x3600000000000000000000000000000000000000";

/** Collateral, the variance legs and everything on Arc are 6dp. Vol is WAD. */
export const USDC_DECIMALS = 6;
export const WETH_DECIMALS = 18;
export const WAD = 10n ** 18n;
