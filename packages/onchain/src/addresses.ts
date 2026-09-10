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
 * Redeployed 2026-09-08, same reason as the 2026-09-05 redeploy before it: the
 * previous address, `0x6C35BEC76B7c43DDdbF0b46E3402D1461b4233D9`, has its
 * `settlementReporter` set to `0xFf54812Fc9EC92E51a22f67a92Cd2c09a049E30c` — a
 * key that turned out to live only on a teammate's machine, unreachable before
 * Arc epoch 2's 2026-09-12 report deadline. Rather than wait, the contract was
 * redeployed (as `VolatusStream`, from the new `VolatusHQ/contracts` repo —
 * same logic, renamed) with `settlementReporter` set to a fresh key generated
 * and held for this purpose, `0x3c400B31e2b3356985796832b81C2212Ad1BdF6D`.
 * Epoch 2 was re-mirrored immediately in the same deploy script run, targeting
 * the same `coverageEnd`/`reportDeadline` window the original mirror used.
 *
 * The two prior addresses are both dead for the same structural reason: an
 * `immutable settlementReporter` that nobody who actually needs to operate the
 * reporter can sign with. `0xD7EeD2a64762A7038d64886882161bA1b1EfC074` (the
 * original) and `0x6C35BEC76B7c43DDdbF0b46E3402D1461b4233D9` (2026-09-05) are
 * both permanently limited to their subscribers' `reclaimUnreported`.
 *
 * The ABI is unchanged — `VolatusStream`'s Solidity contract name differs from
 * `SigmaStream`'s, but Solidity contract names are not part of the ABI, so
 * `sigmaStreamAbi` below still decodes it correctly without any changes.
 */
export const SIGMA_STREAM: Address = "0xE44b6a47b29b097CE5c20BF17830cfb5df734354";

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
 * The one real subscriber on `LIVE_EPOCH_ID` today — matching
 * `services/hedger/src/config.ts`'s `DEMO_OWNER_ADDRESS`. Updated 2026-09-10:
 * this is now the keeper's own wallet, real-subscribed on the redeployed
 * `SIGMA_STREAM` above (`postCapacity` 10 USDC, `subscribe` rate 55 / notional
 * 4 USDC, `fund` 4 USDC — all three confirmed on Arc; the previous address had
 * no subscription on the fresh contract). Not a secret; it is a public
 * address, and reading its subscription needs no wallet connection —
 * `readSubscription` is a plain view call keyed by any address. `apps/web`'s
 * copy of this file uses it to show a live subscriber's coverage state
 * publicly on `/app/markets` (HANDOFF.md § Frontend).
 */
export const DEMO_SUBSCRIBER_ADDRESS: Address = "0xD717489b5A7CC47dF2a8057ce4658002026FE5de";

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
