#!/usr/bin/env node
/**
 * Entrypoint for `@volatus/keeper` — BACKEND_HANDOFF.md's Service 2.
 *
 *   node dist/index.js start    (default) — run the gated tick loop.
 *   node dist/index.js status   — one-shot report, never sends a transaction.
 *
 * `DRY_RUN=1` applies to `start`: the loop still discovers subscriptions,
 * projects them, and evaluates the gate every tick, it just never calls
 * `wallet.send`. `status` is always dry, regardless of `DRY_RUN`.
 */

import { arcClient, arcTestnet, SIGMA_STREAM, sigmaStreamAbi } from "@volatus/onchain";
import { createLogger, makeAlerter, makeWallet, openJournal, runLoop, SENSITIVE_CONFIG_KEYS } from "@volatus/service-kit";
import { gateTuningFromConfig, loadKeeperConfig } from "./config.js";
import { formatStatusReport } from "./status.js";
import { runKeeperTick, type TickDeps } from "./tick.js";

const NATIVE_WEI_PER_USDC_UNIT = 10n ** 12n;

async function main(): Promise<void> {
  const command = process.argv[2] ?? "start";
  const config = loadKeeperConfig();
  const logger = createLogger({ service: "keeper", redactKeys: SENSITIVE_CONFIG_KEYS });
  const journal = openJournal(config.JOURNAL_PATH);

  const wallet = makeWallet({
    chain: arcTestnet,
    // `privateKeySchema` validates the `0x` + 64-hex shape at config load time;
    // zod infers the field as `string`, so the cast just recovers the type viem wants.
    privateKey: config.KEEPER_PRIVATE_KEY as `0x${string}`,
    rpcUrl: config.ARC_TESTNET_RPC,
  });

  const baseDeps: Omit<TickDeps, "dryRun" | "wallet"> = {
    journal,
    client: arcClient,
    address: SIGMA_STREAM,
    keeperAddress: wallet.address,
    logger,
    tuning: gateTuningFromConfig(config),
    seedBlock: config.KEEPER_SEED_BLOCK,
  };

  if (command === "status") {
    const summary = await runKeeperTick({ ...baseDeps, dryRun: true });
    const balanceWei = await wallet.balance();
    const report = formatStatusReport(summary, {
      walletAddress: wallet.address,
      walletBalanceUsdc: Number(balanceWei) / Number(NATIVE_WEI_PER_USDC_UNIT * 10n ** 6n),
    });
    process.stdout.write(`${report}\n`);
    journal.close();
    return;
  }

  if (command !== "start") {
    process.stderr.write(`unknown command "${command}" — expected "start" or "status"\n`);
    process.exitCode = 1;
    journal.close();
    return;
  }

  // A keeper that is silently broke is worse than one that is loudly down.
  const minBalanceWei = BigInt(Math.round(config.KEEPER_MIN_BALANCE_USDC * 1e6)) * NATIVE_WEI_PER_USDC_UNIT;
  await wallet.requireBalance(minBalanceWei);

  const dryRun = config.DRY_RUN === "1";
  if (dryRun) {
    logger.info("keeper: starting in DRY_RUN mode — sync decisions will be logged, nothing will be sent");
  }

  const alerter = makeAlerter({ service: "keeper", webhookUrl: config.ALERT_WEBHOOK_URL, logger });

  runLoop({
    name: "keeper",
    intervalMs: config.KEEPER_TICK_INTERVAL_MS,
    logger,
    alert: alerter.alert,
    tick: async () => {
      const summary = await runKeeperTick({ ...baseDeps, wallet, dryRun });
      logger.info("keeper: tick complete", {
        tracked: summary.results.length,
        synced: summary.results.filter((r) => r.sendResult?.ok).length,
        dropped: summary.results.filter((r) => r.dropReason).length,
        failed: summary.results.filter((r) => r.error).length,
      });
    },
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
