import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { sigmaStreamAbi } from "@volatus/onchain";
import { makeCircleAgentWallet, toCircleContractCall, type CircleWalletsClient } from "./circleAgentWallet.js";

const WALLET_ID = "wallet-123";
const WALLET_ADDRESS = "0x00000000000000000000000000000000c1rc1e" as Address;
const STREAM = "0x6C35BEC76B7c43DDdbF0b46E3402D1461b4233D9" as Address;

function fakePublicClient(opts: { balance?: bigint; receiptStatus?: "success" | "reverted" }) {
  return {
    getBalance: vi.fn(async () => opts.balance ?? 5_000_000_000_000_000_000n),
    getTransactionReceipt: vi.fn(async () => ({ status: opts.receiptStatus ?? "success", transactionHash: "0xabc" })),
  } as never;
}

function fakeCircleClient(overrides: Partial<CircleWalletsClient> = {}): CircleWalletsClient {
  return {
    getWallet: vi.fn(async () => ({ data: { wallet: { id: WALLET_ID, address: WALLET_ADDRESS } } })),
    createContractExecutionTransaction: vi.fn(async () => ({ data: { id: "tx-1" } })),
    getTransaction: vi.fn(async () => ({ data: { transaction: { txHash: "0xdeadbeef", state: "COMPLETE" } } })),
    ...overrides,
  };
}

describe("toCircleContractCall", () => {
  it("derives the abi function signature and stringifies bigint args", () => {
    const { abiFunctionSignature, abiParameters } = toCircleContractCall(sigmaStreamAbi, "postCapacity", [1_000_000n]);
    expect(abiFunctionSignature).toBe("postCapacity(uint256)");
    expect(abiParameters).toEqual(["1000000"]);
  });

  it("handles multi-argument functions in declaration order", () => {
    const { abiFunctionSignature, abiParameters } = toCircleContractCall(sigmaStreamAbi, "subscribe", [
      2n,
      100n,
      4_000_000n,
    ]);
    expect(abiFunctionSignature).toBe("subscribe(uint256,uint256,uint256)");
    expect(abiParameters).toEqual(["2", "100", "4000000"]);
  });

  it("throws for a function name absent from the given ABI", () => {
    expect(() => toCircleContractCall(sigmaStreamAbi, "notAFunction", [])).toThrow(/no function/);
  });
});

describe("makeCircleAgentWallet", () => {
  it("resolves address via getWallet before returning, exposing it synchronously afterward", async () => {
    const wallet = await makeCircleAgentWallet({
      client: fakeCircleClient(),
      publicClient: fakePublicClient({}),
      walletId: WALLET_ID,
    });
    expect(wallet.address).toBe(WALLET_ADDRESS);
  });

  it("throws at construction if Circle's getWallet returns no address", async () => {
    await expect(
      makeCircleAgentWallet({
        client: fakeCircleClient({ getWallet: vi.fn(async () => ({ data: {} })) }),
        publicClient: fakePublicClient({}),
        walletId: WALLET_ID,
      }),
    ).rejects.toThrow(/returned no address/);
  });

  it("send(): happy path -- creates the tx, waits for COMPLETE, and confirms the real receipt independently", async () => {
    const circle = fakeCircleClient();
    const publicClient = fakePublicClient({ receiptStatus: "success" });
    const wallet = await makeCircleAgentWallet({ client: circle, publicClient, walletId: WALLET_ID });

    const result = await wallet.send({
      address: STREAM,
      abi: sigmaStreamAbi,
      functionName: "postCapacity",
      args: [1_000_000n],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hash).toBe("0xdeadbeef");
    }
    expect(circle.createContractExecutionTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: WALLET_ID,
        contractAddress: STREAM,
        abiFunctionSignature: "postCapacity(uint256)",
        abiParameters: ["1000000"],
      }),
    );
    expect(circle.getTransaction).toHaveBeenCalledWith(expect.objectContaining({ id: "tx-1", waitForState: "COMPLETE" }));
  });

  it("send(): reports failure when the receipt independently confirms a revert, even though Circle said COMPLETE", async () => {
    const wallet = await makeCircleAgentWallet({
      client: fakeCircleClient(),
      publicClient: fakePublicClient({ receiptStatus: "reverted" }),
      walletId: WALLET_ID,
    });
    const result = await wallet.send({ address: STREAM, abi: sigmaStreamAbi, functionName: "postCapacity", args: [1n] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/reverted on-chain/);
  });

  it("send(): reports failure when createContractExecutionTransaction throws", async () => {
    const circle = fakeCircleClient({
      createContractExecutionTransaction: vi.fn(async () => {
        throw new Error("insufficient funds");
      }),
    });
    const wallet = await makeCircleAgentWallet({ client: circle, publicClient: fakePublicClient({}), walletId: WALLET_ID });
    const result = await wallet.send({ address: STREAM, abi: sigmaStreamAbi, functionName: "postCapacity", args: [1n] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/insufficient funds/);
  });

  it("send(): reports failure when getTransaction rejects (a terminal FAILED/DENIED/CANCELLED/STUCK state)", async () => {
    const circle = fakeCircleClient({
      getTransaction: vi.fn(async () => {
        throw new Error("transaction FAILED: reverted on chain");
      }),
    });
    const wallet = await makeCircleAgentWallet({ client: circle, publicClient: fakePublicClient({}), walletId: WALLET_ID });
    const result = await wallet.send({ address: STREAM, abi: sigmaStreamAbi, functionName: "postCapacity", args: [1n] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/transaction FAILED/);
  });

  it("send(): reports failure when Circle returns no transaction id at all", async () => {
    const circle = fakeCircleClient({ createContractExecutionTransaction: vi.fn(async () => ({ data: {} })) });
    const wallet = await makeCircleAgentWallet({ client: circle, publicClient: fakePublicClient({}), walletId: WALLET_ID });
    const result = await wallet.send({ address: STREAM, abi: sigmaStreamAbi, functionName: "postCapacity", args: [1n] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no transaction id/);
  });

  it("send(): reports failure when the completed transaction carries no txHash", async () => {
    const circle = fakeCircleClient({
      getTransaction: vi.fn(async () => ({ data: { transaction: { state: "COMPLETE" } } })),
    });
    const wallet = await makeCircleAgentWallet({ client: circle, publicClient: fakePublicClient({}), walletId: WALLET_ID });
    const result = await wallet.send({ address: STREAM, abi: sigmaStreamAbi, functionName: "postCapacity", args: [1n] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no txHash/);
  });

  it("balance() reads the chain directly and never calls Circle", async () => {
    const circle = fakeCircleClient();
    const publicClient = fakePublicClient({ balance: 7_000_000_000_000_000_000n });
    const wallet = await makeCircleAgentWallet({ client: circle, publicClient, walletId: WALLET_ID });
    const balance = await wallet.balance();
    expect(balance).toBe(7_000_000_000_000_000_000n);
  });

  it("requireBalance() throws below the minimum and resolves above it", async () => {
    const wallet = await makeCircleAgentWallet({
      client: fakeCircleClient(),
      publicClient: fakePublicClient({ balance: 1_000n }),
      walletId: WALLET_ID,
    });
    await expect(wallet.requireBalance(2_000n)).rejects.toThrow(/below required minimum/);
    await expect(wallet.requireBalance(500n)).resolves.toBeUndefined();
  });
});
