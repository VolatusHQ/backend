/**
 * The production delegation path: a Privy session signer under a
 * TEE-enforced policy. This is what README.md's `sigma-hedger-v1` policy
 * (reproduced as a real artifact at `policy/sigma-hedger-v1.json`) actually
 * binds.
 *
 * **What this buys, precisely.** Privy's session signer holds the user's
 * wallet key inside a TEE and will only co-sign a transaction that matches
 * the policy attached to it. This service never receives, sees, or could
 * exfiltrate that key — it only ever gets to *ask* Privy's wallet API to
 * sign-and-send a specific `(to, data)` pair, and the TEE checks that pair
 * against the policy before it is ever signed, independent of whatever this
 * process's own code does. So the property README.md and
 * BACKEND_HANDOFF.md ask for — "a fully compromised Volatus backend cannot
 * move a user's funds anywhere except into premium payments on the pool
 * they authorised, and cannot exceed the mandate" — is enforced by Privy's
 * TEE reading the policy file, not by this module's own good behaviour.
 * This module's own checks (`ALLOWED_STREAM_METHODS`, the pinned
 * `streamAddress`/`usdcAddress`) are defense in depth on top of that, not
 * the thing actually holding the line — unlike `localSigner.ts`, where they
 * are the *only* thing holding the line.
 *
 * **What was and was not verified.** `PRIVY_APP_ID`/`PRIVY_APP_SECRET` were
 * not available in this environment (BACKEND_HANDOFF.md's environment
 * table lists them as unset here). `PrivyWalletApiClient` below is this
 * service's own minimal interface for the subset of Privy's wallet API a
 * session-signer send needs — modeled on
 * `@privy-io/server-auth`'s `walletApi.ethereum.sendTransaction` shape, but
 * **not exercised against the real SDK or a real Privy app**. This file is
 * built and unit-tested (`privySessionSigner.test.ts`) entirely against a
 * mocked `PrivyWalletApiClient`. Before wiring this to a live Privy app:
 * confirm the exact method name, parameter shape, and policy-id field
 * against whatever SDK version is actually installed, and confirm the
 * policy JSON's schema against Privy's current policy-authoring docs — both
 * may have changed since this was written.
 */

import type { Address, Hash, PublicClient } from "viem";
import type { SendResult } from "@volatus/service-kit";
import { ALLOWED_STREAM_METHODS, encodeApprove, encodeStreamCall, type Signer, type StreamMethod } from "./signer.js";

/**
 * The subset of Privy's wallet API this signer needs: send a transaction
 * from a wallet under session-signer control, with a policy id attached so
 * Privy's TEE enforces it before signing. See module doc for what has and
 * has not been verified about this shape.
 */
export interface PrivyWalletApiClient {
  sendTransaction(params: {
    walletId: string;
    policyId: string;
    /** CAIP-2 chain id, e.g. `"eip155:5042002"` for Arc Testnet. */
    caip2: string;
    transaction: { to: Address; data: `0x${string}`; value?: bigint };
  }): Promise<{ hash: Hash }>;
}

export interface PrivySessionSignerOptions {
  client: PrivyWalletApiClient;
  /** The user's Privy-managed wallet id — not their address; Privy resolves the address from this. */
  walletId: string;
  /** The delegator's on-chain wallet address, for `Signer.address` and logging only — never used to route the send. */
  address: Address;
  /** Must be `"sigma-hedger-v1"` (or a rotated successor) — see `policy/sigma-hedger-v1.json`. */
  policyId: string;
  /** e.g. `"eip155:5042002"` for Arc Testnet. */
  caip2: string;
  streamAddress: Address;
  usdcAddress: Address;
  /** Read-only client used only to wait for the receipt and check its status. */
  publicClient: PublicClient;
}

function describeReceiptError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function makePrivySessionSigner(opts: PrivySessionSignerOptions): Signer {
  const { client, walletId, policyId, caip2, streamAddress, usdcAddress, publicClient } = opts;

  async function sendAndWait(to: Address, data: `0x${string}`): Promise<SendResult> {
    let hash: Hash;
    try {
      const result = await client.sendTransaction({ walletId, policyId, caip2, transaction: { to, data } });
      hash = result.hash;
    } catch (err) {
      return { ok: false, reason: describeReceiptError(err) };
    }

    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") {
        return { ok: false, reason: `transaction reverted on-chain: ${hash}` };
      }
      return { ok: true, hash, receipt };
    } catch (err) {
      return { ok: false, reason: `receipt wait failed: ${describeReceiptError(err)}` };
    }
  }

  async function approveStreamSpend(amount: bigint): Promise<SendResult> {
    return sendAndWait(usdcAddress, encodeApprove(streamAddress, amount));
  }

  async function callStream(method: StreamMethod, args: readonly bigint[]): Promise<SendResult> {
    if (!ALLOWED_STREAM_METHODS.includes(method)) {
      // Belt-and-braces: the real enforcement is Privy's TEE checking `policyId`
      // against the method/target it was asked to sign, which never sees this
      // call at all if we refuse to make it. This just avoids spending a round
      // trip on a request the policy would reject anyway.
      return { ok: false, reason: `privySessionSigner: "${method}" is not an allowed SigmaStream method` };
    }
    return sendAndWait(streamAddress, encodeStreamCall(method, args));
  }

  return { address: opts.address, approveStreamSpend, callStream };
}
