import { defineChain } from "viem";

/**
 * The two chains, and they are not interchangeable.
 *
 * Measurement, collateral and settlement live on Unichain Sepolia. The premium
 * stream lives on Arc. They are different trust and liveness domains, and any
 * panel showing both must say which chain each number came from — conflating
 * them is how a UI ends up implying the stream is part of settlement. It is
 * not: Arc is a payment rail and nothing settles on it (README.md, and
 * DECISIONS.md §12 for the seam).
 */

export const unichainSepolia = defineChain({
  id: 1301,
  name: "Unichain Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.unichain.org"] } },
  blockExplorers: {
    default: { name: "Uniscan", url: "https://sepolia.uniscan.xyz" },
  },
  testnet: true,
});

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  /**
   * USDC is the native gas asset here. This 18-decimal native view and the
   * 6-decimal ERC-20 at 0x3600…0000 are the SAME funds — never add them
   * together, and never render both as separate balances.
   */
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  testnet: true,
});

/** Which chain a figure came from. Rendered next to it, always. */
export type ChainLabel = "Unichain Sepolia" | "Arc Testnet";
