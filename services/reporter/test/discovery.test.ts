import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { sigmaVaultAbi, SIGMA_VAULT } from "@volatus/onchain";
import type { Journal, Wallet } from "@volatus/service-kit";
import type { PublicClient } from "viem";
import { decodeEpochSettledLogs, mirrorEpoch } from "../src/discovery.js";

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

describe("decodeEpochSettledLogs — the cross-check settle.ts relies on", () => {
  it("decodes a real EpochSettled log emitted by SigmaVault's ABI shape", () => {
    const epochId = 2n;
    const realizedVariance = 123_456n;
    const payoff = 500_000_000_000_000_000n;
    const topics = encodeEventTopics({ abi: sigmaVaultAbi, eventName: "EpochSettled", args: { epochId } });
    const data = encodeAbiParameters(
      [
        { name: "realizedVariance", type: "uint256" },
        { name: "payoff", type: "uint256" },
      ],
      [realizedVariance, payoff],
    );

    const decoded = decodeEpochSettledLogs([
      {
        address: SIGMA_VAULT,
        topics,
        data,
        blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000".slice(0, 66) as `0x${string}`,
        blockNumber: 1n,
        logIndex: 0,
        transactionHash: `0x${"11".repeat(32)}` as `0x${string}`,
        transactionIndex: 0,
        removed: false,
      },
    ]);

    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.args.epochId).toBe(epochId);
    expect(decoded[0]!.args.payoff).toBe(payoff);
  });
});

describe("mirrorEpoch", () => {
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

  function fakeClients(opts: { arcCoverageEnd: bigint; latestBlock: bigint }) {
    const unichainClient = {
      readContract: vi.fn(async () => baseVaultEpoch),
      getBlockNumber: vi.fn(async () => opts.latestBlock),
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
        number: blockNumber,
        timestamp: 1_788_564_528n - (opts.latestBlock - blockNumber),
      })),
    } as unknown as PublicClient;
    const arcClient = {
      readContract: vi.fn(async () => ({
        coverageStart: 0n,
        coverageEnd: opts.arcCoverageEnd,
        reportDeadline: 0n,
        reported: false,
        payoffWad: 0n,
        totalCoverageSold: 0n,
      })),
    } as unknown as PublicClient;
    return { unichainClient, arcClient };
  }

  it("does nothing (no send) when the epoch is already open on Arc, but records it in the journal", async () => {
    const { unichainClient, arcClient } = fakeClients({ arcCoverageEnd: 1_789_153_388n, latestBlock: 61_712_100n });
    const send = vi.fn();
    const arcWallet = { address: "0x0", send, balance: vi.fn(), requireBalance: vi.fn() } as unknown as Wallet;
    const recordDone = vi.fn();
    const journal = fakeJournal({ recordDone });

    await mirrorEpoch({
      epochId: 2n,
      journal,
      unichainClient,
      arcClient,
      arcWallet,
      logger: fakeLogger(),
      alert: vi.fn(),
      reportDeadlineMarginSeconds: 86_400n,
      dryRun: false,
    });

    expect(send).not.toHaveBeenCalled();
    expect(recordDone).toHaveBeenCalledWith("reporter", "openEpoch", "2", "already-open-onchain", { reconciled: true });
  });

  it("sends openEpoch with a conservative coverageEnd/reportDeadline when the epoch is not yet mirrored", async () => {
    // endBlock is ~588,901 blocks ahead of latestBlock -- matches vault epoch 2's real gap.
    const { unichainClient, arcClient } = fakeClients({ arcCoverageEnd: 0n, latestBlock: 61_712_100n });
    const sendCalls: unknown[] = [];
    const arcWallet = {
      address: "0x0",
      send: vi.fn(async (args: unknown) => {
        sendCalls.push(args);
        return { ok: true, hash: "0xabc", receipt: {} };
      }),
      balance: vi.fn(),
      requireBalance: vi.fn(),
    } as unknown as Wallet;
    const journal = fakeJournal();

    await mirrorEpoch({
      epochId: 2n,
      journal,
      unichainClient,
      arcClient,
      arcWallet,
      logger: fakeLogger(),
      alert: vi.fn(),
      reportDeadlineMarginSeconds: 86_400n,
      dryRun: false,
    });

    expect(sendCalls).toHaveLength(1);
    const call = sendCalls[0] as { functionName: string; args: readonly unknown[] };
    expect(call.functionName).toBe("openEpoch");
    const [epochId, coverageEnd, reportDeadline] = call.args as [bigint, bigint, bigint];
    expect(epochId).toBe(2n);
    // At the measured ~1s/block rate, coverageEnd should land close to now + remaining blocks.
    const remainingBlocks = BigInt(baseVaultEpoch.endBlock) - 61_712_100n;
    expect(coverageEnd).toBeLessThanOrEqual(1_788_564_528n + remainingBlocks);
    expect(reportDeadline).toBe(coverageEnd + 86_400n);
  });

  it("does NOT mirror a stale epoch whose report window would already be closed, and does not send", async () => {
    // endBlock far in the past -> computed coverageEnd (and thus reportDeadline) is also in the past.
    const staleVaultEpoch = { ...baseVaultEpoch, endBlock: 60_000_000 };
    const unichainClient = {
      readContract: vi.fn(async () => staleVaultEpoch),
      getBlockNumber: vi.fn(async () => 61_712_100n),
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
        number: blockNumber,
        timestamp: 1_788_564_528n - (61_712_100n - blockNumber),
      })),
    } as unknown as PublicClient;
    const arcClient = {
      readContract: vi.fn(async () => ({
        coverageStart: 0n,
        coverageEnd: 0n,
        reportDeadline: 0n,
        reported: false,
        payoffWad: 0n,
        totalCoverageSold: 0n,
      })),
    } as unknown as PublicClient;
    const send = vi.fn();
    const arcWallet = { address: "0x0", send, balance: vi.fn(), requireBalance: vi.fn() } as unknown as Wallet;
    const recordDone = vi.fn();
    const journal = fakeJournal({ recordDone });

    await mirrorEpoch({
      epochId: 1n,
      journal,
      unichainClient,
      arcClient,
      arcWallet,
      logger: fakeLogger(),
      alert: vi.fn(),
      reportDeadlineMarginSeconds: 86_400n,
      dryRun: false,
    });

    expect(send).not.toHaveBeenCalled();
    expect(recordDone).toHaveBeenCalledWith(
      "reporter",
      "openEpoch",
      "1",
      "skipped-stale",
      expect.any(Object),
    );
  });

  it("a dry run never sends and never touches the journal, even when it would otherwise mirror", async () => {
    const { unichainClient, arcClient } = fakeClients({ arcCoverageEnd: 0n, latestBlock: 61_712_100n });
    const send = vi.fn();
    const arcWallet = { address: "0x0", send, balance: vi.fn(), requireBalance: vi.fn() } as unknown as Wallet;
    const claim = vi.fn();
    const recordDone = vi.fn();
    const journal = fakeJournal({ claim, recordDone });

    await mirrorEpoch({
      epochId: 2n,
      journal,
      unichainClient,
      arcClient,
      arcWallet,
      logger: fakeLogger(),
      alert: vi.fn(),
      reportDeadlineMarginSeconds: 86_400n,
      dryRun: true,
    });

    expect(send).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(recordDone).not.toHaveBeenCalled();
  });
});
