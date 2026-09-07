import { SIGMA_STREAM_DEPLOY_BLOCK } from "@volatus/onchain";
/**
 * The underwriter's environment. Like `services/keeper`'s `config.ts`, this
 * declares exactly what this service needs rather than pulling in
 * `commonConfigShape` wholesale — it never holds the reporter's key, and
 * `UNDERWRITER_PRIVATE_KEY` is its own, distinct from `KEEPER_PRIVATE_KEY`.
 *
 * Every policy threshold below is a config default, not a hardcoded
 * constant, and every one is named for what it does — see `policy.ts` and
 * README.md's "Policy and its limits" for what these numbers are (a
 * heuristic) and are not (a calibrated risk model).
 */

import { z } from "zod";
import { loadConfig, optionalUrlSchema, privateKeySchema, rpcUrlSchema } from "@volatus/service-kit";
import type { PolicyTuning } from "./policy.js";
import type { SpendCapTuning } from "./caps.js";

/** `z.coerce.bigint()` rejects a decimal string like "0.05" -- policy thresholds are WAD
 *  integers (`"50000000000000000"` for 5%), not decimal percentages, and this schema says
 *  so at the boundary rather than letting a misconfigured ".05" fail two modules away. */
const wadBigintSchema = z.coerce.bigint();

export const underwriterConfigShape = {
  ARC_TESTNET_RPC: rpcUrlSchema,
  UNICHAIN_SEPOLIA_RPC: rpcUrlSchema,
  JOURNAL_PATH: z.string().optional(),
  ALERT_WEBHOOK_URL: optionalUrlSchema,

  /** "1" runs the tick loop read-only: logs the decision and why, sends nothing. `status`
   *  is always dry regardless of this flag -- see `index.ts`. */
  DRY_RUN: z.enum(["0", "1"]).default("0"),

  /** "local" signs with `UNDERWRITER_PRIVATE_KEY` via `makeWallet` (service-kit). "circle"
   *  signs through a Circle developer-controlled wallet (`wallet/circleAgentWallet.ts`).
   *  Defaults to "local" because `CIRCLE_API_KEY`/`CIRCLE_ENTITY_SECRET` are not provisioned
   *  in this environment (BRIEF.md) -- see that module's doc comment. */
  UNDERWRITER_WALLET_MODE: z.enum(["local", "circle"]).default("local"),
  /** Required when `UNDERWRITER_WALLET_MODE=local`. This service's own key -- never
   *  `KEEPER_PRIVATE_KEY` or `REPORTER_PRIVATE_KEY`. */
  UNDERWRITER_PRIVATE_KEY: privateKeySchema.optional(),
  /** Required when `UNDERWRITER_WALLET_MODE=circle`. See `wallet/circleAgentWallet.ts`. */
  CIRCLE_API_KEY: z.string().optional(),
  CIRCLE_ENTITY_SECRET: z.string().optional(),
  CIRCLE_WALLET_ID: z.string().optional(),
  CIRCLE_FEE_LEVEL: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),

  /** Arc block to start Subscribed-log scanning from when the journal has no cursor yet. */
  UNDERWRITER_SEED_BLOCK: z.coerce.bigint().default(SIGMA_STREAM_DEPLOY_BLOCK),
  UNDERWRITER_TICK_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /** `start` refuses to run below this balance (USDC; on Arc gas IS this balance). */
  UNDERWRITER_MIN_BALANCE_USDC: z.coerce.number().nonnegative().default(0.05),

  /* ---- Policy thresholds (policy.ts) ---- */
  UW_POST_SPREAD_THRESHOLD_WAD: wadBigintSchema.default(50_000_000_000_000_000n), // +5%
  UW_WITHDRAW_SPREAD_THRESHOLD_WAD: wadBigintSchema.default(-20_000_000_000_000_000n), // -2%
  UW_MAX_CONCENTRATION_WAD: wadBigintSchema.default(500_000_000_000_000_000n), // 50%
  UW_POST_INCREMENT_USDC: z.coerce.number().positive().default(1), // 1 USDC per "post" decision
  UW_WITHDRAW_SHARE_FRACTION_WAD: wadBigintSchema.default(100_000_000_000_000_000n), // 10% of own shares

  /* ---- Spending caps (caps.ts) -- enforced here; Circle's policy is mainnet-only. ---- */
  UW_PER_TX_CAP_USDC: z.coerce.number().positive().default(1),
  UW_PERIOD_CAP_USDC: z.coerce.number().positive().default(5),
  UW_PERIOD_SECONDS: z.coerce.number().int().positive().default(86_400),

  /** Whether `tick.ts` is allowed to actually send a withdrawal the policy has flagged
   *  `wouldBlockSubscriptions`. Default false: surfaced and alarmed on, never sent, until an
   *  operator explicitly opts in. See `policy.ts` module doc and README.md. */
  UW_ALLOW_BLOCKING_WITHDRAWALS: z.enum(["0", "1"]).default("0"),
};

export type UnderwriterConfig = z.infer<z.ZodObject<typeof underwriterConfigShape>>;

export function loadUnderwriterConfig(): UnderwriterConfig {
  return loadConfig(underwriterConfigShape);
}

export function policyTuningFromConfig(config: UnderwriterConfig): PolicyTuning {
  return {
    postSpreadThresholdWad: config.UW_POST_SPREAD_THRESHOLD_WAD,
    withdrawSpreadThresholdWad: config.UW_WITHDRAW_SPREAD_THRESHOLD_WAD,
    maxConcentrationWad: config.UW_MAX_CONCENTRATION_WAD,
    postIncrementUsdc: BigInt(Math.round(config.UW_POST_INCREMENT_USDC * 1e6)),
    withdrawShareFractionWad: config.UW_WITHDRAW_SHARE_FRACTION_WAD,
  };
}

export function spendCapTuningFromConfig(config: UnderwriterConfig): SpendCapTuning {
  return {
    perTxCapUsdc: config.UW_PER_TX_CAP_USDC,
    periodCapUsdc: config.UW_PERIOD_CAP_USDC,
    periodSeconds: config.UW_PERIOD_SECONDS,
  };
}
