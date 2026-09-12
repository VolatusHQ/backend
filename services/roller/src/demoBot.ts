/**
 * Keeps the pool visibly alive between real traders: one randomized swap on
 * the measured pool per tick (the accumulator only samples once per block
 * anyway — see `VolatusHook._afterSwap` — so volume within a block buys
 * nothing; what matters is spreading swaps across ticks over wall-clock
 * time), and occasionally a trade in the current epoch's vol pool so implied
 * volatility moves too, not just realized.
 *
 * Deliberately *not* a fixed alternating pattern (`DemoVolatility.s.sol`'s
 * `i % 2 == 0` is fine for a one-off proof script, but reads as mechanical
 * under continuous operation): direction and size are both randomized here.
 *
 * Mints its own mWETH/mUSDC as needed — both are open testnet faucets
 * (`MintableERC20`), so there is no reason for the bot to ever run dry.
 */

import type { Address, PublicClient } from "viem";
import {
  erc20Abi,
  mintableErc20Abi,
  poolSwapTestAbi,
  sigmaVaultAbi,
  MEASURED_POOL_KEY,
  MOCK_USDC,
  MOCK_WETH,
  SIGMA_VAULT,
  SWAP_ROUTER,
} from "@volatus/onchain";
import type { Wallet } from "@volatus/service-kit";
import type { Logger } from "./journalReconcile.js";
import { poolKeyFor } from "./roll.js";

const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

export interface DemoBotDeps {
  client: PublicClient;
  wallet: Wallet;
  logger: Logger;
  poolId: `0x${string}`;
  volSwapProb: number;
  swapSizeWad: bigint;
  swapSizeJitterPct: number;
  /** Injectable for tests — defaults to `Math.random`. */
  random?: () => number;
}

export interface DemoBotResult {
  ran: boolean;
  kind: "underlying" | "vol" | "skipped-no-active-epoch";
}

function jitteredSize(baseWad: bigint, jitterPct: number, random: () => number): bigint {
  if (jitterPct <= 0) return baseWad;
  const factor = 1 - jitterPct + random() * (2 * jitterPct); // in [1-jitter, 1+jitter]
  const scaled = Math.round(factor * 1000);
  return (baseWad * BigInt(scaled)) / 1000n;
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

  // Both legs, generously -- an open faucet, so there is no reason to be stingy.
  const topUp = size * 20n;
  await ensureMinBalance(client, wallet, MOCK_WETH, size * 5n, topUp);
  await ensureMinBalance(client, wallet, MOCK_USDC, size * 5n, topUp);
  await ensureAllowance(client, wallet, MOCK_WETH, SWAP_ROUTER, size);
  await ensureAllowance(client, wallet, MOCK_USDC, SWAP_ROUTER, size);

  const zeroForOne = random() < 0.5;
  const result = await wallet.send({
    address: SWAP_ROUTER,
    abi: poolSwapTestAbi,
    functionName: "swap",
    args: [
      MEASURED_POOL_KEY,
      { zeroForOne, amountSpecified: -size, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
    ],
  });

  if (result.ok) {
    logger.info("demo bot: underlying-pool swap landed", { zeroForOne, sizeWad: size.toString(), hash: result.hash });
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
  const epoch = await client.readContract({ address: SIGMA_VAULT, abi: sigmaVaultAbi, functionName: "epoch", args: [activeEpochId] });
  const longToken = epoch.longToken;
  const longIsCurrency0 = longToken.toLowerCase() < MOCK_USDC.toLowerCase();
  const volKey = poolKeyFor(longToken, MOCK_USDC);

  const size = jitteredSize(deps.swapSizeWad / 2n, deps.swapSizeJitterPct, random); // vol pool is thinner; trade smaller
  const buyingLong = random() < 0.5;

  const topUp = size * 20n;
  await ensureMinBalance(client, wallet, MOCK_USDC, size * 5n, topUp);
  await ensureAllowance(client, wallet, MOCK_USDC, SWAP_ROUTER, size);
  if (!buyingLong) {
    // Selling VAR-LONG needs a balance of it -- only attempt if we hold some
    // (e.g. from a prior reseed's mintPair); buying is always possible.
    const longBalance = await client.readContract({ address: longToken, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address] });
    if (longBalance < size) {
      logger.info("demo bot: skipping a sell-VAR-LONG round, wallet holds none to sell");
      return;
    }
    await ensureAllowance(client, wallet, longToken, SWAP_ROUTER, size);
  }

  // Buying VAR-LONG: spend USDC for it. If long is currency0, that is a
  // oneForZero swap -- exact mirror of TradeVol.s.sol's `zeroForOne = !longIsCurrency0`.
  const zeroForOne = buyingLong ? !longIsCurrency0 : longIsCurrency0;
  const result = await wallet.send({
    address: SWAP_ROUTER,
    abi: poolSwapTestAbi,
    functionName: "swap",
    args: [
      volKey,
      { zeroForOne, amountSpecified: -size, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
    ],
  });

  if (result.ok) {
    logger.info("demo bot: vol-pool swap landed", { buyingLong, sizeWad: size.toString(), hash: result.hash });
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
