import { describe, expect, it, vi } from "vitest";
import { WAD } from "@volatus/onchain";
import { buildReportPayoffArgs, reportEpoch } from "../src/report.js";
import { openJournal, type Journal } from "@volatus/service-kit";
import type { PublicClient } from "viem";
import type { Wallet } from "@volatus/service-kit";

describe("buildReportPayoffArgs — payoffWad must cross Unichain -> Arc UNCHANGED", () => {
  it("passes a mid-range WAD ratio through byte-for-byte", () => {
    // 922.93% implied vol scale, expressed as a payoff ratio for illustration.
    const vaultPayoffWad = 923_000_000_000_000_000n;
    const { payoffWad } = buildReportPayoffArgs(2n, vaultPayoffWad);
    expect(payoffWad).toBe(vaultPayoffWad);
  });

  it("passes 0 and exactly WAD (the boundaries of the valid range) through unchanged", () => {
    expect(buildReportPayoffArgs(1n, 0n).payoffWad).toBe(0n);
    expect(buildReportPayoffArgs(1n, WAD).payoffWad).toBe(WAD);
  });

  it("this test would fail if someone 'helpfully' rescaled payoffWad from WAD to 6dp USDC", () => {
    const vaultPayoffWad = 500_000_000_000_000_000n; // 0.5 in WAD terms
    const { payoffWad } = buildReportPayoffArgs(2n, vaultPayoffWad);
    // A WAD->6dp rescale (dividing by 1e12) would produce 500_000n here.
    // The correct, unscaled value must not collapse to that.
    const wronglyRescaled = vaultPayoffWad / 10n ** 12n;
    expect(payoffWad).not.toBe(wronglyRescaled);
    expect(payoffWad).toBe(vaultPayoffWad);
  });

  it("rejects a payoffWad outside [0, WAD] locally rather than ever sending it", () => {
    expect(() => buildReportPayoffArgs(1n, WAD + 1n)).toThrow(/outside/);
    expect(() => buildReportPayoffArgs(1n, -1n)).toThrow(/outside/);
  });
});

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fakeLogger() } as never;
}

describe("reportEpoch wiring", () => {
  it("sends the vault's payoffWad through to reportPayoff() unchanged, never rescaled", async () => {
    const vaultPayoffWad = 923_456_789_012_345_678n;
    const sendCalls: unknown[] = [];

    const arcClient = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "epoch") return { coverageEnd: 1_789_153_388n, reportDeadline: 1_789_239_788n, reported: false, payoffWad: 0n, coverageStart: 0n, totalCoverageSold: 0n };
        throw new Error(`unexpected read ${functionName}`);
      }),
    } as unknown as PublicClient;

    const arcWallet = {
      address: "0xFf54812Fc9EC92E51a22f67a92Cd2c09a049E30c",
      send: vi.fn(async (args: unknown) => {
        sendCalls.push(args);
        return { ok: true, hash: "0xabc", receipt: {} };
      }),
      balance: vi.fn(),
      requireBalance: vi.fn(),
    } as unknown as Wallet;

    const journal = {
      claim: vi.fn(() => "fresh"),
      recordSent: vi.fn(),
      recordDone: vi.fn(),
      recordFailed: vi.fn(),
      get: vi.fn(() => null),
      list: vi.fn(() => []),
      getCursor: vi.fn(() => null),
      setCursor: vi.fn(),
      upsertSubscription: vi.fn(),
      listSubscriptions: vi.fn(() => []),
      dropSubscription: vi.fn(),
      close: vi.fn(),
    } as unknown as Journal;

    await reportEpoch({
      epochId: 2n,
      payoffWad: vaultPayoffWad,
      journal,
      arcClient,
      arcWallet,
      logger: fakeLogger(),
      alert: vi.fn(),
      dryRun: false,
    });

    expect(sendCalls).toHaveLength(1);
    const call = sendCalls[0] as { functionName: string; args: readonly unknown[] };
    expect(call.functionName).toBe("reportPayoff");
    expect(call.args).toEqual([2n, vaultPayoffWad]);
  });

  it("does nothing (no send) when the epoch is already reported on Arc", async () => {
    const arcClient = {
      readContract: vi.fn(async () => ({
        coverageEnd: 1n,
        reportDeadline: 2n,
        reported: true,
        payoffWad: 500_000_000_000_000_000n,
        coverageStart: 0n,
        totalCoverageSold: 0n,
      })),
    } as unknown as PublicClient;
    const send = vi.fn();
    const arcWallet = { address: "0x0", send, balance: vi.fn(), requireBalance: vi.fn() } as unknown as Wallet;
    const journal = { claim: vi.fn(), get: vi.fn(), recordDone: vi.fn(), recordFailed: vi.fn() } as unknown as Journal;

    await reportEpoch({
      epochId: 2n,
      payoffWad: 1n,
      journal,
      arcClient,
      arcWallet,
      logger: fakeLogger(),
      alert: vi.fn(),
      dryRun: false,
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("dry run never calls send() or touches the journal", async () => {
    const arcClient = {
      readContract: vi.fn(async () => ({
        coverageEnd: 1_789_153_388n,
        reportDeadline: 1_789_239_788n,
        reported: false,
        payoffWad: 0n,
        coverageStart: 0n,
        totalCoverageSold: 0n,
      })),
    } as unknown as PublicClient;
    const send = vi.fn();
    const arcWallet = { address: "0x0", send, balance: vi.fn(), requireBalance: vi.fn() } as unknown as Wallet;
    const claim = vi.fn();
    const journal = { claim, get: vi.fn(), recordDone: vi.fn(), recordFailed: vi.fn() } as unknown as Journal;

    await reportEpoch({
      epochId: 2n,
      payoffWad: 923_000_000_000_000_000n,
      journal,
      arcClient,
      arcWallet,
      logger: fakeLogger(),
      alert: vi.fn(),
      dryRun: true,
    });

    expect(send).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("a ReportWindowClosed revert is terminal: the second tick never resends, even though the epoch is still unreported", async () => {
    // Uses a real journal (not a mock) so `claim()`'s state machine actually gates
    // the second call -- BACKEND_HANDOFF.md's revert table plus outcomes.ts both say
    // ReportWindowClosed must never be retried, and a mocked journal could pass this
    // test without the production claim()/recordDone() wiring actually doing that.
    const journal = openJournal(":memory:");
    const arcClient = {
      readContract: vi.fn(async () => ({
        coverageEnd: 1_789_153_388n,
        reportDeadline: 1_789_239_788n,
        reported: false, // stays false: the fail-safe path, nobody ever reports it
        payoffWad: 0n,
        coverageStart: 0n,
        totalCoverageSold: 0n,
      })),
    } as unknown as PublicClient;

    const send = vi.fn(async () => ({
      ok: false as const,
      reason: "reverted: ReportWindowClosed",
      revertName: "ReportWindowClosed",
    }));
    const arcWallet = { address: "0xreporter", send, balance: vi.fn(), requireBalance: vi.fn() } as unknown as Wallet;
    const alert = vi.fn(async () => {});

    const params = {
      epochId: 2n,
      payoffWad: 500_000_000_000_000_000n,
      journal,
      arcClient,
      arcWallet,
      logger: fakeLogger(),
      alert,
      dryRun: false,
    };

    await reportEpoch(params); // tick 1: attempts, hits the revert, journals it terminal
    expect(send).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith("error", expect.stringContaining("ReportWindowClosed"), expect.any(Object));

    const record = journal.get("reporter", "reportPayoff", "2");
    expect(record?.status).toBe("done"); // done, not failed -- failed would be reclaimable
    expect(record?.txHash).toBe("terminal-failure"); // sentinel, never a real hash

    await reportEpoch(params); // tick 2: must not resend a revert that can only ever repeat
    expect(send).toHaveBeenCalledTimes(1); // still 1 -- no second attempt

    journal.close();
  });
});
