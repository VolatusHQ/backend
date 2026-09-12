import { createPublicClient, http, type HttpTransport, type PublicClient, type Transport } from "viem";
import { arcTestnet, unichainSepolia } from "./chains.js";
import { rotatingTransport, unichainRpcUrls } from "./transport.js";

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
 * `UNICHAIN_SEPOLIA_RPC` is the primary; on failure reads rotate through the
 * public list in `transport.ts`. `ARC_TESTNET_RPC` overrides Arc's public
 * default in `chains.ts`.
 */

const arcRpc = process.env.ARC_TESTNET_RPC || undefined;

export const unichainClient: PublicClient<Transport, typeof unichainSepolia> = createPublicClient({
  chain: unichainSepolia,
  transport: rotatingTransport(unichainRpcUrls(process.env.UNICHAIN_SEPOLIA_RPC || undefined)),
  batch: { multicall: true },
});

export const arcClient: PublicClient<HttpTransport, typeof arcTestnet> = createPublicClient({
  chain: arcTestnet,
  transport: http(arcRpc, { timeout: 10_000, retryCount: 2 }),
  batch: { multicall: true },
});
