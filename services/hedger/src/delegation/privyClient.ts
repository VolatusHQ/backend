/**
 * The concrete implementation of `PrivyWalletApiClient` (see
 * `privySessionSigner.ts`) against the real `@privy-io/node` SDK.
 *
 * This is the piece that was missing before this file existed:
 * `privySessionSigner.ts` defined the interface and was unit-tested against
 * a mock of it, but nothing in this repo ever called the real SDK. Verified
 * here against `@privy-io/node@0.34.0`'s actual installed `.d.ts` files
 * (`node_modules/@privy-io/node/public-api/**`), not against a summary or a
 * guess. Two things worth recording because they are easy to get wrong from
 * the docs site alone:
 *
 *   - The package exports two different client shapes: a low-level
 *     Stainless-generated `Client` (`client.d.ts`, methods like
 *     `wallets.create`, `wallets._rpc` — underscore-prefixed and returning a
 *     `{ method, data: {...} }` envelope) and the ergonomic public
 *     `PrivyClient` this file actually uses, where `wallets` and `policies`
 *     are *methods* (`privy.wallets()`, `privy.policies()`), and
 *     `privy.wallets().ethereum().sendTransaction(...)` unwraps that
 *     envelope for you and resolves directly with `{ hash, caip2, ... }`.
 *     Do not mix the two — `client.wallets._rpc` does not exist on
 *     `PrivyClient`.
 *   - There is no `policyId` argument on the send call itself. A policy is
 *     attached to a *wallet* at creation time (`wallets().create({
 *     policy_ids })`), so enforcement happens because the wallet itself
 *     carries the policy — not because each call names one. This adapter's
 *     `policyId` parameter (kept for interface compatibility with
 *     `PrivyWalletApiClient` and its existing tests) is informational only:
 *     it is passed through for logging, never sent to Privy. The real gate
 *     is provisioning the wallet correctly in the first place
 *     (`scripts/provisionPrivy.ts`).
 */

import type { PrivyClient } from "@privy-io/node";
import type { Hash } from "viem";
import type { PrivyWalletApiClient } from "./privySessionSigner.js";

export interface MakePrivyWalletApiClientOptions {
  privy: PrivyClient;
}

export function makePrivyWalletApiClient(opts: MakePrivyWalletApiClientOptions): PrivyWalletApiClient {
  const { privy } = opts;

  return {
    async sendTransaction({ walletId, caip2, transaction }) {
      const result = await privy
        .wallets()
        .ethereum()
        .sendTransaction(walletId, {
          caip2: caip2 as Parameters<
            ReturnType<ReturnType<PrivyClient["wallets"]>["ethereum"]>["sendTransaction"]
          >[1]["caip2"],
          params: {
            transaction: {
              to: transaction.to,
              data: transaction.data,
              ...(transaction.value && transaction.value > 0n
                ? { value: `0x${transaction.value.toString(16)}` as const }
                : {}),
            },
          },
        });

      return { hash: result.hash as Hash };
    },
  };
}