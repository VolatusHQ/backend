import type { Hash } from "viem";
import { describe, expect, it, vi } from "vitest";
import { makePrivyWalletApiClient } from "./privyClient.js";

const HASH = "0x2222222222222222222222222222222222222222222222222222222222222222".slice(0, 66) as Hash;

/** The subset of the real `PrivyClient` shape this adapter calls — see privyClient.ts's header for
 *  why it is `wallets().ethereum().sendTransaction(...)`, not `wallets.create(...)` /
 *  `wallets._rpc(...)`, which belong to a different (lower-level) client this repo does not use. */
function fakePrivyClient(sendTransaction: (walletId: string, input: unknown) => Promise<{ hash: Hash }>) {
  return {
    wallets: () => ({
      ethereum: () => ({ sendTransaction }),
    }),
  } as unknown as Parameters<typeof makePrivyWalletApiClient>[0]["privy"];
}

describe("makePrivyWalletApiClient", () => {
  it("forwards to, data and caip2, and unwraps the ergonomic response's flat hash", async () => {
    let captured: unknown;
    const privy = fakePrivyClient(async (walletId, input) => {
      captured = { walletId, input };
      return { hash: HASH };
    });
    const client = makePrivyWalletApiClient({ privy });

    const result = await client.sendTransaction({
      walletId: "wallet-123",
      policyId: "sigma-hedger-v1",
      caip2: "eip155:5042002",
      transaction: { to: "0x6C35BEC76B7c43DDdbF0b46E3402D1461b4233D9", data: "0xabcdef" },
    });

    expect(result.hash).toBe(HASH);
    expect(captured).toMatchObject({
      walletId: "wallet-123",
      input: {
        caip2: "eip155:5042002",
        params: { transaction: { to: "0x6C35BEC76B7c43DDdbF0b46E3402D1461b4233D9", data: "0xabcdef" } },
      },
    });
  });

  it("omits value entirely for a zero-value call, rather than sending value: 0x0", async () => {
    let captured: unknown;
    const privy = fakePrivyClient(async (walletId, input) => {
      captured = input;
      return { hash: HASH };
    });
    const client = makePrivyWalletApiClient({ privy });

    await client.sendTransaction({
      walletId: "wallet-123",
      policyId: "sigma-hedger-v1",
      caip2: "eip155:5042002",
      transaction: { to: "0x6C35BEC76B7c43DDdbF0b46E3402D1461b4233D9", data: "0x", value: 0n },
    });

    expect(captured).toMatchObject({
      params: { transaction: { to: "0x6C35BEC76B7c43DDdbF0b46E3402D1461b4233D9", data: "0x" } },
    });
    expect((captured as { params: { transaction: object } }).params.transaction).not.toHaveProperty("value");
  });

  it("encodes a nonzero value as a 0x-prefixed hex quantity", async () => {
    let captured: unknown;
    const privy = fakePrivyClient(async (_walletId, input) => {
      captured = input;
      return { hash: HASH };
    });
    const client = makePrivyWalletApiClient({ privy });

    await client.sendTransaction({
      walletId: "wallet-123",
      policyId: "sigma-hedger-v1",
      caip2: "eip155:5042002",
      transaction: { to: "0x6C35BEC76B7c43DDdbF0b46E3402D1461b4233D9", data: "0x", value: 255n },
    });

    expect((captured as { params: { transaction: { value: string } } }).params.transaction.value).toBe("0xff");
  });
});