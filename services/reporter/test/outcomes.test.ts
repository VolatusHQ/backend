import { describe, expect, it } from "vitest";
import { classifyOpenEpochRevert, classifyReportPayoffRevert, classifySettleRevert } from "../src/outcomes.js";

describe("classifyOpenEpochRevert", () => {
  it("EpochExists -> success (already mirrored, idempotent no-op)", () => {
    expect(classifyOpenEpochRevert("EpochExists")).toEqual({ kind: "success" });
  });

  it("NotReporter -> fatal (wrong key configured; must not keep retrying)", () => {
    const outcome = classifyOpenEpochRevert("NotReporter");
    expect(outcome.kind).toBe("fatal");
  });

  it("an unrecognized/undefined revert -> retry, not silently swallowed", () => {
    expect(classifyOpenEpochRevert(undefined)).toEqual({ kind: "retry" });
    expect(classifyOpenEpochRevert("SomethingUnexpected")).toEqual({ kind: "retry" });
  });
});

describe("classifySettleRevert", () => {
  it("AlreadySettled -> success, per BACKEND_HANDOFF.md's explicit instruction", () => {
    expect(classifySettleRevert("AlreadySettled")).toEqual({ kind: "success" });
  });

  it("EpochNotOver -> retry (too early, back off)", () => {
    expect(classifySettleRevert("EpochNotOver")).toEqual({ kind: "retry" });
  });

  it("NoSuchEpoch -> retry, not fatal (an RPC lagging the log we discovered it from)", () => {
    expect(classifySettleRevert("NoSuchEpoch")).toEqual({ kind: "retry" });
  });
});

describe("classifyReportPayoffRevert — the table in BACKEND_HANDOFF.md § Service 1", () => {
  it("AlreadyReported -> success (one-shot, immutable)", () => {
    expect(classifyReportPayoffRevert("AlreadyReported")).toEqual({ kind: "success" });
  });

  it("NotReporter -> fatal (config error; alarm and stop, do not retry)", () => {
    const outcome = classifyReportPayoffRevert("NotReporter");
    expect(outcome.kind).toBe("fatal");
  });

  it("NoSuchEpoch -> retry (job 1a has not opened it yet; it will on a later tick)", () => {
    expect(classifyReportPayoffRevert("NoSuchEpoch")).toEqual({ kind: "retry" });
  });

  it("EpochNotOver -> retry (too early)", () => {
    expect(classifyReportPayoffRevert("EpochNotOver")).toEqual({ kind: "retry" });
  });

  it("ReportWindowClosed -> terminal (unrecoverable, alarm loudly, never retry)", () => {
    const outcome = classifyReportPayoffRevert("ReportWindowClosed");
    expect(outcome.kind).toBe("terminal");
    if (outcome.kind === "terminal") {
      expect(outcome.reason).toMatch(/unrecoverable|reclaimUnreported/i);
    }
  });

  it("PayoffOutOfRange -> terminal, and the reason names it as a bug in this service, not the chain", () => {
    const outcome = classifyReportPayoffRevert("PayoffOutOfRange");
    expect(outcome.kind).toBe("terminal");
    if (outcome.kind === "terminal") {
      expect(outcome.reason).toMatch(/bug/i);
    }
  });

  it("every distinct revert name maps to a distinct behavioural kind where the spec requires it", () => {
    const kinds = new Set(
      ["AlreadyReported", "NotReporter", "NoSuchEpoch", "EpochNotOver", "ReportWindowClosed", "PayoffOutOfRange"].map(
        (name) => classifyReportPayoffRevert(name).kind,
      ),
    );
    // success, fatal, retry (x2, correctly collapsed), terminal (x2, correctly collapsed) = 4 distinct kinds
    expect(kinds).toEqual(new Set(["success", "fatal", "retry", "terminal"]));
  });
});
