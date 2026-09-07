/**
 * Sends `postCapacity` / `withdrawCapacity` on `SigmaStream`, and the
 * `approve` a `postCapacity` needs first. Pure orchestration over a `Wallet`
 * (`@volatus/service-kit`) — works identically whether that wallet is backed
 * by a local key (`makeWallet`) or a Circle developer-controlled wallet
 * (`wallet/circleAgentWallet.ts`), since both satisfy the same interface.
 *
 * This is the one module in this service that is allowed to broadcast
 * `postCapacity`/`withdrawCapacity` — `tick.ts` and the CLI's `demo-post`
 * command are the only callers, and the hard boundary in this agent's brief
 * ("never broadcast postCapacity/withdrawCapacity except in the single
 * permitted demonstration") means every other module must reach a
 * `PolicyDecision` and stop there.
 */

import type { Abi, Address, PublicClient } from "viem";
import { decodeEventLog } from "viem";
import { erc20Abi, sigmaStreamAbi } from "@volatus/onchain";
import type { SendResult, Wallet } from "@volatus/service-kit";

export interface ApproveAndPostCapacityOptions {
  wallet: Wallet;
  /** Read-only client for the allowance check — the wallet interface itself has no generic
   *  `readContract`, only `send`/`balance`/`requireBalance`. */
  client: PublicClient;
  usdcAddress: Address;
  streamAddress: Address;
  /** 6dp USDC. */
  amount: bigint;
}

export interface ApproveAndPostCapacityResult {
  ok: boolean;
  /** Present only when an approval was actually needed (allowance was already sufficient
   *  otherwise — postCapacity does not require re-approving every call). */
  approveSendResult?: SendResult;
  postSendResult?: SendResult;
  /** Decoded from the `CapacityPosted` event in `postSendResult`'s receipt, when available. */
  mintedShares?: bigint;
  reason?: string;
}

/**
 * `postCapacity` reverts on insufficient allowance (`safeTransferFrom` underflows -- BRIEF.md's
 * "the mock ERC-20s underflow on insufficient allowance rather than reverting with a message"),
 * so the allowance is checked and topped up first, and only when it is actually short: a wallet
 * that already approved a large allowance does not pay for a redundant approve every post.
 */
export async function approveAndPostCapacity(
  opts: ApproveAndPostCapacityOptions,
): Promise<ApproveAndPostCapacityResult> {
  if (opts.amount <= 0n) {
    return { ok: false, reason: `postCapacity amount must be positive, got ${opts.amount}` };
  }

  const allowance = await opts.client.readContract({
    address: opts.usdcAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: [opts.wallet.address, opts.streamAddress],
  });

  let approveSendResult: SendResult | undefined;
  if (allowance < opts.amount) {
    approveSendResult = await opts.wallet.send({
      address: opts.usdcAddress,
      abi: erc20Abi as unknown as Abi,
      functionName: "approve",
      args: [opts.streamAddress, opts.amount],
    });
    if (!approveSendResult.ok) {
      return { ok: false, approveSendResult, reason: `approve failed: ${approveSendResult.reason}` };
    }
  }

  const postSendResult = await opts.wallet.send({
    address: opts.streamAddress,
    abi: sigmaStreamAbi as unknown as Abi,
    functionName: "postCapacity",
    args: [opts.amount],
  });
  if (!postSendResult.ok) {
    return { ok: false, approveSendResult, postSendResult, reason: `postCapacity failed: ${postSendResult.reason}` };
  }

  const mintedShares = postSendResult.ok
    ? findMintedShares(postSendResult.receipt.logs, opts.streamAddress)
    : undefined;

  return { ok: true, approveSendResult, postSendResult, mintedShares };
}

export interface SendWithdrawCapacityOptions {
  wallet: Wallet;
  streamAddress: Address;
  shareAmount: bigint;
}

export async function sendWithdrawCapacity(opts: SendWithdrawCapacityOptions): Promise<SendResult> {
  if (opts.shareAmount <= 0n) {
    return { ok: false, reason: `withdrawCapacity shareAmount must be positive, got ${opts.shareAmount}` };
  }
  return opts.wallet.send({
    address: opts.streamAddress,
    abi: sigmaStreamAbi as unknown as Abi,
    functionName: "withdrawCapacity",
    args: [opts.shareAmount],
  });
}

/**
 * Decode `mintedShares` out of the `CapacityPosted` event in a `postCapacity` receipt. The
 * same receipt also carries the USDC `Transfer` log from `safeTransferFrom`, which is not in
 * `sigmaStreamAbi` and would throw if decoded against it — each log is tried independently and
 * a decode failure for an unrelated log is expected, not an error.
 */
function findMintedShares(logs: readonly { address: Address; topics: readonly `0x${string}`[]; data: `0x${string}` }[], streamAddress: Address): bigint | undefined {
  for (const log of logs) {
    if (log.address.toLowerCase() !== streamAddress.toLowerCase()) continue;
    try {
      // viem types `topics` as a tuple (`[signature, ...args]`), while a receipt hands
      // them over as a plain readonly array. The runtime shape is identical; only the
      // static type differs, so this narrows rather than converts.
      const decoded = decodeEventLog({
        abi: sigmaStreamAbi,
        data: log.data,
        topics: log.topics as unknown as [signature: `0x${string}`, ...args: `0x${string}`[]],
      });
      if (decoded.eventName === "CapacityPosted") {
        return (decoded.args as { shares: bigint }).shares;
      }
    } catch {
      // Not a CapacityPosted log (or not decodable against this ABI at all) -- expected for
      // any other event emitted in the same transaction. Keep scanning.
    }
  }
  return undefined;
}
