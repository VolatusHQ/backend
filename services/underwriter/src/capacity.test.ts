import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAbiItem, type Address } from "viem";
import { sigmaStreamAbi } from "@volatus/onchain";
import type { SendResult, Wallet } from "@volatus/service-kit";
import { approveAndPostCapacity, sendWithdrawCapacity } from "./capacity.js";

const USDC = "0x3600000000000000000000000000000000000000" as Address;
const STREAM = "0x6C35BEC76B7c43DDdbF0b46E3402D1461b4233D9" as Address;
const UNDERWRITER = "0x7975E591c26e6c6D9B0CFd9A81f6d61A921C080c" as Address;

function fakeReceipt(logs: unknown[]) {
  return { status: "success", logs, transactionHash: "0xdeadbeef" } as never;
}

function fakeWallet(sendImpl: (args: { functionName: string }) => Promise<SendResult>): Wallet {
  return {
    address: UNDERWRITER,
    send: vi.fn(sendImpl),
    balance: vi.fn(async () => 10_000_000_000_000_000_000n),
    requireBalance: vi.fn(async () => {}),
  };
}

function fakeClient(allowance: bigint) {
  return {
    readContract: vi.fn(async () => allowance),
  } as never;
}

describe("approveAndPostCapacity", () => {
  it("skips approve when the existing allowance already covers the amount", async () => {
    const wallet = fakeWallet(async ({ functionName }) => {
      expect(functionName).toBe("postCapacity");
      return { ok: true, hash: "0x01", receipt: fakeReceipt([]) };
    });
    const result = await approveAndPostCapacity({
      wallet,
      client: fakeClient(10_000_000n),
      usdcAddress: USDC,
      streamAddress: STREAM,
      amount: 1_000_000n,
    });
    expect(result.ok).toBe(true);
    expect(result.approveSendResult).toBeUndefined();
    expect(wallet.send).toHaveBeenCalledTimes(1);
  });

  it("approves first when the allowance is short, then posts", async () => {
    const calls: string[] = [];
    const wallet = fakeWallet(async ({ functionName }) => {
      calls.push(functionName);
      return { ok: true, hash: `0x0${calls.length}`, receipt: fakeReceipt([]) };
    });
    const result = await approveAndPostCapacity({
      wallet,
      client: fakeClient(0n),
      usdcAddress: USDC,
      streamAddress: STREAM,
      amount: 1_000_000n,
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["approve", "postCapacity"]);
    expect(result.approveSendResult?.ok).toBe(true);
  });

  it("stops and reports failure if the approve itself reverts, never attempting postCapacity", async () => {
    const wallet = fakeWallet(async ({ functionName }) => {
      if (functionName === "approve") return { ok: false, reason: "reverted: mock failure" };
      throw new Error("postCapacity should never be called after a failed approve");
    });
    const result = await approveAndPostCapacity({
      wallet,
      client: fakeClient(0n),
      usdcAddress: USDC,
      streamAddress: STREAM,
      amount: 1_000_000n,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/approve failed/);
  });

  it("reports failure when postCapacity itself reverts", async () => {
    const wallet = fakeWallet(async ({ functionName }) =>
      functionName === "postCapacity" ? { ok: false, reason: "reverted: NothingPosted" } : { ok: true, hash: "0x01", receipt: fakeReceipt([]) },
    );
    const result = await approveAndPostCapacity({
      wallet,
      client: fakeClient(10_000_000n),
      usdcAddress: USDC,
      streamAddress: STREAM,
      amount: 1_000_000n,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/postCapacity failed/);
  });

  it("refuses a non-positive amount before ever touching the wallet", async () => {
    const wallet = fakeWallet(async () => {
      throw new Error("must not be called");
    });
    const result = await approveAndPostCapacity({
      wallet,
      client: fakeClient(0n),
      usdcAddress: USDC,
      streamAddress: STREAM,
      amount: 0n,
    });
    expect(result.ok).toBe(false);
    expect(wallet.send).not.toHaveBeenCalled();
  });

  it("decodes mintedShares from the CapacityPosted event in the receipt, ignoring unrelated logs", async () => {
    const capacityPostedEvent = getAbiItem({ abi: sigmaStreamAbi, name: "CapacityPosted" });
    // Built from topics + data rather than viem's `encodeEventLog`, which this
    // version of viem does not export. Same bytes either way: the indexed
    // `underwriter` goes in the topics, the two unindexed uints in the data.
    const encoded = {
      topics: encodeEventTopics({
        abi: [capacityPostedEvent],
        eventName: "CapacityPosted",
        args: { underwriter: UNDERWRITER },
      }),
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }],
        [1_000_000n, 848_527n],
      ),
    };
    const unrelatedLog = { address: USDC, topics: encoded.topics as never, data: encoded.data }; // wrong address -- must be skipped
    const relatedLog = { address: STREAM, topics: encoded.topics, data: encoded.data };

    const wallet = fakeWallet(async ({ functionName }) =>
      functionName === "postCapacity"
        ? { ok: true, hash: "0x01", receipt: fakeReceipt([unrelatedLog, relatedLog]) }
        : { ok: true, hash: "0x00", receipt: fakeReceipt([]) },
    );
    const result = await approveAndPostCapacity({
      wallet,
      client: fakeClient(10_000_000n),
      usdcAddress: USDC,
      streamAddress: STREAM,
      amount: 1_000_000n,
    });
    expect(result.ok).toBe(true);
    expect(result.mintedShares).toBe(848_527n);
  });
});

describe("sendWithdrawCapacity", () => {
  it("sends withdrawCapacity with the given share amount", async () => {
    const wallet = fakeWallet(async ({ functionName }) => {
      expect(functionName).toBe("withdrawCapacity");
      return { ok: true, hash: "0x01", receipt: fakeReceipt([]) };
    });
    const result = await sendWithdrawCapacity({ wallet, streamAddress: STREAM, shareAmount: 500_000n });
    expect(result.ok).toBe(true);
  });

  it("refuses a non-positive shareAmount before touching the wallet", async () => {
    const wallet = fakeWallet(async () => {
      throw new Error("must not be called");
    });
    const result = await sendWithdrawCapacity({ wallet, streamAddress: STREAM, shareAmount: 0n });
    expect(result.ok).toBe(false);
    expect(wallet.send).not.toHaveBeenCalled();
  });
});
