/**
 * A viem wallet wrapper for the two writer keys in this system (the
 * settlement reporter, the sync keeper): serialized nonces, simulate-before-
 * send, decoded custom-error reverts, and a fee-bump retry loop.
 *
 * `chain`/`rpcUrl` are passed in by the caller rather than imported from
 * `@volatus/onchain` here — this module only needs a viem `Chain` object and
 * an RPC URL string, so a service wires it up with
 * `makeWallet({ chain: unichainSepolia, privateKey, rpcUrl: config.UNICHAIN_SEPOLIA_RPC })`
 * using `unichainSepolia` from `@volatus/onchain`. Same for `abi` in `send()` —
 * it takes whatever ABI array the caller has, including the ones exported
 * from `@volatus/onchain`. See this package's README for why.
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Chain,
  type Hash,
  type TransactionReceipt,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface MakeWalletOptions {
  chain: Chain;
  privateKey: `0x${string}`;
  rpcUrl: string;
  /** Replaces the plain `http(rpcUrl)` transport, e.g. with a rotating one. */
  transport?: Transport;
  /** Multiplies viem's estimated gas and fee fields before every send. Default `1`. */
  gasMultiplier?: number;
  /** Retries with a bumped fee after a stuck/underpriced send. Default `3`. */
  maxRetries?: number;
  /** How long to wait for a receipt before the attempt counts as stuck. Default `60_000`ms. */
  receiptTimeoutMs?: number;
}

export interface SendArgs {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

export type SendResult =
  | { ok: true; hash: Hash; receipt: TransactionReceipt }
  | { ok: false; reason: string; revertName?: string };

export interface Wallet {
  address: Address;
  /** Simulate, send, and wait for the receipt. Never throws — see `SendResult`. */
  send(args: SendArgs): Promise<SendResult>;
  /** Native balance — on Arc this IS the USDC balance, an 18-decimal view of the same funds. */
  balance(): Promise<bigint>;
  /** Throws if `balance() < min`, so a service refuses to start silently broke. */
  requireBalance(min: bigint): Promise<void>;
}

const RETRYABLE_REASON_RE = /replacement transaction underpriced|receipt wait (timed out|failed)|nonce too low/i;

/** `value * multiplier`, done in integer arithmetic to avoid float rounding on wei-scale bigints. */
function scaleBigInt(value: bigint, multiplier: number): bigint {
  if (multiplier === 1) return value;
  const scaled = Math.round(multiplier * 10_000);
  return (value * BigInt(scaled)) / 10_000n;
}

function describeError(err: unknown): { reason: string; revertName?: string } {
  if (err instanceof BaseError) {
    const revertError = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revertError instanceof ContractFunctionRevertedError) {
      const name = revertError.data?.errorName;
      return {
        reason: name ? `reverted: ${name}` : revertError.shortMessage || revertError.message,
        revertName: name,
      };
    }
    return { reason: err.shortMessage || err.message };
  }
  return { reason: err instanceof Error ? err.message : String(err) };
}

export function makeWallet(opts: MakeWalletOptions): Wallet {
  const {
    chain,
    privateKey,
    rpcUrl,
    gasMultiplier = 1,
    maxRetries = 3,
    receiptTimeoutMs = 60_000,
  } = opts;

  const account = privateKeyToAccount(privateKey);
  const transport = opts.transport ?? http(rpcUrl, { timeout: 15_000, retryCount: 2 });
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  // Serialized nonce: every send is funneled through this promise chain so
  // two concurrent callers on the same wallet cannot read the same pending
  // nonce and collide. Read once from `getTransactionCount('pending')`,
  // then incremented locally — cheaper than a round trip per send, and
  // resynced from the chain after any failure since we can no longer trust
  // the local counter (the failed send may or may not have consumed a nonce).
  let nonce: number | null = null;
  let queue: Promise<void> = Promise.resolve();

  function runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function takeNonce(): Promise<number> {
    if (nonce === null) {
      nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
    }
    const current = nonce;
    nonce += 1;
    return current;
  }

  async function resyncNonce(): Promise<void> {
    nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
  }

  async function attemptOnce(args: SendArgs, feeStep: number): Promise<SendResult> {
    let simulated: Awaited<ReturnType<typeof publicClient.simulateContract>>;
    try {
      simulated = await publicClient.simulateContract({
        address: args.address,
        abi: args.abi,
        functionName: args.functionName,
        args: args.args ?? [],
        account,
        value: args.value,
      } as Parameters<typeof publicClient.simulateContract>[0]);
    } catch (err) {
      return { ok: false, ...describeError(err) };
    }

    const assignedNonce = await takeNonce();
    // `feeStep` bumps the multiplier by 20% per retry, on top of the caller's
    // own `gasMultiplier`, so a stuck send gets progressively more expensive
    // rather than resubmitting the exact same underpriced fee forever.
    const effectiveMultiplier = gasMultiplier * (1 + feeStep * 0.2);
    const request = { ...simulated.request, nonce: assignedNonce } as typeof simulated.request & {
      nonce: number;
      gas?: bigint;
      maxFeePerGas?: bigint;
      maxPriorityFeePerGas?: bigint;
      gasPrice?: bigint;
    };
    if (effectiveMultiplier !== 1) {
      if (request.gas !== undefined) request.gas = scaleBigInt(request.gas, effectiveMultiplier);
      if (request.maxFeePerGas !== undefined) {
        request.maxFeePerGas = scaleBigInt(request.maxFeePerGas, effectiveMultiplier);
      }
      if (request.maxPriorityFeePerGas !== undefined) {
        request.maxPriorityFeePerGas = scaleBigInt(request.maxPriorityFeePerGas, effectiveMultiplier);
      }
      if (request.gasPrice !== undefined) request.gasPrice = scaleBigInt(request.gasPrice, effectiveMultiplier);
    }

    let hash: Hash;
    try {
      hash = await walletClient.writeContract(
        request as unknown as Parameters<typeof walletClient.writeContract>[0],
      );
    } catch (err) {
      await resyncNonce();
      return { ok: false, ...describeError(err) };
    }

    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: receiptTimeoutMs });
      if (receipt.status === "reverted") {
        return { ok: false, reason: `transaction reverted on-chain: ${hash}` };
      }
      return { ok: true, hash, receipt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `receipt wait failed: ${message}` };
    }
  }

  async function send(args: SendArgs): Promise<SendResult> {
    return runExclusive(async () => {
      let last: SendResult = { ok: false, reason: "send() produced no attempts" };
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        last = await attemptOnce(args, attempt);
        if (last.ok) return last;
        if (attempt === maxRetries || !RETRYABLE_REASON_RE.test(last.reason)) return last;
        await resyncNonce();
      }
      return last;
    });
  }

  async function balance(): Promise<bigint> {
    return publicClient.getBalance({ address: account.address });
  }

  async function requireBalance(min: bigint): Promise<void> {
    const current = await balance();
    if (current < min) {
      throw new Error(
        `wallet ${account.address} on chain ${chain.id} has balance ${current}, below required minimum ${min}`,
      );
    }
  }

  return { address: account.address, send, balance, requireBalance };
}
