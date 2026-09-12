import { fallback, http, type Transport } from "viem";

/**
 * Public Unichain Sepolia RPCs, in rotation order, after whatever keyed
 * primary is configured. Probed 2026-09-13: all three answer chain 1301.
 * `therpc.io`, `onfinality`, `omniatech` and `routeme` returned no chain id
 * and are left out — in the rotation they would only add a timeout.
 */
export const UNICHAIN_SEPOLIA_PUBLIC_RPCS = [
  "https://sepolia.unichain.org",
  "https://unichain-sepolia-rpc.publicnode.com",
  "https://unichain-sepolia.drpc.org",
] as const;

/** The primary first (if set), then the public list, without duplicates. */
export function unichainRpcUrls(primary?: string): string[] {
  return [...new Set([primary, ...UNICHAIN_SEPOLIA_PUBLIC_RPCS].filter((u): u is string => !!u))];
}

/**
 * Tries each URL in order and moves to the next on failure (viem's `fallback`
 * semantics: a contract revert or user rejection is final, anything else
 * rotates).
 *
 * `eth_getLogs` gets one extra rule. Asked for a `toBlock` past its own head,
 * a node returns an empty list for the whole range rather than an error, and
 * providers' heads differ by a few blocks — so a block number read from one
 * node and logs read from another silently lose events. A log query is only
 * sent to a node that has reached its `toBlock`; otherwise it rotates.
 */
export function rotatingTransport(urls: readonly string[]): Transport {
  const singles = urls.map((u) => http(u, { timeout: 10_000, retryCount: 0 }));
  const all = fallback(singles, { retryCount: 1 });

  return (params) => {
    const base = all(params);
    const nodes = singles.map((t) => t(params));

    const request = (async (args: { method: string; params?: unknown }, options?: unknown) => {
      if (args.method !== "eth_getLogs") return base.request(args as never, options as never);

      const to = (args.params as [{ toBlock?: unknown }] | undefined)?.[0]?.toBlock;
      const toBlock = typeof to === "string" && to.startsWith("0x") ? BigInt(to) : null;

      let lastError: unknown = new Error("eth_getLogs: no RPC configured");
      // `toBlock` usually comes from the fastest node's head, so every other
      // node can be a block or two short of it. That is "early", not "down":
      // give them a moment and try again rather than failing the query.
      for (let round = 0; round < 3; round++) {
        let anyBehind = false;
        for (const node of nodes) {
          try {
            if (toBlock !== null) {
              const head = BigInt((await node.request({ method: "eth_blockNumber" })) as string);
              if (head < toBlock) {
                anyBehind = true;
                lastError = new Error(`RPC head ${head} is behind the requested toBlock ${toBlock}`);
                continue;
              }
            }
            return await node.request(args as never, options as never);
          } catch (err) {
            lastError = err;
          }
        }
        if (!anyBehind) break;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      throw lastError;
    }) as typeof base.request;

    return { ...base, request };
  };
}
