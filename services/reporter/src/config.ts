/**
 * Reporter-specific environment, layered on `@volatus/service-kit`'s
 * `loadConfig`. Only what this service actually uses is required —
 * `KEEPER_PRIVATE_KEY` (part of `commonConfigShape`) is a different
 * service's key and is deliberately not requested here, so this service
 * cannot be started with the wrong secret loaded by accident and never logs
 * or needs it.
 */

import { z } from "zod";
import { loadConfig, optionalUrlSchema, privateKeySchema, rpcUrlSchema } from "@volatus/service-kit";

/**
 * The block `SigmaVault` was deployed at on Unichain Sepolia — the default
 * floor for the `EpochOpened` backfill when the journal has no cursor yet.
 *
 * Measured from `contracts/broadcast/DeployTestnet.s.sol/1301/run-latest.json`:
 * the `SigmaVault` deployment receipt is at block `0x3ab59ea` = 61,561,322.
 * Overridable via `VAULT_EPOCH_SCAN_START_BLOCK` so a fresh journal on a
 * different deployment doesn't have to edit code.
 */
export const MEASURED_VAULT_DEPLOY_BLOCK = 61_561_322n;

export const reporterConfigShape = {
  UNICHAIN_SEPOLIA_RPC: rpcUrlSchema,
  ARC_TESTNET_RPC: rpcUrlSchema,
  /** The only privileged key this service holds. See README.md and DECISIONS.md §12. */
  REPORTER_PRIVATE_KEY: privateKeySchema,
  ALERT_WEBHOOK_URL: optionalUrlSchema,
  JOURNAL_PATH: z.string().optional(),

  /**
   * Added to a mirrored epoch's `coverageEnd` to get its `reportDeadline`.
   * BACKEND_HANDOFF.md: "24h is reasonable on testnet. Do not set it tight
   * to look responsive." Default matches that literally.
   */
  REPORT_DEADLINE_MARGIN_SECONDS: z.coerce.number().int().positive().default(86_400),

  /**
   * How long before `reportDeadline` the deadline alarm starts firing.
   * Generous by default: this is the whole point of the service
   * (BACKEND_HANDOFF.md: "that alarm is the difference between a payout and
   * a mass refund"), so the default errs toward firing early rather than
   * looking quiet.
   */
  DEADLINE_ALARM_MARGIN_SECONDS: z.coerce.number().int().positive().default(21_600),

  /** How often `tick()` runs when looping. `runLoop` jitters this by default. */
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),

  /** See `MEASURED_VAULT_DEPLOY_BLOCK` above. */
  VAULT_EPOCH_SCAN_START_BLOCK: z.coerce.bigint().default(MEASURED_VAULT_DEPLOY_BLOCK),
};

export type ReporterConfig = z.infer<z.ZodObject<typeof reporterConfigShape>>;

export function loadReporterConfig(): ReporterConfig {
  return loadConfig(reporterConfigShape);
}
