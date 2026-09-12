/**
 * Keeps the pool visibly alive between real traders: one randomized swap on
 * the measured pool per tick (the accumulator only samples once per block
 * anyway — see `VolatusHook._afterSwap` — so volume within a block buys
 * nothing; what matters is spreading swaps across ticks over wall-clock
 * time), and occasionally a trade in the current epoch's vol pool so implied
 * volatility moves too, not just realized.
 *
 * Every swap is bounded to the tick range the pool's liquidity actually
 * covers. An unbounded swap (limit at the pool's physical min/max sqrtPrice)
 * that runs past the last liquidity jumps straight to that physical limit and
 * leaves the pool with zero in-range liquidity — which is exactly how the
 * measured pool ended up pinned at tick 887271, where no later swap could
 * move it and realized vol read zero.
 *
 * Mints its own mWETH/mUSDC as needed — both are open testnet faucets
 * (`MintableERC20`), so there is no reason for the bot to ever run dry.
 */

import type { Address, PublicClient } from "viem";
import {
  erc20Abi,
  mintableErc20Abi,
  poolSwapTestAbi,
  sigmaOracleVolPoolAbi,
  sigmaVaultAbi,
  stateViewAbi,
  MEASURED_POOL_ID,
  MEASURED_POOL_KEY,
  MOCK_USDC,
  MOCK_WETH,
  SIGMA_ORACLE,
  SIGMA_VAULT,
  STATE_VIEW,
  SWAP_ROUTER,
} from "@volatus/onchain";
import type { Wallet } from "@volatus/service-kit";
import type { Logger } from "./journalReconcile.js";
import { poolKeyFor } from "./roll.js";

/** A seeded position's range, as ticks and the sqrtPriceX96 at each edge. */
interface Range {
  lowerTick: number;
  upperTick: number;
  lowerSqrt: bigint;
  upperSqrt: bigint;
}

/** `DeployTestnet.s.sol` seeds the measured pool over [-6000, 6000]. */
const MEASURED_RANGE: Range = {
  lowerTick: -6000,
  upperTick: 6000,
  lowerSqrt: 58694546734607936014596754228n,
  upperSqrt: 106945228894416644761163377413n,
};

/** `roll.ts` seeds every epoch's vol pool over [-23040, 0] (TICK_LOWER/TICK_UPPER). */
const VOL_RANGE: Range = {
  lowerTick: -23040,
  upperTick: 0,
  lowerSqrt: 25037868506736684196722767382n,
  upperSqrt: 79228162514264337593543950336n,
};

/** Within one tick spacing of an edge counts as "at" it — a swap pushing
 *  further that way would hit its own limit immediately and revert. */
const EDGE_MARGIN = 60;

export interface DemoBotDeps {
  client: PublicClient;
  wallet: Wallet;
  logger: Logger;
  poolId: `0x${string}`;
  volSwapProb: number;
  /** Raw units spent per measured-pool swap. That pool is priced 1:1 in raw
   *  units (seeded at SQRT_PRICE_1_1), so the same raw size is symmetric in
   *  both directions regardless of the two tokens' decimals. */
  swapSizeWad: bigint;
  /** Raw 6dp units (mUSDC or VAR-LONG) spent per vol-pool swap. */
  volSwapSize: bigint;
  swapSizeJitterPct: number;
  /** Injectable for tests — defaults to `Math.random`. */
  random?: () => number;
}

export interface DemoBotResult {
  ran: boolean;
  kind: "underlying" | "vol" | "skipped-no-active-epoch";
}

function jitteredSize(base: bigint, jitterPct: number, random: () => number): bigint {
  if (jitterPct <= 0) return base;
  const factor = 1 - jitterPct + random() * (2 * jitterPct); // in [1-jitter, 1+jitter]
  const scaled = Math.round(factor * 1000);
  return (base * BigInt(scaled)) / 1000n;
}

/** Random direction, except at (or past) an edge of the seeded range, where
 *  the only swap that can trade against liquidity is the one heading back in. */
function chooseZeroForOne(tick: number, range: Range, random: () => number): boolean {
  if (tick >= range.upperTick - EDGE_MARGIN) return true;
  if (tick <= range.lowerTick + EDGE_MARGIN) return false;
  return random() < 0.5;
}

function limitFor(zeroForOne: boolean, range: Range): bigint {
  return zeroForOne ? range.lowerSqrt : range.upperSqrt;
}

async function readSlot0Tick(client: PublicClient, poolId: `0x${string}`): Promise<number> {
  const [, tick] = await client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] });
  return tick;
}

async function ensureMinBalance(
  client: PublicClient,
  wallet: Wallet,
  token: Address,
  min: bigint,
  topUp: bigint,
): Promise<void> {
  const balance = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address] });
  if (balance >= min) return;
  await wallet.send({ address: token, abi: mintableErc20Abi, functionName: "mint", args: [wallet.address, topUp] });
}

async function ensureAllowance(
  client: PublicClient,
  wallet: Wallet,
  token: Address,
  spender: Address,
  min: bigint,
): Promise<void> {
  const allowance = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [wallet.address, spender],
  });
  if (allowance >= min) return;
  await wallet.send({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, 2n ** 200n] });
}

async function runUnderlyingSwap(deps: DemoBotDeps): Promise<void> {
  const { client, wallet, logger } = deps;
  const random = deps.random ?? Math.random;
  const size = jitteredSize(deps.swapSizeWad, deps.swapSizeJitterPct, random);

  const topUp = size * 20n;
  await ensureMinBalance(client, wallet, MOCK_WETH, size * 5n, topUp);
  await ensureMinBalance(client, wallet, MOCK_USDC, size * 5n, topUp);
  await ensureAllowance(client, wallet, MOCK_WETH, SWAP_ROUTER, size);
  await ensureAllowance(client, wallet, MOCK_USDC, SWAP_ROUTER, size);

  const tick = await readSlot0Tick(client, MEASURED_POOL_ID);
  const zeroForOne = chooseZeroForOne(tick, MEASURED_RANGE, random);
  const result = await wallet.send({
    address: SWAP_ROUTER,
    abi: poolSwapTestAbi,
    functionName: "swap",
    args: [
      MEASURED_POOL_KEY,
      { zeroForOne, amountSpecified: -size, sqrtPriceLimitX96: limitFor(zeroForOne, MEASURED_RANGE) },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
    ],
  });

  if (result.ok) {
    logger.info("demo bot: underlying-pool swap landed", { zeroForOne, fromTick: tick, size: size.toString(), hash: result.hash });
  } else {
    logger.warn("demo bot: underlying-pool swap failed, skipping this round", { reason: result.reason });
  }
}

async function runVolPoolSwap(deps: DemoBotDeps): Promise<void> {
  const { client, wallet, logger, poolId } = deps;
  const random = deps.random ?? Math.random;

  const activeEpochId = await client.readContract({
    address: SIGMA_VAULT,
    abi: sigmaVaultAbi,
    functionName: "activeEpoch",
    args: [poolId],
  });
  if (activeEpochId === 0n) {
    logger.info("demo bot: no active epoch, skipping vol-pool round");
    return;
  }

  // Only trade a vol pool the roller has finished seeding. `registerVolPool`
  // lands before the liquidity step, so a registered pool can still be empty
  // — and a swap into an empty pool moves its price to the limit for free.
  const vp = await client.readContract({ address: SIGMA_ORACLE, abi: sigmaOracleVolPoolAbi, functionName: "volPool", args: [activeEpochId] });
  if (!vp.registered) {
    logger.info("demo bot: vol pool not registered yet, skipping vol-pool round");
    return;
  }
  const liquidity = await client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getLiquidity", args: [vp.poolId] });
  if (liquidity === 0n) {
    logger.info("demo bot: vol pool has no in-range liquidity yet, skipping vol-pool round");
    return;
  }

  const epoch = await client.readContract({ address: SIGMA_VAULT, abi: sigmaVaultAbi, functionName: "epoch", args: [activeEpochId] });
  const longToken = epoch.longToken;
  const longIsCurrency0 = vp.longIsCurrency0;
  const volKey = poolKeyFor(longToken, MOCK_USDC);

  const tick = await readSlot0Tick(client, vp.poolId);
  const zeroForOne = chooseZeroForOne(tick, VOL_RANGE, random);
  // Buying VAR-LONG spends USDC for it; if long is currency0 that is a
  // oneForZero swap — exact mirror of TradeVol.s.sol's `zeroForOne = !longIsCurrency0`.
  const buyingLong = zeroForOne === !longIsCurrency0;
  const size = jitteredSize(deps.volSwapSize, deps.swapSizeJitterPct, random);

  if (buyingLong) {
    await ensureMinBalance(client, wallet, MOCK_USDC, size * 5n, size * 20n);
    await ensureAllowance(client, wallet, MOCK_USDC, SWAP_ROUTER, size);
  } else {
    const longBalance = await client.readContract({ address: longToken, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address] });
    if (longBalance < size) {
      logger.info("demo bot: skipping a sell-VAR-LONG round, wallet holds too little to sell", { longBalance: longBalance.toString() });
      return;
    }
    await ensureAllowance(client, wallet, longToken, SWAP_ROUTER, size);
  }

  const result = await wallet.send({
    address: SWAP_ROUTER,
    abi: poolSwapTestAbi,
    functionName: "swap",
    args: [
      volKey,
      { zeroForOne, amountSpecified: -size, sqrtPriceLimitX96: limitFor(zeroForOne, VOL_RANGE) },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
    ],
  });

  if (result.ok) {
    logger.info("demo bot: vol-pool swap landed", { buyingLong, fromTick: tick, size: size.toString(), hash: result.hash });
  } else {
    logger.warn("demo bot: vol-pool swap failed, skipping this round", { reason: result.reason });
  }
}

export async function runDemoBotRound(deps: DemoBotDeps): Promise<DemoBotResult> {
  const random = deps.random ?? Math.random;
  if (random() < deps.volSwapProb) {
    await runVolPoolSwap(deps);
    return { ran: true, kind: "vol" };
  }
  await runUnderlyingSwap(deps);
  return { ran: true, kind: "underlying" };
}
