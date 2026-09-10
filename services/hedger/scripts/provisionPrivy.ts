#!/usr/bin/env node
/**
 * One-time setup script. Run manually, NOT part of the tick loop or `index.ts`.
 *
 *   PRIVY_APP_ID=... PRIVY_APP_SECRET=... node dist/scripts/provisionPrivy.js
 *
 * Creates, in order:
 *   1. A Privy policy that reproduces `policy/sigma-hedger-v1.json`'s intent —
 *      allow subscribe/fund/adjust on SigmaStream, allow USDC.approve with the
 *      spender constrained to SigmaStream, deny everything else by default
 *      (Privy's policy engine denies anything no ALLOW rule matches — there is
 *      no explicit "default deny" rule to write).
 *   2. A wallet on Arc Testnet with that policy attached at creation
 *      (`policy_ids`), which is how enforcement actually binds — see
 *      `delegation/privyClient.ts`'s header for why there is no per-call
 *      policy parameter in the real API.
 *
 * Prints the policy id, wallet id and wallet address. Paste them into
 * `services/.env.local` as `PRIVY_WALLET_ID=...` and set
 * `HEDGER_SIGNER_MODE=privy`, then fund that wallet address with Arc testnet
 * USDC (gas on Arc IS USDC) before running the hedger with a real signer.
 *
 * Idempotency: running this twice creates a second policy and a second
 * wallet. Privy does not dedupe by content. If you re-run this, either reuse
 * the printed ids or delete the old ones from the dashboard first.
 *
 * **Re-targeting after a SigmaStream redeploy.** A policy's rules are pinned
 * to whatever `SIGMA_STREAM` resolved to at the time it was created — a
 * redeploy changes that address, so the old policy still exists and still
 * enforces, it just permits calls to a contract that no longer matters. Set
 * `PRIVY_UPDATE_EXISTING_WALLET_ID` to update an already-funded wallet's
 * `policy_ids` to a freshly built policy targeting the current
 * `SIGMA_STREAM`, instead of creating (and having to fund) a new wallet.
 */

import { PrivyClient } from "@privy-io/node";
import type { AbiSchema } from "@privy-io/node/resources";
import { erc20Abi, sigmaStreamAbi, SIGMA_STREAM, ARC_USDC } from "@volatus/onchain";
import { loadEnvFile } from "@volatus/service-kit";

// Loads services/.env.local the same way every other service's `loadConfig`
// does, so this script needs no `--env-file` flag when run via `pnpm
// provision:privy` — a plain `process.env` read below would otherwise miss
// PRIVY_APP_ID/PRIVY_APP_SECRET sitting only in that file.
loadEnvFile();

const ARC_CAIP2 = "eip155:5042002";

/**
 * Privy's `AbiSchema` (used to decode calldata in an `ethereum_calldata`
 * policy condition) only accepts function/constructor/event/fallback/receive
 * fragments — no custom errors. This repo's ABIs (`@volatus/onchain`) include
 * every custom error so reverts decode to names elsewhere in the codebase,
 * so they must be filtered before being handed to Privy. The cast back to
 * `AbiSchema` is safe: the filter predicate is exactly that type's
 * discriminant, TypeScript just cannot narrow through a runtime `Set.has`.
 */
const PRIVY_ABI_FRAGMENT_TYPES = new Set(["function", "constructor", "event", "fallback", "receive"]);
function toPrivyAbiSchema(abi: readonly { type: string }[]): AbiSchema {
  return abi.filter((item) => PRIVY_ABI_FRAGMENT_TYPES.has(item.type)) as AbiSchema;
}

const sigmaStreamAbiForPrivy = toPrivyAbiSchema(sigmaStreamAbi);
const erc20AbiForPrivy = toPrivyAbiSchema(erc20Abi);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`provisionPrivy: ${name} is required — export it before running this script`);
  }
  return value;
}

async function main(): Promise<void> {
  const appId = requireEnv("PRIVY_APP_ID");
  const appSecret = requireEnv("PRIVY_APP_SECRET");

  const privy = new PrivyClient({ appId, appSecret });

  console.log(`Creating policy "sigma-hedger-v1" on Arc Testnet (${ARC_CAIP2})...`);

  const policy = await privy.policies().create({
    chain_type: "ethereum",
    name: "sigma-hedger-v1",
    version: "1.0",
    rules: [
      {
        name: "streamPremium-subscribe",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [
          { field_source: "ethereum_transaction", field: "to", operator: "eq", value: SIGMA_STREAM },
          { field_source: "ethereum_calldata", abi: sigmaStreamAbiForPrivy, field: "function_name", operator: "eq", value: "subscribe" },
        ],
      },
      {
        name: "streamPremium-fund",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [
          { field_source: "ethereum_transaction", field: "to", operator: "eq", value: SIGMA_STREAM },
          { field_source: "ethereum_calldata", abi: sigmaStreamAbiForPrivy, field: "function_name", operator: "eq", value: "fund" },
        ],
      },
      {
        name: "adjustCoverage",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [
          { field_source: "ethereum_transaction", field: "to", operator: "eq", value: SIGMA_STREAM },
          { field_source: "ethereum_calldata", abi: sigmaStreamAbiForPrivy, field: "function_name", operator: "eq", value: "adjust" },
        ],
      },
      {
        name: "approveStreamSpend",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [
          { field_source: "ethereum_transaction", field: "to", operator: "eq", value: ARC_USDC },
          { field_source: "ethereum_calldata", abi: erc20AbiForPrivy, field: "function_name", operator: "eq", value: "approve" },
          { field_source: "ethereum_calldata", abi: erc20AbiForPrivy, field: "approve.spender", operator: "eq", value: SIGMA_STREAM },
        ],
      },
    ],
  });

  console.log(`Policy created: ${policy.id}`);

  const existingWalletId = process.env.PRIVY_UPDATE_EXISTING_WALLET_ID;
  if (existingWalletId) {
    console.log(`Updating existing wallet ${existingWalletId} to use this policy...`);
    const wallet = await privy.wallets().update(existingWalletId, { policy_ids: [policy.id] });
    console.log("");
    console.log("Done. services/.env.local's PRIVY_WALLET_ID is unchanged (same wallet, new policy):");
    console.log("");
    console.log(`PRIVY_WALLET_ID=${wallet.id}`);
    console.log(`Wallet address: ${wallet.address}`);
    console.log(`No new funding needed — this wallet was already funded.`);
    return;
  }

  console.log(`Creating a wallet on Arc Testnet with that policy attached...`);

  const wallet = await privy.wallets().create({
    chain_type: "ethereum",
    policy_ids: [policy.id],
  });

  console.log("");
  console.log("Done. Save these to services/.env.local:");
  console.log("");
  console.log(`PRIVY_WALLET_ID=${wallet.id}`);
  console.log(`HEDGER_SIGNER_MODE=privy`);
  console.log("");
  console.log(`Wallet address: ${wallet.address}`);
  console.log(`Fund this address with Arc Testnet USDC before running the hedger for real — on Arc, gas IS USDC.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});