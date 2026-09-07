/**
 * A Circle developer-controlled wallet (`CIRCLE_API_KEY` / `CIRCLE_ENTITY_SECRET`,
 * `@circle-fin/developer-controlled-wallets`), wrapped behind the exact same
 * `Wallet` interface (`@volatus/service-kit`) that `makeWallet` exposes for a
 * plain local private key. `tick.ts` and `capacity.ts` never know or care
 * which one they were handed.
 *
 * **These credentials are not provisioned in this environment.** BRIEF.md is
 * explicit: `CIRCLE_API_KEY`/`CIRCLE_ENTITY_SECRET` are not available here.
 * This module is therefore built against the real SDK's documented types and
 * unit-tested against a mock client (`circleAgentWallet.test.ts`) — it has
 * never been exercised against Circle's live API, and this service defaults
 * to `UNDERWRITER_WALLET_MODE=local` for exactly that reason (`config.ts`).
 * Do not read this module's presence as evidence the Circle path was
 * verified end to end; it was not.
 *
 * **Naming note.** `.agents/skills/use-agent-wallet/` describes a different,
 * human-in-the-loop product: the `circle` CLI's OTP-authenticated wallet,
 * meant for an interactive operator. `CIRCLE_API_KEY`/`CIRCLE_ENTITY_SECRET`
 * are instead the credentials for Circle's Developer-Controlled Wallets SDK
 * (`.agents/skills/use-developer-controlled-wallets/`) — a server-side signer
 * with no OTP step, which is what an unattended backend agent actually
 * needs. `BACKEND_HANDOFF.md`'s environment table lists exactly these two
 * variables, so that SDK is what this module is built against. This file is
 * still "the underwriter's Circle agent wallet" in the sense the brief
 * means: this service's own money, signed through Circle rather than a bare
 * key — just precise about which Circle product that is underneath.
 *
 * **Why an async factory, unlike `makeWallet`.** A local private key derives
 * its address synchronously (`privateKeyToAccount`); a Circle-custodied
 * wallet's address is a fact about a resource on Circle's servers and
 * requires an API round trip (`getWallet`) to learn. `Wallet.address` is a
 * plain, synchronous field, so that round trip has to happen before this
 * factory can return one — hence `makeCircleAgentWallet` is `async` where
 * `makeWallet` is not.
 *
 * **Why `send()` still needs a `publicClient`.** Circle's API reports a
 * transaction's hash and terminal state, not a viem `TransactionReceipt` —
 * and `SendResult`'s success case requires a real one (`wallet.ts`,
 * `@volatus/service-kit`). Once Circle reports `COMPLETE` and hands back a
 * `txHash`, that hash names a real transaction on the target chain, so its
 * receipt is fetched independently from a plain read-only client
 * (`arcClient` from `@volatus/onchain`, in production). This also means
 * `balance()`/`requireBalance()` need no Circle call at all: a
 * Circle-custodied wallet is still an ordinary on-chain address, and its
 * native balance is a plain chain read — the same one `makeWallet` uses.
 */

import { getAbiItem, type Abi, type Address, type Hash, type PublicClient } from "viem";
import type { SendArgs, SendResult, Wallet } from "@volatus/service-kit";

/**
 * The narrow slice of `@circle-fin/developer-controlled-wallets`'s
 * `CircleDeveloperControlledWalletsClient` this module actually calls,
 * declared locally rather than imported so a test mock only has to implement
 * three methods. A real client (`initiateDeveloperControlledWalletsClient(...)`)
 * satisfies this structurally — its methods accept everything here plus more
 * optional fields this module never sets.
 */
export interface CircleWalletsClient {
  getWallet(input: { id: string }): Promise<{ data?: { wallet?: { id: string; address: string } } }>;
  createContractExecutionTransaction(input: {
    walletId: string;
    contractAddress: string;
    abiFunctionSignature: string;
    abiParameters: unknown[];
    amount?: string;
    fee: { type: "level"; config: { feeLevel: "LOW" | "MEDIUM" | "HIGH" } };
  }): Promise<{ data?: { id?: string } }>;
  getTransaction(input: {
    id: string;
    waitForState?: string;
    pollingInterval?: number;
  }): Promise<{
    data?: { transaction?: { txHash?: string; state?: string; errorReason?: string; errorDetails?: string } };
  }>;
}

export interface MakeCircleAgentWalletOptions {
  /** The real Circle SDK client, or a mock satisfying `CircleWalletsClient` in tests. */
  client: CircleWalletsClient;
  /** Read-only client for the target chain (e.g. `arcClient` from `@volatus/onchain`) — used
   *  for `balance()`/`requireBalance()` and to fetch the real receipt after Circle reports a
   *  transaction complete. Never used to sign anything. */
  publicClient: PublicClient;
  /** The pre-provisioned Circle developer-controlled wallet id to sign with. Creating that
   *  wallet is a one-time bootstrap step outside this module's scope (see
   *  `.agents/skills/use-developer-controlled-wallets/`, "Create a Wallet"). */
  walletId: string;
  feeLevel?: "LOW" | "MEDIUM" | "HIGH";
}

/**
 * Derive Circle's `abiFunctionSignature` / `abiParameters` pair from a viem-style
 * `(abi, functionName, args)` call — the same shape `SendArgs` already uses, so
 * `capacity.ts` never needs to know it is talking to Circle instead of a local key.
 * BigInt args are stringified: Circle's documented "supported types include string, number,
 * and boolean" for `abiParameters` does not include BigInt.
 */
export function toCircleContractCall(
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): { abiFunctionSignature: string; abiParameters: unknown[] } {
  const item = getAbiItem({ abi, name: functionName });
  if (!item || item.type !== "function") {
    throw new Error(`circleAgentWallet: no function "${functionName}" found on the given ABI`);
  }
  const abiFunctionSignature = `${item.name}(${item.inputs.map((input) => input.type).join(",")})`;
  const abiParameters = args.map((value) => (typeof value === "bigint" ? value.toString() : value));
  return { abiFunctionSignature, abiParameters };
}

function describeCircleError(err: unknown): string {
  if (err instanceof Error) return `circle API error: ${err.message}`;
  if (err && typeof err === "object") {
    const withData = err as { response?: { data?: unknown } };
    if (withData.response?.data !== undefined) {
      return `circle API error: ${JSON.stringify(withData.response.data)}`;
    }
  }
  return `circle API error: ${String(err)}`;
}

export async function makeCircleAgentWallet(opts: MakeCircleAgentWalletOptions): Promise<Wallet> {
  const feeLevel = opts.feeLevel ?? "MEDIUM";

  const walletResp = await opts.client.getWallet({ id: opts.walletId });
  const resolvedAddress = walletResp.data?.wallet?.address;
  if (!resolvedAddress) {
    throw new Error(`circleAgentWallet: getWallet("${opts.walletId}") returned no address`);
  }
  const address = resolvedAddress as Address;

  async function send(args: SendArgs): Promise<SendResult> {
    const { abiFunctionSignature, abiParameters } = toCircleContractCall(args.abi, args.functionName, args.args ?? []);

    let txId: string;
    try {
      const created = await opts.client.createContractExecutionTransaction({
        walletId: opts.walletId,
        contractAddress: args.address,
        abiFunctionSignature,
        abiParameters,
        amount: args.value !== undefined ? args.value.toString() : undefined,
        fee: { type: "level", config: { feeLevel } },
      });
      const id = created.data?.id;
      if (!id) {
        return { ok: false, reason: "circle: createContractExecutionTransaction returned no transaction id" };
      }
      txId = id;
    } catch (err) {
      return { ok: false, reason: describeCircleError(err) };
    }

    // `waitForState: "COMPLETE"` makes the SDK itself poll until the transaction reaches (or is
    // past) COMPLETE, or reject once it lands in a terminal failure state (FAILED/DENIED/
    // CANCELLED/STUCK) -- see the SDK's `GetTransactionInput` docs. No bespoke polling loop here.
    let final: Awaited<ReturnType<CircleWalletsClient["getTransaction"]>>;
    try {
      final = await opts.client.getTransaction({ id: txId, waitForState: "COMPLETE" });
    } catch (err) {
      return { ok: false, reason: describeCircleError(err) };
    }

    const txHash = final.data?.transaction?.txHash;
    if (!txHash) {
      return { ok: false, reason: "circle: transaction reached COMPLETE with no txHash in the response" };
    }

    // See module doc: Circle's own state is not treated as the receipt. The real one is read
    // straight from the chain this hash was broadcast to.
    const receipt = await opts.publicClient.getTransactionReceipt({ hash: txHash as Hash });
    if (receipt.status === "reverted") {
      return { ok: false, reason: `transaction reverted on-chain: ${txHash}` };
    }
    return { ok: true, hash: txHash as Hash, receipt };
  }

  async function balance(): Promise<bigint> {
    return opts.publicClient.getBalance({ address });
  }

  async function requireBalance(min: bigint): Promise<void> {
    const current = await balance();
    if (current < min) {
      throw new Error(
        `circle wallet ${address} (walletId ${opts.walletId}) has balance ${current}, below required minimum ${min}`,
      );
    }
  }

  return { address, send, balance, requireBalance };
}
