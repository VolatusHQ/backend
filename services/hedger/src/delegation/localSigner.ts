/**
 * Testnet demonstration ONLY. Signs directly with a private key this
 * process holds in memory — this is NOT the production delegation path.
 *
 * The production path is `privySessionSigner.ts`: a Privy session signer
 * under a TEE-enforced policy that never gives this backend a user's key at
 * all, so a compromised backend cannot exfiltrate one. This signer holds a
 * real key directly, so a compromised process running with this signer
 * *can* do anything that key can do at the RPC level — the `Signer`
 * interface (`signer.ts`) still stops *this service's own code* from
 * asking it to call anything but `approve(streamAddress, _)` and
 * `subscribe|fund|adjust` on `streamAddress`, but that is an application-level
 * discipline, not a cryptographic guarantee the way Privy's TEE policy is.
 * README.md § Delegation states this distinction plainly and this file
 * exists to make it impossible to reach by accident:
 *
 *   - It refuses to construct unless `HEDGER_ALLOW_LOCAL_SIGNER` is exactly
 *     `"1"` in the environment — not "truthy", exactly that string.
 *   - The key it uses is one the team already owns for testnet operation
 *     (`contracts/.env`'s deployer key), never a user's.
 *   - Every log line and the README both say, in words, that this is a
 *     demonstration path.
 */

import { arcTestnet, ARC_USDC, SIGMA_STREAM, erc20Abi, sigmaStreamAbi } from "@volatus/onchain";
import { makeWallet, type SendResult, type Wallet } from "@volatus/service-kit";
import type { Address } from "viem";
import { ALLOWED_STREAM_METHODS, type Signer, type StreamMethod } from "./signer.js";

export interface LocalSignerOptions {
  privateKey: `0x${string}`;
  rpcUrl: string;
  /** Must be exactly `"1"`. Anything else — unset, `"0"`, `"true"` — throws. */
  allowFlag: string | undefined;
  streamAddress?: Address;
  usdcAddress?: Address;
  /** Injectable for tests, so constructing a signer never opens a real RPC connection. Defaults to `@volatus/service-kit`'s `makeWallet`. */
  walletFactory?: typeof makeWallet;
}

export function makeLocalSigner(opts: LocalSignerOptions): Signer {
  if (opts.allowFlag !== "1") {
    throw new Error(
      "localSigner: refusing to run without HEDGER_ALLOW_LOCAL_SIGNER=1. This signer holds a real " +
        "private key directly and is a testnet demonstration only, never the production delegation " +
        "path — see delegation/privySessionSigner.ts and README.md § Delegation.",
    );
  }

  const streamAddress = opts.streamAddress ?? SIGMA_STREAM;
  const usdcAddress = opts.usdcAddress ?? ARC_USDC;
  const walletFactory = opts.walletFactory ?? makeWallet;
  const wallet: Wallet = walletFactory({ chain: arcTestnet, privateKey: opts.privateKey, rpcUrl: opts.rpcUrl });

  async function approveStreamSpend(amount: bigint): Promise<SendResult> {
    return wallet.send({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [streamAddress, amount],
    });
  }

  async function callStream(method: StreamMethod, args: readonly bigint[]): Promise<SendResult> {
    if (!ALLOWED_STREAM_METHODS.includes(method)) {
      return { ok: false, reason: `localSigner: "${method}" is not an allowed SigmaStream method` };
    }
    return wallet.send({
      address: streamAddress,
      abi: sigmaStreamAbi,
      functionName: method,
      args: args as readonly unknown[],
    });
  }

  return { address: wallet.address, approveStreamSpend, callStream };
}
