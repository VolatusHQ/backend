import { describe, expect, it } from "vitest";
import { classifyAdjustRevert, classifyFundRevert } from "./outcomes.js";

describe("classifyAdjustRevert", () => {
  it("ZeroRate is fatal — clampRate should have prevented this", () => {
    expect(classifyAdjustRevert("ZeroRate").kind).toBe("fatal");
  });
  it("InsufficientCapacity is retryable", () => {
    expect(classifyAdjustRevert("InsufficientCapacity").kind).toBe("retry");
  });
  it("NoSubscription is terminal", () => {
    expect(classifyAdjustRevert("NoSubscription").kind).toBe("terminal");
  });
  it("NoSuchEpoch is retryable", () => {
    expect(classifyAdjustRevert("NoSuchEpoch").kind).toBe("retry");
  });
  it("an unknown revert name defaults to retry, never fatal", () => {
    expect(classifyAdjustRevert(undefined).kind).toBe("retry");
    expect(classifyAdjustRevert("SomethingNew").kind).toBe("retry");
  });
});

describe("classifyFundRevert", () => {
  it("NoSubscription is terminal", () => {
    expect(classifyFundRevert("NoSubscription").kind).toBe("terminal");
  });
  it("NoSuchEpoch and unknown reverts are retryable", () => {
    expect(classifyFundRevert("NoSuchEpoch").kind).toBe("retry");
    expect(classifyFundRevert(undefined).kind).toBe("retry");
  });
});
