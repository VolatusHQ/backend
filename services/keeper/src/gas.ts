/**
 * A live estimate of what one `sync` call would cost, in 6dp USDC.
 *
 * `gate.ts` needs this *before* deciding whether to send anything, so it
 * cannot come from `wallet.send()` (which only estimates internally, right
 * before broadcasting a call it has already decided to make). A hardcoded
 * constant was also rejected on purpose — BRIEF.md's 68,887 gas / 0.00172218
 * USDC figure is one measurement on one day; fee markets move, and a stale
 * constant would eventually gate on a number the chain no longer agrees with.
 *
 * On Arc, gas is paid in USDC and the native balance is an 18-decimal view
 * of the same 6-decimal ERC-20 funds (BRIEF.md, `@volatus/onchain`'s
 * `chains.ts`) — verified: 8000000000000000000 native == 8000000 from
 * `balanceOf`. So `nativeWei / 1e12` is a 6dp USDC amount, not a unit
 * conversion this package invents.
 */

import type { Address, PublicClient } from "viem";
import type { sigmaStreamAbi } from "@volatus/onchain";

const NATIVE_WEI_PER_USDC_UNIT = 10n ** 12n;

export interface EstimateSyncGasCostOptions {
  client: PublicClient;
  address: Address;
  abi: typeof sigmaStreamAbi;
  epochId: bigint;
  subscriber: Address;
  /** The keeper's own address — `sync` is permissionless, but `estimateGas` still wants a `from`. */
  account: Address;
}

/** Estimated cost of `sync(epochId, subscriber)`, in 6dp USDC, from a live `estimateGas` × current fee. */
export async function estimateSyncGasCostUsdc(opts: EstimateSyncGasCostOptions): Promise<bigint> {
  const [gas, gasPrice] = await Promise.all([
    opts.client.estimateContractGas({
      address: opts.address,
      abi: opts.abi,
      functionName: "sync",
      args: [opts.epochId, opts.subscriber],
      account: opts.account,
    } as Parameters<typeof opts.client.estimateContractGas>[0]),
    opts.client.getGasPrice(),
  ]);

  return (gas * gasPrice) / NATIVE_WEI_PER_USDC_UNIT;
}
