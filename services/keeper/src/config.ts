/**
 * The keeper's environment. Deliberately not `commonConfigShape` wholesale —
 * this service never touches Unichain and never holds the reporter's key, so
 * it declares exactly what it needs (`@volatus/service-kit`'s README: "a
 * given service uses a subset — `loadConfig` takes whatever shape you pass
 * it").
 */

import { z } from "zod";
import { loadConfig, optionalUrlSchema, privateKeySchema, rpcUrlSchema } from "@volatus/service-kit";

export const keeperConfigShape = {
  ARC_TESTNET_RPC: rpcUrlSchema,
  KEEPER_PRIVATE_KEY: privateKeySchema,
  JOURNAL_PATH: z.string().optional(),
  ALERT_WEBHOOK_URL: optionalUrlSchema,

  /** "1" runs the tick loop read-only: logs what it would sync and why, sends nothing. */
  DRY_RUN: z.enum(["0", "1"]).default("0"),

  /** Sync when accrued premium is worth at least this many times the estimated gas cost. */
  KEEPER_SAFETY_FACTOR: z.coerce.number().positive().default(10),
  /** Backstop: sync anyway once this many seconds have elapsed since lastSync. */
  KEEPER_MAX_SYNC_INTERVAL_SECONDS: z.coerce.number().int().positive().default(3_600),
  /** Force a sync once coverageEnd is within this many seconds — see gate.ts. */
  KEEPER_EPOCH_END_MARGIN_SECONDS: z.coerce.number().int().nonnegative().default(120),
  /** Force a sync once projected runway falls to this many seconds or fewer — see gate.ts. */
  KEEPER_DRAIN_MARGIN_SECONDS: z.coerce.number().int().nonnegative().default(120),
  /** How often the loop re-evaluates every tracked subscription. The gate above decides
   *  whether that evaluation actually sends anything — this is not the naive send interval. */
  KEEPER_TICK_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  /** Arc block to start Subscribed-log scanning from when the journal has no cursor yet. */
  KEEPER_SEED_BLOCK: z.coerce.bigint().default(0n),
  /** `start` refuses to run below this balance (USDC, on Arc gas IS this balance). */
  KEEPER_MIN_BALANCE_USDC: z.coerce.number().nonnegative().default(0.05),
};

export type KeeperConfig = z.infer<z.ZodObject<typeof keeperConfigShape>>;

export function loadKeeperConfig(): KeeperConfig {
  return loadConfig(keeperConfigShape);
}

export interface GateTuning {
  safetyFactor: number;
  maxSyncIntervalSeconds: bigint;
  epochEndMarginSeconds: bigint;
  drainMarginSeconds: bigint;
}

export function gateTuningFromConfig(config: KeeperConfig): GateTuning {
  return {
    safetyFactor: config.KEEPER_SAFETY_FACTOR,
    maxSyncIntervalSeconds: BigInt(config.KEEPER_MAX_SYNC_INTERVAL_SECONDS),
    epochEndMarginSeconds: BigInt(config.KEEPER_EPOCH_END_MARGIN_SECONDS),
    drainMarginSeconds: BigInt(config.KEEPER_DRAIN_MARGIN_SECONDS),
  };
}
