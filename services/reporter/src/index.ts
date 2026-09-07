#!/usr/bin/env node
/**
 * CLI entrypoint. Three ways to run this service:
 *
 *   node dist/index.js status        read-only, prints every epoch's state
 *                                    and what is pending. Never touches the
 *                                    journal or sends anything.
 *   node dist/index.js --once        one real tick, then exit. Useful for a
 *                                    cron-style invocation instead of a
 *                                    long-running loop.
 *   node dist/index.js               loops forever via `runLoop`.
 *
 * `DRY_RUN=1` forces every tick (looped or `--once`) to compute and log what
 * it *would* send, without ever calling `journal.claim`/`recordX` or
 * `wallet.send` — see `discovery.ts`/`settle.ts`/`report.ts`'s `dryRun`
 * branches. It composes with either invocation shape.
 */

import { arcClient, unichainClient } from "@volatus/onchain";
import { createLogger, makeAlerter, openJournal, runLoop, SENSITIVE_CONFIG_KEYS, type RunningLoop } from "@volatus/service-kit";
import { loadReporterConfig } from "./config.js";
import { SERVICE } from "./constants.js";
import { FatalReporterError } from "./outcomes.js";
import { buildStatus, formatStatus } from "./status.js";
import { tick, type TickContext } from "./tick.js";
import { makeReporterWallets } from "./wallets.js";

async function main(): Promise<void> {
  const command = process.argv[2];
  const once = process.argv.includes("--once");
  const dryRun = process.env.DRY_RUN === "1";

  const config = loadReporterConfig();
  const logger = createLogger({ service: SERVICE, redactKeys: SENSITIVE_CONFIG_KEYS });
  const journal = openJournal(config.JOURNAL_PATH);

  if (command === "status") {
    const report = await buildStatus({ unichainClient, arcClient, journal });
    process.stdout.write(formatStatus(report) + "\n");
    journal.close();
    return;
  }

  const alerter = makeAlerter({ service: SERVICE, webhookUrl: config.ALERT_WEBHOOK_URL, logger });
  const { unichainWallet, arcWallet } = makeReporterWallets(config);

  if (dryRun) {
    logger.info("DRY_RUN=1 -- this run will not send any transaction or write to the journal");
  } else {
    const [unichainBalance, arcBalance] = await Promise.all([unichainWallet.balance(), arcWallet.balance()]);
    logger.info("reporter wallet balances at startup", {
      address: unichainWallet.address,
      unichainWeiBalance: unichainBalance,
      arcUsdcBalance18d: arcBalance,
    });
    if (unichainBalance === 0n) logger.warn("reporter has zero ETH on Unichain -- settle() will fail to send");
    if (arcBalance === 0n) logger.warn("reporter has zero USDC (native gas) on Arc -- openEpoch/reportPayoff will fail to send");
  }

  const ctx: TickContext = {
    journal,
    unichainClient,
    arcClient,
    unichainWallet,
    arcWallet,
    logger,
    alert: alerter.alert,
    reportDeadlineMarginSeconds: BigInt(config.REPORT_DEADLINE_MARGIN_SECONDS),
    deadlineAlarmMarginSeconds: config.DEADLINE_ALARM_MARGIN_SECONDS,
    scanStartBlock: config.VAULT_EPOCH_SCAN_START_BLOCK,
    dryRun,
  };

  if (once || dryRun) {
    try {
      await tick(ctx);
    } catch (err) {
      if (err instanceof FatalReporterError) {
        logger.error("fatal error -- exiting", { err: err.message });
        process.exitCode = 1;
      } else {
        throw err;
      }
    }
    journal.close();
    return;
  }

  const loop: RunningLoop = runLoop({
    name: SERVICE,
    intervalMs: config.POLL_INTERVAL_MS,
    tick: () => tick(ctx),
    alert: alerter.alert,
    onError: async (err) => {
      if (err instanceof FatalReporterError) {
        logger.error("fatal error -- stopping the reporter, it will not recover on its own", { err: err.message });
        await loop.stop();
        journal.close();
        process.exitCode = 1;
      }
    },
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
