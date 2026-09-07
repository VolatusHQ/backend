import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { SendArgs, SendResult } from "@volatus/service-kit";
import { makeLocalSigner } from "./localSigner.js";

const PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
const STREAM = "0x6C35BEC76B7c43DDdbF0b46E3402D1461b4233D9" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;

function fakeWalletFactory(sendImpl: (args: SendArgs) => Promise<SendResult>) {
  return () => ({
    address: "0xfakeaddress0000000000000000000000000000" as Address,
    send: vi.fn(sendImpl),
    balance: async () => 0n,
    requireBalance: async () => {},
  });
}

describe("makeLocalSigner", () => {
  it("refuses to construct without HEDGER_ALLOW_LOCAL_SIGNER=1", () => {
    expect(() =>
      makeLocalSigner({ privateKey: PRIVATE_KEY, rpcUrl: "http://localhost", allowFlag: undefined }),
    ).toThrow(/refusing to run/);
    expect(() =>
      makeLocalSigner({ privateKey: PRIVATE_KEY, rpcUrl: "http://localhost", allowFlag: "0" }),
    ).toThrow(/refusing to run/);
    expect(() =>
      makeLocalSigner({ privateKey: PRIVATE_KEY, rpcUrl: "http://localhost", allowFlag: "true" }),
    ).toThrow(/refusing to run/);
  });

  it("constructs when the flag is exactly '1'", () => {
    const factory = fakeWalletFactory(async () => ({ ok: true, hash: "0xhash" as `0x${string}`, receipt: {} as never }));
    const signer = makeLocalSigner({
      privateKey: PRIVATE_KEY,
      rpcUrl: "http://localhost",
      allowFlag: "1",
      walletFactory: factory as never,
    });
    expect(signer.address).toBe("0xfakeaddress0000000000000000000000000000");
  });

  it("approveStreamSpend always targets usdcAddress with spender pinned to streamAddress", async () => {
    let captured: SendArgs | undefined;
    const factory = fakeWalletFactory(async (args) => {
      captured = args;
      return { ok: true, hash: "0xhash" as `0x${string}`, receipt: {} as never };
    });
    const signer = makeLocalSigner({
      privateKey: PRIVATE_KEY,
      rpcUrl: "http://localhost",
      allowFlag: "1",
      streamAddress: STREAM,
      usdcAddress: USDC,
      walletFactory: factory as never,
    });

    await signer.approveStreamSpend(1_000_000n);
    expect(captured?.address).toBe(USDC);
    expect(captured?.functionName).toBe("approve");
    expect(captured?.args).toEqual([STREAM, 1_000_000n]);
  });

  it("callStream sends to streamAddress for an allowed method", async () => {
    let captured: SendArgs | undefined;
    const factory = fakeWalletFactory(async (args) => {
      captured = args;
      return { ok: true, hash: "0xhash" as `0x${string}`, receipt: {} as never };
    });
    const signer = makeLocalSigner({
      privateKey: PRIVATE_KEY,
      rpcUrl: "http://localhost",
      allowFlag: "1",
      streamAddress: STREAM,
      walletFactory: factory as never,
    });

    await signer.callStream("adjust", [2n, 55n, 4_000_000n]);
    expect(captured?.address).toBe(STREAM);
    expect(captured?.functionName).toBe("adjust");
    expect(captured?.args).toEqual([2n, 55n, 4_000_000n]);
  });

  it("callStream rejects a disallowed method without ever calling wallet.send", async () => {
    const send = vi.fn(async () => ({ ok: true, hash: "0xhash" as `0x${string}`, receipt: {} as never }));
    const factory = () => ({
      address: "0xfakeaddress0000000000000000000000000000" as Address,
      send,
      balance: async () => 0n,
      requireBalance: async () => {},
    });
    const signer = makeLocalSigner({
      privateKey: PRIVATE_KEY,
      rpcUrl: "http://localhost",
      allowFlag: "1",
      walletFactory: factory as never,
    });

    const result = await signer.callStream("transfer" as never, [1n]);
    expect(result.ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
