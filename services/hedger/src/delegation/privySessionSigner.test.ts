import { decodeFunctionData } from "viem";
import type { Address, Hash, PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { erc20Abi, sigmaStreamAbi } from "@volatus/onchain";
import { makePrivySessionSigner, type PrivyWalletApiClient } from "./privySessionSigner.js";

const STREAM = "0x6C35BEC76B7c43DDdbF0b46E3402D1461b4233D9" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const USER_ADDRESS = "0x7975E591c26e6c6D9B0CFd9A81f6d61A921C080c" as Address;
const HASH = "0x1111111111111111111111111111111111111111111111111111111111111111".slice(0, 66) as Hash;

function fakePublicClient(status: "success" | "reverted" = "success"): PublicClient {
  return {
    waitForTransactionReceipt: async () => ({ status }),
  } as unknown as PublicClient;
}

function buildSigner(client: PrivyWalletApiClient, publicClient: PublicClient = fakePublicClient()) {
  return makePrivySessionSigner({
    client,
    walletId: "wallet-123",
    address: USER_ADDRESS,
    policyId: "sigma-hedger-v1",
    caip2: "eip155:5042002",
    streamAddress: STREAM,
    usdcAddress: USDC,
    publicClient,
  });
}

describe("makePrivySessionSigner", () => {
  it("approveStreamSpend always sends to usdcAddress with spender pinned to streamAddress, under the pinned policyId", async () => {
    let captured: Parameters<PrivyWalletApiClient["sendTransaction"]>[0] | undefined;
    const client: PrivyWalletApiClient = {
      sendTransaction: vi.fn(async (params) => {
        captured = params;
        return { hash: HASH };
      }),
    };
    const signer = buildSigner(client);

    const result = await signer.approveStreamSpend(5_000_000n);
    expect(result.ok).toBe(true);
    expect(captured?.policyId).toBe("sigma-hedger-v1");
    expect(captured?.transaction.to).toBe(USDC);

    const decoded = decodeFunctionData({ abi: erc20Abi, data: captured!.transaction.data });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args).toEqual([STREAM, 5_000_000n]);
  });

  it("callStream sends adjust(epochId, rate, notional) to streamAddress, in that argument order", async () => {
    let captured: Parameters<PrivyWalletApiClient["sendTransaction"]>[0] | undefined;
    const client: PrivyWalletApiClient = {
      sendTransaction: vi.fn(async (params) => {
        captured = params;
        return { hash: HASH };
      }),
    };
    const signer = buildSigner(client);

    await signer.callStream("adjust", [2n, 55n, 4_000_000n]);
    expect(captured?.transaction.to).toBe(STREAM);

    const decoded = decodeFunctionData({ abi: sigmaStreamAbi, data: captured!.transaction.data });
    expect(decoded.functionName).toBe("adjust");
    expect(decoded.args).toEqual([2n, 55n, 4_000_000n]);
  });

  it("rejects a call to a disallowed method without ever invoking the Privy client — the TEE policy is the real gate but this never even asks it", async () => {
    const sendTransaction = vi.fn(async () => ({ hash: HASH }));
    const signer = buildSigner({ sendTransaction });

    const result = await signer.callStream("transfer" as never, [1n]);
    expect(result.ok).toBe(false);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("there is no parameter anywhere in Signer or PrivyWalletApiClient that lets a caller choose the transaction target", async () => {
    // Structural check, not a runtime one: callStream/approveStreamSpend take
    // only (method, args) / (amount) — no `to`/`target`/`spender` parameter
    // exists for a compromised caller to smuggle a different address through.
    const client: PrivyWalletApiClient = { sendTransaction: vi.fn(async () => ({ hash: HASH })) };
    const signer = buildSigner(client);
    expect(signer.approveStreamSpend.length).toBe(1);
    expect(signer.callStream.length).toBe(2);
  });

  it("a reverted receipt is reported as ok: false", async () => {
    const client: PrivyWalletApiClient = { sendTransaction: vi.fn(async () => ({ hash: HASH })) };
    const signer = buildSigner(client, fakePublicClient("reverted"));

    const result = await signer.callStream("fund", [2n, 1_000_000n]);
    expect(result.ok).toBe(false);
  });

  it("a successful send returns the hash the mocked Privy client produced", async () => {
    const client: PrivyWalletApiClient = { sendTransaction: vi.fn(async () => ({ hash: HASH })) };
    const signer = buildSigner(client);

    const result = await signer.callStream("fund", [2n, 1_000_000n]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hash).toBe(HASH);
  });
});
