#!/usr/bin/env node
/**
 * Entrypoint for `@volatus/underwriter` — BACKEND_HANDOFF.md's Service 4.
 *
 *   node dist/index.js start    (default) — run the policy loop.
 *   node dist/index.js status   — one-shot report, never sends a transaction.
 *
 * `DRY_RUN=1` applies to `start`: the loop still reads both chains, evaluates
 * the policy and logs the intent, it just never calls `wallet.send`. `status`
 * is always dry regardless of that flag.
 *
 * The wallet is chosen by `UNDERWRITER_WALLET_MODE`. It defaults to `local`
 * because `CIRCLE_API_KEY`/`CIRCLE_ENTITY_SECRET` are not provisioned in this
 * environment — the Circle path is built and unit-tested against a mocked
 * client, and has never been exercised against Circle's live API. Do not
 * describe it as verified.
 */

import {
  arcClient,
  arcTestnet,
  ARC_USDC,
  MEASURED_POOL_ID,
  SIGMA_HOOK,
  SIGMA_ORACLE,
  SIGMA_STREAM,
  SIGMA_VAULT,
  unichainClient,
} from "@volatus/onchain";
import {
  createLogger,
  makeAlerter,
  makeWallet,
  openJournal,
  runLoop,
  SENSITIVE_CONFIG_KEYS,
  type Wallet,
} from "@volatus/service-kit";
import { loadUnderwriterConfig, policyTuningFromConfig, spendCapTuningFromConfig } from "./config.js";
import { formatStatusReport } from "./status.js";
import { runUnderwriterTick, type TickDeps } from "./tick.js";
import { makeCircleAgentWallet } from "./wallet/circleAgentWallet.js";

/** Arc's native balance is an 18-decimal view of the same USDC the ERC-20 shows at 6dp. */
const NATIVE_WEI_PER_USDC = 10n ** 18n;

async function buildWallet(config: ReturnType<typeof loadUnderwriterConfig>): Promise<Wallet> {
  if (config.UNDERWRITER_WALLET_MODE === "circle") {
    if (!config.CIRCLE_API_KEY || !config.CIRCLE_ENTITY_SECRET || !config.CIRCLE_WALLET_ID) {
      throw new Error(
        "UNDERWRITER_WALLET_MODE=circle requires CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET and CIRCLE_WALLET_ID",
      );
    }
    // The SDK client is constructed here and injected, so `circleAgentWallet.ts`
    // stays testable against a plain object. This path has never run against
    // Circle's live API — no credentials are provisioned in this environment —
    // so it is built and unit-tested, not verified. The client is passed to
    // `makeCircleAgentWallet` with no cast: `CircleWalletsClient`'s hand-written
    // shape was checked directly against `@circle-fin/developer-controlled-wallets`
    // installed `.d.ts` files (getWallet/createContractExecutionTransaction/
    // getTransaction on the ergonomic client `initiateDeveloperControlledWalletsClient`
    // returns), and the real class satisfies it structurally — TypeScript would
    // reject this assignment if that were no longer true.
    const { initiateDeveloperControlledWalletsClient } = await import(
      "@circle-fin/developer-controlled-wallets"
    );
    const client = initiateDeveloperControlledWalletsClient({
      apiKey: config.CIRCLE_API_KEY,
      entitySecret: config.CIRCLE_ENTITY_SECRET,
    });
    return makeCircleAgentWallet({
      client,
      publicClient: arcClient,
      walletId: config.CIRCLE_WALLET_ID,
      feeLevel: config.CIRCLE_FEE_LEVEL,
    });
  }

  if (!config.UNDERWRITER_PRIVATE_KEY) {
    throw new Error("UNDERWRITER_WALLET_MODE=local requires UNDERWRITER_PRIVATE_KEY");
  }
  return makeWallet({
    chain: arcTestnet,
    privateKey: config.UNDERWRITER_PRIVATE_KEY as `0x${string}`,
    rpcUrl: config.ARC_TESTNET_RPC,
  });
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "start";
  const config = loadUnderwriterConfig();
  const logger = createLogger({ service: "underwriter", redactKeys: SENSITIVE_CONFIG_KEYS });
  const journal = openJournal(config.JOURNAL_PATH);
  const alerter = makeAlerter({ service: "underwriter", logger, webhookUrl: config.ALERT_WEBHOOK_URL });

  const wallet = await buildWallet(config);

  const baseDeps: Omit<TickDeps, "dryRun" | "wallet"> = {
    journal,
    unichainClient,
    arcClient,
    streamAddress: SIGMA_STREAM,
    usdcAddress: ARC_USDC,
    oracleAddress: SIGMA_ORACLE,
    vaultAddress: SIGMA_VAULT,
    hookAddress: SIGMA_HOOK,
    poolId: MEASURED_POOL_ID,
    logger,
    policyTuning: policyTuningFromConfig(config),
    spendCapTuning: spendCapTuningFromConfig(config),
    seedBlock: config.UNDERWRITER_SEED_BLOCK,
    allowBlockingWithdrawals: config.UW_ALLOW_BLOCKING_WITHDRAWALS === "1",
    walletAddress: wallet.address,
    alert: alerter.alert,
  };

  if (command === "status") {
    const summary = await runUnderwriterTick({ ...baseDeps, dryRun: true });
    const balanceWei = await wallet.balance();
    process.stdout.write(
      `${formatStatusReport(summary, {
        walletAddress: wallet.address,
        walletBalanceUsdc: Number(balanceWei) / Number(NATIVE_WEI_PER_USDC),
      })}\n`,
    );
    journal.close();
    return;
  }

  if (command !== "start") {
    process.stderr.write(`unknown command "${command}" — expected "start" or "status"\n`);
    process.exitCode = 1;
    journal.close();
    return;
  }

  const dryRun = config.DRY_RUN === "1";
  if (!dryRun) {
    // A silently broke agent is worse than a loudly stopped one: on Arc gas is
    // USDC, so an empty wallet means every send fails one at a time instead of
    // the service refusing to start.
    await wallet.requireBalance(
      BigInt(Math.floor(config.UNDERWRITER_MIN_BALANCE_USDC * 1e18)),
    );
  }

  logger.info("underwriter starting", {
    dryRun,
    walletMode: config.UNDERWRITER_WALLET_MODE,
    address: wallet.address,
    intervalMs: config.UNDERWRITER_TICK_INTERVAL_MS,
  });

  const loop = runLoop({
    name: "underwriter",
    intervalMs: config.UNDERWRITER_TICK_INTERVAL_MS,
    logger,
    alert: alerter.alert,
    tick: async () => {
      const summary = await runUnderwriterTick({ ...baseDeps, dryRun, wallet });
      logger.info("underwriter tick", {
        intent: summary.decision.intent,
        reason: summary.decision.reason,
        dataSufficient: summary.market.dataSufficient,
        capacityPool: summary.capacityPool,
        sharePriceWad: summary.sharePriceWad,
        hash: summary.sendResult?.ok ? summary.sendResult.hash : undefined,
      });
    },
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void loop.stop().then(() => journal.close());
    });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
