import { describe, expect, it } from "vitest";
import { classifyInitializeRevert, classifyOpenEpochRevert, classifyRegisterVolPoolRevert, classifySettleRevert } from "../src/outcomes.js";

describe("classifyInitializeRevert — PoolManager.initialize, one-shot per pool key", () => {
  it("PoolAlreadyInitialized -> success (a retried reseed re-attempting an already-initialized pool)", () => {
    expect(classifyInitializeRevert("PoolAlreadyInitialized")).toEqual({ kind: "success" });
  });

  it("an unrecognized/undefined revert -> retry", () => {
    expect(classifyInitializeRevert(undefined)).toEqual({ kind: "retry" });
    expect(classifyInitializeRevert("SomethingUnexpected")).toEqual({ kind: "retry" });
  });
});

describe("classifySettleRevert", () => {
  it("AlreadySettled -> success (permissionless; someone else settled it first)", () => {
    expect(classifySettleRevert("AlreadySettled")).toEqual({ kind: "success" });
  });

  it("EpochNotOver -> retry (too early, back off)", () => {
    expect(classifySettleRevert("EpochNotOver")).toEqual({ kind: "retry" });
  });

  it("NoSuchEpoch -> retry, not fatal (a lagging RPC read, epoch exists live)", () => {
    expect(classifySettleRevert("NoSuchEpoch")).toEqual({ kind: "retry" });
  });

  it("an unrecognized/undefined revert -> retry, not silently swallowed", () => {
    expect(classifySettleRevert(undefined)).toEqual({ kind: "retry" });
    expect(classifySettleRevert("SomethingUnexpected")).toEqual({ kind: "retry" });
  });
});

describe("classifyOpenEpochRevert — SigmaVault.openEpoch, distinct from SigmaStream's", () => {
  it("PoolAlreadyHasAnActiveEpoch -> success (another instance already rolled it)", () => {
    expect(classifyOpenEpochRevert("PoolAlreadyHasAnActiveEpoch")).toEqual({ kind: "success" });
  });

  it("EndBlockInPast -> retry (a race at the read, back off)", () => {
    expect(classifyOpenEpochRevert("EndBlockInPast")).toEqual({ kind: "retry" });
  });

  it("InvalidRange / ZeroHorizon / ZeroAddress -> fatal (our own computed args are wrong)", () => {
    for (const name of ["InvalidRange", "ZeroHorizon", "ZeroAddress"]) {
      const outcome = classifyOpenEpochRevert(name);
      expect(outcome.kind, name).toBe("fatal");
    }
  });
});

describe("classifyRegisterVolPoolRevert — curator-gated, but must not take down the service", () => {
  it("AlreadyRegistered -> success (one-shot, already done)", () => {
    expect(classifyRegisterVolPoolRevert("AlreadyRegistered")).toEqual({ kind: "success" });
  });

  it("NotCurator -> terminal, NOT fatal (settle/openEpoch must keep working every future epoch)", () => {
    const outcome = classifyRegisterVolPoolRevert("NotCurator");
    expect(outcome.kind).toBe("terminal");
    if (outcome.kind === "terminal") {
      expect(outcome.reason).toMatch(/curator/i);
    }
  });

  it("LegNotInPool -> fatal (a bug in how this service built the PoolKey)", () => {
    expect(classifyRegisterVolPoolRevert("LegNotInPool").kind).toBe("fatal");
  });

  it("NoActiveEpoch / NoVolPool / VolPoolNotInitialized -> retry (races with calls in the same tick)", () => {
    for (const name of ["NoActiveEpoch", "NoVolPool", "VolPoolNotInitialized"]) {
      expect(classifyRegisterVolPoolRevert(name), name).toEqual({ kind: "retry" });
    }
  });

  it("every distinct revert name maps to a distinct behavioural kind where the spec requires it", () => {
    const kinds = new Set(
      ["AlreadyRegistered", "NotCurator", "LegNotInPool", "NoActiveEpoch"].map(
        (name) => classifyRegisterVolPoolRevert(name).kind,
      ),
    );
    expect(kinds).toEqual(new Set(["success", "terminal", "fatal", "retry"]));
  });
});
