/**
 * The roller holds exactly one key, on exactly one chain — unlike `reporter`,
 * which needs the same key on both Unichain and Arc. Everything this service
 * touches (`SigmaVault.settle`/`openEpoch`, `VolatusOracle.registerVolPool`,
 * `PoolManager.initialize`, `PoolModifyLiquidityTest.modifyLiquidity`, the
 * demo bot's swaps) lives on Unichain; the roller never touches Arc.
 */

import { rotatingTransport, unichainRpcUrls, unichainSepolia } from "@volatus/onchain";
import { makeWallet, type Wallet } from "@volatus/service-kit";
import type { RollerConfig } from "./config.js";

export function makeRollerWallet(config: RollerConfig): Wallet {
  return makeWallet({
    chain: unichainSepolia,
    privateKey: config.ROLLER_PRIVATE_KEY as `0x${string}`,
    rpcUrl: config.UNICHAIN_SEPOLIA_RPC,
    transport: rotatingTransport(unichainRpcUrls(config.UNICHAIN_SEPOLIA_RPC)),
  });
}
