/**
 * The reporter holds exactly one key (`REPORTER_PRIVATE_KEY`) but uses it on
 * both chains: to call the permissionless `SigmaVault.settle` on Unichain
 * (paying ETH gas) and the reporter-gated `openEpoch`/`reportPayoff` on Arc
 * (paying USDC gas). Two `Wallet`s, same key, different chain + RPC + gas
 * asset — never mixed.
 */

import { arcTestnet, unichainSepolia } from "@volatus/onchain";
import { makeWallet, type Wallet } from "@volatus/service-kit";
import type { ReporterConfig } from "./config.js";

export interface ReporterWallets {
  unichainWallet: Wallet;
  arcWallet: Wallet;
}

export function makeReporterWallets(config: ReporterConfig): ReporterWallets {
  const privateKey = config.REPORTER_PRIVATE_KEY as `0x${string}`;
  return {
    unichainWallet: makeWallet({
      chain: unichainSepolia,
      privateKey,
      rpcUrl: config.UNICHAIN_SEPOLIA_RPC,
    }),
    arcWallet: makeWallet({
      chain: arcTestnet,
      privateKey,
      rpcUrl: config.ARC_TESTNET_RPC,
    }),
  };
}
