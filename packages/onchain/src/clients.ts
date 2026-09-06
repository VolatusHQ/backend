import { createPublicClient, http, type HttpTransport, type PublicClient } from "viem";
import { arcTestnet, unichainSepolia } from "./chains.js";

/**
 * One read-only client per chain, created at module scope so a request does
 * not pay for a new transport. Read-only on purpose: writes go through a
 * wallet client built per caller (the reporter and keeper each hold a
 * distinct key — see `services/.env.local` and DECISIONS.md §12), never
 * through these.
 *
 * `batch: { multicall: true }` collapses the several reads a job needs into
 * one `eth_call` multicall round trip where the RPC supports it.
 *
 * RPC URLs are overridable via `UNICHAIN_SEPOLIA_RPC` / `ARC_TESTNET_RPC` so a
 * service can point at a private or rate-limit-friendly endpoint without a
 * code change; both fall back to the public testnet defaults baked into
 * `chains.ts`.
 */

const unichainRpc = process.env.UNICHAIN_SEPOLIA_RPC || undefined;
const arcRpc = process.env.ARC_TESTNET_RPC || undefined;

export const unichainClient: PublicClient<HttpTransport, typeof unichainSepolia> = createPublicClient({
  chain: unichainSepolia,
  transport: http(unichainRpc, { timeout: 10_000, retryCount: 2 }),
  batch: { multicall: true },
});

export const arcClient: PublicClient<HttpTransport, typeof arcTestnet> = createPublicClient({
  chain: arcTestnet,
  transport: http(arcRpc, { timeout: 10_000, retryCount: 2 }),
  batch: { multicall: true },
});
