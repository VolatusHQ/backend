import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { readImpliedVol } from "./oracle.js";

function fakeClient(returnValue: readonly [boolean, bigint]): PublicClient {
  return {
    readContract: async () => returnValue,
  } as unknown as PublicClient;
}

const POOL_ID = "0xc60f25d0a8e2ec722cc0d7f2cff8179340bd5a034351319ada88292d23f21b89" as const;

describe("readImpliedVol", () => {
  it("returns ok: true with the WAD value when the oracle answers", () => {
    return readImpliedVol(fakeClient([true, 559_336_341_441_482_646n]), POOL_ID).then((result) => {
      expect(result).toEqual({ ok: true, impliedVolWad: 559_336_341_441_482_646n });
    });
  });

  it("returns ok: false, and only ok: false, when the oracle reports no feed — the caller must never substitute a guess", () => {
    return readImpliedVol(fakeClient([false, 0n]), POOL_ID).then((result) => {
      expect(result).toEqual({ ok: false });
      expect(Object.keys(result)).toEqual(["ok"]); // no stray impliedVolWad field for a caller to misread
    });
  });
});
