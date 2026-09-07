import { describe, expect, it } from "vitest";
import { classifyPhase } from "../src/status.js";

const vault = (settled: boolean) => ({ endBlock: 100n, settled, payoffWad: 0n });

describe("classifyPhase", () => {
  it("not-mirrored when Arc has no record of the epoch", () => {
    expect(classifyPhase(vault(false), null, 0n)).toBe("not-mirrored");
  });

  it("awaiting-endBlock when mirrored but not yet settled on Unichain", () => {
    const arc = { coverageEnd: 200n, reportDeadline: 300n, reported: false, payoffWad: 0n };
    expect(classifyPhase(vault(false), arc, 150n)).toBe("awaiting-endBlock");
  });

  it("settled-awaiting-report once settled on Unichain but not yet reported on Arc", () => {
    const arc = { coverageEnd: 200n, reportDeadline: 300n, reported: false, payoffWad: 0n };
    expect(classifyPhase(vault(true), arc, 250n)).toBe("settled-awaiting-report");
  });

  it("reported once reportPayoff has landed, regardless of the deadline", () => {
    const arc = { coverageEnd: 200n, reportDeadline: 300n, reported: true, payoffWad: 500n };
    expect(classifyPhase(vault(true), arc, 999n)).toBe("reported");
  });

  it("report-window-closed-unreported once now passes reportDeadline while still unreported", () => {
    const arc = { coverageEnd: 200n, reportDeadline: 300n, reported: false, payoffWad: 0n };
    expect(classifyPhase(vault(true), arc, 301n)).toBe("report-window-closed-unreported");
  });
});
