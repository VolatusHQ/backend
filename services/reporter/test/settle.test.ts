import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import type { Journal, Wallet } from "@volatus/service-kit";

// Isolate settleEpoch's own branching from the real ABI-decoding logic
// (that logic has its own direct test in discovery.test.ts).
vi.mock("../src/discovery.js", () => ({
  decodeEpochSettledLogs: vi.fn(),
}));

import { decodeEpochSettledLogs } from "../src/discovery.js";
import { settleEpoch } from "../src/settle.js";

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fakeLogger() } as never;
}

function fakeJournal(overrides: Partial<Journal> = {}): Journal {
  return {
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
    ...overrides,
  } as unknown as Journal;
}

const baseVaultEpoch = {
  poolId: "0x0" as `0x${string}`,
  startBlock: 0,
  endBlock: 62_301_001,
  horizonSeconds: 604_800,
  settled: false,
  startAccumulator: 0n,
  strikeWad: 0n,
  capWad: 0n,
  longToken: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  shortToken: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  collateralHeld: 0n,
  payoffWad: 0n,
};

describe("settleEpoch", () => {
  it("returns the existing payoff without sending when the vault epoch is already settled", async () => {
    const settledEpoch = { ...baseVaultEpoch, settled: true, payoffWad: 700_000_000_000_000_000n };
    const unichainClient = { readContract: vi.fn(async () => settledEpoch) } as unknown as PublicClient;
    const send = vi.fn();
    const unichainWallet = { address: "0x0", send, balance: vi.fn(), requireBalance: vi.fn() } as unknown as Wallet;

    const result = await settleEpoch({
      epochId: 2n,
      journal: fakeJournal(),
      unichainClient,
      unichainWallet,
      logger: fakeLogger(),
      alert: vi.fn(),
      dryRun: false,
    });

    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({ settled: true, payoffWad: 700_000_000_000_000_000n });
  });

  it("does nothing when the epoch has not reached endBlock yet", async () => {
    const unichainClient = {
      readContract: vi.fn(async () => baseVaultEpoch),
      getBlockNumber: vi.fn(async () => 61_712_100n), // well before endBlock 62,301,001
    } as unknown as PublicClient;
    const send = vi.fn();
    const unichainWallet = { address: "0x0", send, balance: vi.fn(), requireBalance: vi.fn() } as unknown as Wallet;

    const result = await settleEpoch({
      epochId: 2n,
      journal: fakeJournal(),
      unichainClient,
      unichainWallet,
      logger: fakeLogger(),
      alert: vi.fn(),
      dryRun: false,
    });

    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({ settled: false, payoffWad: null });
  });

  it("calls settle() once endBlock has passed, and reports the payoff read back after it lands", async () => {
    let settledOnChain = false;
    const unichainClient = {
      readContract: vi.fn(async () =>
        settledOnChain ? { ...baseVaultEpoch, settled: true, payoffWad: 123n } : baseVaultEpoch,
      ),
      getBlockNumber: vi.fn(async () => 62_301_001n),
    } as unknown as PublicClient;
    const send = vi.fn(async () => {
      settledOnChain = true;
      return { ok: true, hash: "0xsettle", receipt: { logs: [] } };
    });
    const unichainWallet = { address: "0x0", send, balance: vi.fn(), requireBalance: vi.fn() } as unknown as Wallet;
    vi.mocked(decodeEpochSettledLogs).mockReturnValue([]);
    const recordDone = vi.fn();

    const result = await settleEpoch({
      epochId: 2n,
      journal: fakeJournal({ recordDone }),
      unichainClient,
      unichainWallet,
      logger: fakeLogger(),
      alert: vi.fn(),
      dryRun: false,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ settled: true, payoffWad: 123n });
    expect(recordDone).toHaveBeenCalledWith("reporter", "settle", "2", "0xsettle", { payoffWad: "123" });
  });

  it("treats AlreadySettled as success, re-reading the payoff rather than failing", async () => {
    // Settled becomes true only once our own send() attempt runs -- simulating
    // another permissionless caller settling it in the gap between our own
    // "is it already settled" read and our simulate/send.
    let settledByRace = false;
    const unichainClient = {
      readContract: vi.fn(async () =>
        settledByRace ? { ...baseVaultEpoch, settled: true, payoffWad: 999n } : baseVaultEpoch,
      ),
      getBlockNumber: vi.fn(async () => 62_301_001n),
    } as unknown as PublicClient;
    const send = vi.fn(async () => {
      settledByRace = true;
      return { ok: false, reason: "reverted: AlreadySettled", revertName: "AlreadySettled" };
    });
    const unichainWallet = { address: "0x0", send, balance: vi.fn(), requireBalance: vi.fn() } as unknown as Wallet;
    const recordDone = vi.fn();
    const recordFailed = vi.fn();

    const result = await settleEpoch({
      epochId: 2n,
      journal: fakeJournal({ recordDone, recordFailed }),
      unichainClient,
      unichainWallet,
      logger: fakeLogger(),
      alert: vi.fn(),
      dryRun: false,
    });

    expect(result).toEqual({ settled: true, payoffWad: 999n });
    expect(recordDone).toHaveBeenCalledWith("reporter", "settle", "2", "already-settled-onchain", { reconciled: true });
    expect(recordFailed).not.toHaveBeenCalled();
  });

  it(
    "alarms and refuses to report when the EpochSettled event's payoff disagrees with the epoch() struct read",
    async () => {
      let settledOnChain = false;
      const unichainClient = {
        readContract: vi.fn(async () =>
          settledOnChain ? { ...baseVaultEpoch, settled: true, payoffWad: 100n } : baseVaultEpoch,
        ),
        getBlockNumber: vi.fn(async () => 62_301_001n),
      } as unknown as PublicClient;
      const send = vi.fn(async () => {
        settledOnChain = true;
        return { ok: true, hash: "0xsettle", receipt: { logs: [] } };
      });
      const unichainWallet = { address: "0x0", send, balance: vi.fn(), requireBalance: vi.fn() } as unknown as Wallet;
      // The event says 200, the struct read says 100 -- a real disagreement.
      vi.mocked(decodeEpochSettledLogs).mockReturnValue([{ args: { epochId: 2n, payoff: 200n } }] as never);
      const alert = vi.fn();
      const recordDone = vi.fn();
      const recordFailed = vi.fn();

      const result = await settleEpoch({
        epochId: 2n,
        journal: fakeJournal({ recordDone, recordFailed }),
        unichainClient,
        unichainWallet,
        logger: fakeLogger(),
        alert,
        dryRun: false,
      });

      expect(result).toEqual({ settled: false, payoffWad: null });
      expect(alert).toHaveBeenCalledWith("error", expect.stringContaining("disagrees"), expect.any(Object));
      expect(recordDone).not.toHaveBeenCalled();
      expect(recordFailed).toHaveBeenCalled();
    },
  );

  it("dry run never calls send() or touches the journal", async () => {
    const unichainClient = {
      readContract: vi.fn(async () => baseVaultEpoch),
      getBlockNumber: vi.fn(async () => 62_301_001n),
    } as unknown as PublicClient;
    const send = vi.fn();
    const unichainWallet = { address: "0x0", send, balance: vi.fn(), requireBalance: vi.fn() } as unknown as Wallet;
    const claim = vi.fn();

    const result = await settleEpoch({
      epochId: 2n,
      journal: fakeJournal({ claim }),
      unichainClient,
      unichainWallet,
      logger: fakeLogger(),
      alert: vi.fn(),
      dryRun: true,
    });

    expect(send).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(result).toEqual({ settled: false, payoffWad: null });
  });
});
