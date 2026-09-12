/**
 * One tick: roll the epoch if it has ended, run one demo-bot round regardless
 * (liveliness continues mid-epoch too), and take a vol-history sample. Called
 * from three places identically -- `index.ts`'s `runLoop`, its `--once`, and
 * `server.ts`'s `/tick` handler -- so "ping-driven" and "self-looping" are
 * exactly the same code path, never two implementations that can drift.
 */

import type { PublicClient } from "viem";
import { MEASURED_POOL_ID } from "@volatus/onchain";
import type { AlertFn, Journal, Wallet } from "@volatus/service-kit";
import type { Logger } from "./journalReconcile.js";
import { runDemoBotRound, type DemoBotResult } from "./demoBot.js";
import type { HistoryStore, VolSample } from "./history.js";
import { rollIfEnded, type RollResult } from "./roll.js";
import type { RollerConfig } from "./config.js";

export interface TickContext {
  client: PublicClient;
  wallet: Wallet;
  journal: Journal;
  history: HistoryStore;
  logger: Logger;
  alert: AlertFn;
  config: RollerConfig;
  dryRun: boolean;
}

export interface TickSummary {
  ranAt: string;
  roll: RollResult;
  demoBot: DemoBotResult | { ran: false; kind: "disabled" };
  sample: VolSample;
}

export async function tick(ctx: TickContext): Promise<TickSummary> {
  const { client, wallet, journal, history, logger, alert, config, dryRun } = ctx;
  const poolId = MEASURED_POOL_ID;

  const roll = await rollIfEnded({
    client,
    wallet,
    journal,
    logger,
    alert,
    poolId,
    nextEpochBlocks: config.NEXT_EPOCH_BLOCKS,
    nextHorizonSeconds: config.NEXT_HORIZON_SECONDS,
    mintAmountUsdc: config.MINT_AMOUNT_USDC,
    initialVarPriceWad: config.INITIAL_VAR_PRICE_WAD,
    volLiquidity: config.VOL_LIQUIDITY,
    dryRun,
  });

  const demoBot: TickSummary["demoBot"] =
    config.DEMO_BOT_ENABLED === "1" && !dryRun
      ? await runDemoBotRound({
          client,
          wallet,
          logger,
          poolId,
          volSwapProb: config.DEMO_BOT_VOL_SWAP_PROB,
          swapSizeWad: config.DEMO_BOT_SWAP_SIZE_WAD,
          volSwapSize: config.DEMO_BOT_VOL_SWAP_SIZE,
          swapSizeJitterPct: config.DEMO_BOT_SWAP_SIZE_JITTER_PCT,
        })
      : { ran: false, kind: "disabled" };

  const sample = await history.sampleOnce(client, poolId, logger);

  return { ranAt: new Date().toISOString(), roll, demoBot, sample };
}
