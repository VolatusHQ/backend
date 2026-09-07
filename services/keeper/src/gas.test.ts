import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { estimateSyncGasCostUsdc } from "./gas.js";

/**
 * `gas.ts` is the one place in this service that crosses Arc's native/ERC-20 USDC
 * seam directly: `estimateGas() * gasPrice` is an amount of native wei (18
 * decimals), and dividing by `1e12` is what turns it into the same 6dp USDC unit
 * `funded`/`capacityPool`/`ratePerSecond` are denominated in (BRIEF.md: "a wallet
 * holding 8000000000000000000 native reads 8000000 from balanceOf"). Getting the
 * exponent wrong here produces a gate that is off by a factor of 1e6 or 1e12 in
 * one direction or the other -- silently, since both a wrongly-huge and a
 * wrongly-tiny gas estimate are still "a bigint", never a thrown error.
 */

const ADDR = "0x0000000000000000000000000000000000000001" as Address;
const SUBSCRIBER = "0x7975E591c26e6c6D9B0CFd9A81f6d61A921C080c" as Address;
const KEEPER = "0x000000000000000000000000000000000000ee" as Address;

function fakeClient(gas: bigint, gasPrice: bigint) {
  return {
    estimateContractGas: vi.fn(async () => gas),
    getGasPrice: vi.fn(async () => gasPrice),
  };
}

describe("estimateSyncGasCostUsdc — the native-wei-to-6dp-USDC seam", () => {
  it("reproduces BRIEF.md's measured sync -- 68,887 gas -> ~0.00172 USDC, not a rescaled decimal", async () => {
    // BRIEF.md: "sync(...) used 68,887 gas and cost 0.00172218 USDC." Back out a
    // gas price consistent with that order of magnitude (25 gwei-shaped, Arc's
    // native unit) and check the function's own arithmetic, not the brief's
    // rounded headline figure.
    const gas = 68_887n;
    const gasPrice = 25_000_000_000n; // native wei per gas
    const client = fakeClient(gas, gasPrice);

    const costUsdc = await estimateSyncGasCostUsdc({
      client: client as never,
      address: ADDR,
      abi: [] as never,
      epochId: 2n,
      subscriber: SUBSCRIBER,
      account: KEEPER,
    });

    // gas * gasPrice = 1,722,175,000,000,000 wei; /1e12 = 1722 (6dp USDC units,
    // floored) -- ~0.001722 USDC, matching the measured cost's order of magnitude.
    expect(costUsdc).toBe((gas * gasPrice) / 10n ** 12n);
    expect(costUsdc).toBe(1_722n);

    // The two wrong exponents a "helpful" rescale would produce, named explicitly
    // so a regression here fails loudly instead of as a bare number mismatch:
    const wrongAs18dp = gas * gasPrice; // forgot to convert at all -- 1e12 too large
    const wrongAs0dp = (gas * gasPrice) / 10n ** 18n; // treated native wei as if already 6dp -- collapses to 0
    expect(costUsdc).not.toBe(wrongAs18dp);
    expect(costUsdc).not.toBe(wrongAs0dp);
    expect(wrongAs0dp).toBe(0n); // illustrates just how silent that second mistake would be
  });

  it("passes estimateGas's own account/args through so the estimate reflects this exact call", async () => {
    const client = fakeClient(50_000n, 1_000_000n);
    await estimateSyncGasCostUsdc({
      client: client as never,
      address: ADDR,
      abi: [] as never,
      epochId: 7n,
      subscriber: SUBSCRIBER,
      account: KEEPER,
    });
    expect(client.estimateContractGas).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "sync",
        args: [7n, SUBSCRIBER],
        account: KEEPER,
      }),
    );
  });

  it("floors rather than rounds, matching Solidity's own integer division", async () => {
    // gas*gasPrice = 1_999_999_999_999n wei -> /1e12 = 1 (floor of 1.999...), not 2.
    const client = fakeClient(1_999_999n, 1_000_000n);
    const costUsdc = await estimateSyncGasCostUsdc({
      client: client as never,
      address: ADDR,
      abi: [] as never,
      epochId: 1n,
      subscriber: SUBSCRIBER,
      account: KEEPER,
    });
    expect(costUsdc).toBe(1n);
  });
});
