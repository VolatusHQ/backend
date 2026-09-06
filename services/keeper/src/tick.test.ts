import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { openJournal, type Journal, type Logger, type SendResult, type Wallet } from "@volatus/service-kit";
import { runKeeperTick } from "./tick.js";
import { seedSubscription, listActiveSubscriptions } from "./registry.js";
import type { GateTuning } from "./config.js";

const ADDR = "0x0000000000000000000000000000000000000001" as Address;
const KEEPER = "0x000000000000000000000000000000000000ee" as Address;
const SUBSCRIBER_A = "0x7975E591c26e6c6D9B0CFd9A81f6d61A921C080c" as Address;
const SUBSCRIBER_B = "0x000000000000000000000000000000000000bb" as Address;

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

const defaultTuning: GateTuning = {
  safetyFactor: 10,
  maxSyncIntervalSeconds: 3_600n,
  epochEndMarginSeconds: 120n,
  drainMarginSeconds: 120n,
};

interface Subscription {
  ratePerSecond: bigint;
  coverageNotional: bigint;
  funded: bigint;
  lastSync: bigint;
  coveredSeconds: bigint;
  claimed: boolean;
}
interface EpochState {
  coverageStart: bigint;
  coverageEnd: bigint;
  reportDeadline: bigint;
  reported: boolean;
  payoffWad: bigint;
  totalCoverageSold: bigint;
}

function fakeClient(opts: {
  epoch: EpochState;
  subs: Map<string, { subscription: Subscription; runwaySeconds: bigint }>;
  gas?: bigint;
  gasPrice?: bigint;
  throwFor?: Set<string>;
}) {
  const gas = opts.gas ?? 68_887n;
  const gasPrice = opts.gasPrice ?? 25_000_000_000n; // native wei per gas
  return {
    chain: { id: 5_042_002 },
    getLogs: vi.fn(async () => []),
    getBlockNumber: vi.fn(async () => 1_000n),
    estimateContractGas: vi.fn(async () => gas),
    getGasPrice: vi.fn(async () => gasPrice),
    readContract: vi.fn(async (params: { functionName: string; args: readonly unknown[] }) => {
      if (params.functionName === "epoch") return opts.epoch;
      const subscriber = (params.args[1] as Address).toLowerCase();
      if (opts.throwFor?.has(subscriber)) throw new Error(`boom:${subscriber}`);
      const state = opts.subs.get(subscriber);
      if (!state) throw new Error(`no fake state for ${subscriber}`);
      if (params.functionName === "subscription") return state.subscription;
      if (params.functionName === "runwaySeconds") return state.runwaySeconds;
      throw new Error(`unexpected functionName ${params.functionName}`);
    }),
  };
}

function fakeWallet(sendImpl: (args: unknown) => Promise<SendResult>): Wallet {
  return {
    address: KEEPER,
    send: vi.fn(sendImpl),
    balance: vi.fn(async () => 10_000_000_000_000_000_000n),
    requireBalance: vi.fn(async () => {}),
  };
}

describe("runKeeperTick", () => {
  let journal: Journal;
  beforeEach(() => {
    journal = openJournal(":memory:");
  });
  afterEach(() => journal.close());

  it("sends a real sync when accrued premium clears the safety factor, and does not for one that doesn't", async () => {
    seedSubscription(journal, 2n, SUBSCRIBER_A);
    seedSubscription(journal, 2n, SUBSCRIBER_B);

    const epoch: EpochState = {
      coverageStart: 1_788_562_697n,
      coverageEnd: 1_789_153_388n,
      reportDeadline: 1_789_239_788n,
      reported: false,
      payoffWad: 0n,
      totalCoverageSold: 0n,
    };
    const now = 1_788_600_000n;

    const subs = new Map([
      [
        SUBSCRIBER_A.toLowerCase(),
        {
          // ~1722s elapsed at rate 100 = 172200 accrued, vs ~1722 gas cost * 10 = 17220 threshold — economic.
          subscription: { ratePerSecond: 100n, coverageNotional: 4_000_000n, funded: 5_000_000n, lastSync: now - 1_722n, coveredSeconds: 0n, claimed: false },
          runwaySeconds: 50_000n,
        },
      ],
      [
        SUBSCRIBER_B.toLowerCase(),
        {
          // 30s elapsed at rate 100 = 3000 accrued — nowhere near 10x ~1722 gas cost.
          subscription: { ratePerSecond: 100n, coverageNotional: 4_000_000n, funded: 5_000_000n, lastSync: now - 30n, coveredSeconds: 0n, claimed: false },
          runwaySeconds: 50_000n,
        },
      ],
    ]);
    const client = fakeClient({ epoch, subs });
    const wallet = fakeWallet(async () => ({ ok: true, hash: "0xabc", receipt: {} as never }));

    const summary = await runKeeperTick({
      journal,
      client: client as never,
      address: ADDR,
      keeperAddress: KEEPER,
      logger: silentLogger,
      tuning: defaultTuning,
      seedBlock: 0n,
      wallet,
      dryRun: false,
      now: () => now,
    });

    const a = summary.results.find((r) => r.subscriber === SUBSCRIBER_A)!;
    const b = summary.results.find((r) => r.subscriber === SUBSCRIBER_B)!;

    expect(a.decision.due).toBe(true);
    expect(a.decision.reason).toBe("economic");
    expect(a.sendResult).toEqual({ ok: true, hash: "0xabc", receipt: {} });

    expect(b.decision.due).toBe(false);
    expect(b.decision.reason).toBe("below-threshold");
    expect(b.sendResult).toBeUndefined();

    expect(wallet.send).toHaveBeenCalledTimes(1);
    expect(wallet.send).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "sync", args: [2n, SUBSCRIBER_A] }),
    );
  });

  it("DRY_RUN mode never calls wallet.send, even when a sync is due", async () => {
    seedSubscription(journal, 2n, SUBSCRIBER_A);
    const epoch: EpochState = {
      coverageStart: 0n,
      coverageEnd: 999_999_999n,
      reportDeadline: 999_999_999n,
      reported: false,
      payoffWad: 0n,
      totalCoverageSold: 0n,
    };
    const now = 100_000n;
    const subs = new Map([
      [
        SUBSCRIBER_A.toLowerCase(),
        {
          subscription: { ratePerSecond: 100n, coverageNotional: 4_000_000n, funded: 5_000_000n, lastSync: now - 5_000n, coveredSeconds: 0n, claimed: false },
          runwaySeconds: 50_000n,
        },
      ],
    ]);
    const client = fakeClient({ epoch, subs });
    const wallet = fakeWallet(async () => ({ ok: true, hash: "0xshould-not-be-called", receipt: {} as never }));

    const summary = await runKeeperTick({
      journal,
      client: client as never,
      address: ADDR,
      keeperAddress: KEEPER,
      logger: silentLogger,
      tuning: defaultTuning,
      seedBlock: 0n,
      wallet,
      dryRun: true,
      now: () => now,
    });

    expect(summary.results[0]!.decision.due).toBe(true);
    expect(summary.results[0]!.sendResult).toBeUndefined();
    expect(wallet.send).not.toHaveBeenCalled();
  });

  it("drops a subscription once the epoch is past coverageEnd, after attempting a final sync", async () => {
    seedSubscription(journal, 2n, SUBSCRIBER_A);
    const coverageEnd = 1_000_000n;
    const epoch: EpochState = { coverageStart: 0n, coverageEnd, reportDeadline: 2_000_000n, reported: false, payoffWad: 0n, totalCoverageSold: 0n };
    const now = coverageEnd + 500n; // well past coverageEnd

    const subs = new Map([
      [
        SUBSCRIBER_A.toLowerCase(),
        {
          subscription: { ratePerSecond: 100n, coverageNotional: 4_000_000n, funded: 5_000_000n, lastSync: coverageEnd - 10n, coveredSeconds: 0n, claimed: false },
          runwaySeconds: 40_000n,
        },
      ],
    ]);
    const client = fakeClient({ epoch, subs });
    const wallet = fakeWallet(async () => ({ ok: true, hash: "0xfinal", receipt: {} as never }));

    const summary = await runKeeperTick({
      journal,
      client: client as never,
      address: ADDR,
      keeperAddress: KEEPER,
      logger: silentLogger,
      tuning: defaultTuning,
      seedBlock: 0n,
      wallet,
      dryRun: false,
      now: () => now,
    });

    expect(summary.results[0]!.decision.reason).toBe("epoch-ending"); // forced, well below the economic bar
    expect(summary.results[0]!.sendResult).toEqual({ ok: true, hash: "0xfinal", receipt: {} });
    expect(summary.results[0]!.dropReason).toBe("epoch-ended");
    expect(listActiveSubscriptions(journal)).toHaveLength(0);
  });

  it("a failure reading one subscription is logged and does not stop the tick for the others", async () => {
    seedSubscription(journal, 2n, SUBSCRIBER_A);
    seedSubscription(journal, 2n, SUBSCRIBER_B);
    const epoch: EpochState = { coverageStart: 0n, coverageEnd: 999_999_999n, reportDeadline: 999_999_999n, reported: false, payoffWad: 0n, totalCoverageSold: 0n };
    const now = 100_000n;
    const subs = new Map([
      [
        SUBSCRIBER_B.toLowerCase(),
        {
          subscription: { ratePerSecond: 100n, coverageNotional: 4_000_000n, funded: 5_000_000n, lastSync: now - 10n, coveredSeconds: 0n, claimed: false },
          runwaySeconds: 50_000n,
        },
      ],
    ]);
    const client = fakeClient({ epoch, subs, throwFor: new Set([SUBSCRIBER_A.toLowerCase()]) });
    const wallet = fakeWallet(async () => ({ ok: true, hash: "0xok", receipt: {} as never }));

    const summary = await runKeeperTick({
      journal,
      client: client as never,
      address: ADDR,
      keeperAddress: KEEPER,
      logger: silentLogger,
      tuning: defaultTuning,
      seedBlock: 0n,
      wallet,
      dryRun: false,
      now: () => now,
    });

    const a = summary.results.find((r) => r.subscriber === SUBSCRIBER_A)!;
    const b = summary.results.find((r) => r.subscriber === SUBSCRIBER_B)!;
    expect(a.error).toContain("boom");
    expect(b.error).toBeUndefined();
    // B still processed normally despite A's failure.
    expect(b.decision.reason).not.toBe("nothing-elapsed");
  });
});
