import { describe, expect, it } from "vitest";
import { decodePositionInfo, poolId } from "./v4.js";

describe("poolId", () => {
  it("reproduces MEASURED_POOL_ID from MEASURED_POOL_KEY (cross-checked against BACKEND_HANDOFF.md's ground truth)", () => {
    const key = {
      currency0: "0xd00FaDdE160cecbB3ad946BE3542b9553c5B582B" as const, // mUSDC — sorts below mWETH
      currency1: "0xde45563c9c596fC761e3a18ABB66aE51904de0F4" as const, // mWETH
      fee: 3000,
      tickSpacing: 60,
      hooks: "0x9215C247Ec3C0082A4bfC26515427c2737D1d040" as const,
    };
    expect(poolId(key)).toBe("0xc60f25d0a8e2ec722cc0d7f2cff8179340bd5a034351319ada88292d23f21b89");
  });
});

describe("decodePositionInfo", () => {
  it("sign-extends a negative tickLower instead of returning it as ~16.7 million", () => {
    // tickLower = -120, tickUpper = 120, packed at bit offsets 8 and 32.
    const tickLowerRaw = BigInt.asUintN(24, -120n);
    const tickUpperRaw = BigInt.asUintN(24, 120n);
    const info = (tickUpperRaw << 32n) | (tickLowerRaw << 8n);
    expect(decodePositionInfo(info)).toEqual({ tickLower: -120, tickUpper: 120 });
  });

  it("round-trips a wide, all-positive range", () => {
    const tickLowerRaw = BigInt.asUintN(24, 0n);
    const tickUpperRaw = BigInt.asUintN(24, 887_220n);
    const info = (tickUpperRaw << 32n) | (tickLowerRaw << 8n);
    expect(decodePositionInfo(info)).toEqual({ tickLower: 0, tickUpper: 887_220 });
  });
});
