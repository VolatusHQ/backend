#!/usr/bin/env node
/**
 * CLI entrypoint. Three ways to run this service:
 *
 *   node dist/index.js status   read-only, prints the pool's current epoch
 *                                state. Never touches the journal or sends.
 *   node dist/index.js --once   one real tick, then exit.
 *   node dist/index.js serve    (default) starts the HTTP server AND, if
 *                                `ROLLER_SELF_TICK_INTERVAL_MS` is set, an
 *                                internal `runLoop` calling the same tick --
 *                                so epochs keep rolling between pings too,
 *                                not only when something happens to ping it.
 *
 * `DRY_RUN=1` makes every tick (however triggered) compute and log what it
 * *would* do without ever calling `journal.claim`/`recordX` or `wallet.send`
 * -- see `roll.ts`/`demoBot.ts`'s `dryRun` branches.
 */

import { unichainClient } from "@volatus/onchain";
import { createLogger, makeAlerter, openJournal, runLoop, SENSITIVE_CONFIG_KEYS, type RunningLoop } from "@volatus/service-kit";
import { loadRollerConfig } from "./config.js";
import { SERVICE } from "./constants.js";
import { FatalRollerError } from "./outcomes.js";
import { startServer } from "./server.js";
import { buildRollerStatus, formatRollerStatus } from "./status.js";
import { tick, type TickContext } from "./tick.js";
import { makeHistoryStore } from "./history.js";
import { makeRollerWallet } from "./wallet.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  const once = process.argv.includes("--once");
  const dryRun = process.env.DRY_RUN === "1";

  const config = loadRollerConfig();
  const logger = createLogger({ service: SERVICE, redactKeys: SENSITIVE_CONFIG_KEYS });

  if (command === "status") {
    const report = await buildRollerStatus(unichainClient);
    process.stdout.write(formatRollerStatus(report) + "\n");
    return;
  }

  const journal = openJournal(config.JOURNAL_PATH);
  const alerter = makeAlerter({ service: SERVICE, webhookUrl: config.ALERT_WEBHOOK_URL, logger });
  const wallet = makeRollerWallet(config);
  const history = makeHistoryStore();

  if (dryRun) {
    logger.info("DRY_RUN=1 -- this run will not send any transaction or write to the journal");
  } else {
    const balance = await wallet.balance();
    logger.info("roller wallet balance at startup", { address: wallet.address, unichainWeiBalance: balance.toString() });
    if (balance === 0n) logger.warn("roller has zero ETH on Unichain -- settle/openEpoch/registerVolPool will fail to send");
  }

  const ctx: TickContext = { client: unichainClient, wallet, journal, history, logger, alert: alerter.alert, config, dryRun };

  if (once || dryRun) {
    try {
      const summary = await tick(ctx);
      logger.info("roller: one-shot tick complete", { summary: JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) });
    } catch (err) {
      if (err instanceof FatalRollerError) {
        logger.error("fatal error -- exiting", { err: err.message });
        process.exitCode = 1;
      } else {
        throw err;
      }
    }
    journal.close();
    return;
  }

  // command === "serve" (default): HTTP server always; internal loop only if configured.
  startServer({ port: config.PORT, history, logger, runTick: () => tick(ctx) });

  if (config.ROLLER_SELF_TICK_INTERVAL_MS) {
    const loop: RunningLoop = runLoop({
      name: SERVICE,
      intervalMs: config.ROLLER_SELF_TICK_INTERVAL_MS,
      tick: () => tick(ctx).then(() => undefined),
      alert: alerter.alert,
      onError: async (err) => {
        if (err instanceof FatalRollerError) {
          logger.error("fatal error -- stopping the self-tick loop; the HTTP server keeps running for /status", { err: err.message });
          await loop.stop();
        }
      },
    });
  } else {
    logger.info("ROLLER_SELF_TICK_INTERVAL_MS not set -- purely ping-driven, no internal loop");
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
