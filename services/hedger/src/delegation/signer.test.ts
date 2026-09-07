import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { erc20Abi, sigmaStreamAbi } from "@volatus/onchain";
import { ALLOWED_STREAM_METHODS, encodeApprove, encodeStreamCall } from "./signer.js";

const STREAM = "0x6C35BEC76B7c43DDdbF0b46E3402D1461b4233D9" as const;

describe("encodeStreamCall", () => {
  it("only allows subscribe, fund, adjust", () => {
    expect(ALLOWED_STREAM_METHODS).toEqual(["subscribe", "fund", "adjust"]);
  });

  it("rejects any method outside the allowlist, e.g. an attempted ERC-20 transfer smuggled through as a 'method'", () => {
    // @ts-expect-error -- deliberately passing a disallowed method to prove the runtime guard, not just the type
    expect(() => encodeStreamCall("transfer", [1n, 2n])).toThrow(/not an allowed SigmaStream method/);
  });

  it("encodes adjust with the real ABI's selector 0x6f871cec (confirmed via `cast sig`, matches BRIEF.md)", () => {
    const data = encodeStreamCall("adjust", [2n, 55n, 4_000_000n]);
    expect(data.slice(0, 10)).toBe("0x6f871cec");
  });

  it("adjust args decode in order (epochId, newRatePerSecond, newCoverageNotional) — never rescaled between 6dp and WAD", () => {
    const epochId = 2n;
    const ratePerSecond = 55n; // 6dp USDC/sec — NOT a WAD value
    const coverageNotional = 4_000_000n; // 6dp USDC — NOT a WAD value
    const data = encodeStreamCall("adjust", [epochId, ratePerSecond, coverageNotional]);

    const decoded = decodeFunctionData({ abi: sigmaStreamAbi, data });
    expect(decoded.functionName).toBe("adjust");
    expect(decoded.args).toEqual([epochId, ratePerSecond, coverageNotional]);
    // Neither value crossed the 1e12 gap between 6dp and WAD (1e18/1e6).
    expect(decoded.args[1]).toBeLessThan(10n ** 6n);
    expect(decoded.args[2]).toBeLessThan(10n ** 12n);
  });

  it("encodes fund(epochId, amount) with the real selector 0xa65e2cfd", () => {
    const data = encodeStreamCall("fund", [2n, 1_000_000n]);
    expect(data.slice(0, 10)).toBe("0xa65e2cfd");
    const decoded = decodeFunctionData({ abi: sigmaStreamAbi, data });
    expect(decoded.args).toEqual([2n, 1_000_000n]);
  });

  it("encodes subscribe(epochId, rate, notional) with the real selector 0x6c9eb774", () => {
    const data = encodeStreamCall("subscribe", [2n, 100n, 4_000_000n]);
    expect(data.slice(0, 10)).toBe("0x6c9eb774");
  });

  it("rejects the wrong argument arity for a method, even if the method itself is allowed", () => {
    expect(() => encodeStreamCall("adjust", [2n, 55n])).toThrow(/takes 3 args, got 2/);
    expect(() => encodeStreamCall("fund", [2n, 1n, 3n])).toThrow(/takes 2 args, got 3/);
  });
});

describe("encodeApprove", () => {
  it("encodes approve(spender, amount) with the real selector 0x095ea7b3, spender pinned to the caller's streamAddress", () => {
    const data = encodeApprove(STREAM, 5_000_000n);
    expect(data.slice(0, 10)).toBe("0x095ea7b3");
    const decoded = decodeFunctionData({ abi: erc20Abi, data });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args).toEqual([STREAM, 5_000_000n]);
  });
});
