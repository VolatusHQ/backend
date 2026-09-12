/**
 * Roller-specific environment, layered on `@volatus/service-kit`'s
 * `loadConfig`. Only what this service actually uses is required —
 * `REPORTER_PRIVATE_KEY`/`KEEPER_PRIVATE_KEY` are other services' keys and
 * are deliberately not requested here, same convention `reporter/src/config.ts`
 * documents.
 */

import { z } from "zod";
import { loadConfig, optionalUrlSchema, privateKeySchema, rpcUrlSchema } from "@volatus/service-kit";

export const rollerConfigShape = {
  UNICHAIN_SEPOLIA_RPC: rpcUrlSchema,
  /** The only key this service holds. Also the new VolatusOracle's `curator` —
   *  see `contracts/script/RedeployOracle.s.sol`. */
  ROLLER_PRIVATE_KEY: privateKeySchema,
  ALERT_WEBHOOK_URL: optionalUrlSchema,
  JOURNAL_PATH: z.string().optional(),

  /** Render injects this in production; falls back to a plain local default. */
  PORT: z.coerce.number().int().positive().default(8787),

  /** How long the next epoch this service opens should run. Fast by design —
   *  this is a demo-liveliness service, not the protocol's production cadence
   *  (`DeployDemoPool.s.sol`'s fast-cadence pool uses the same order of
   *  magnitude). Overridable per deployment. */
  NEXT_EPOCH_BLOCKS: z.coerce.bigint().default(600n),
  NEXT_HORIZON_SECONDS: z.coerce.number().int().positive().default(600),

  /** How much collateral to mint for the fresh vol-pool seed each roll. */
  MINT_AMOUNT_USDC: z.coerce.bigint().default(25_000_000_000n), // 25,000 mUSDC, 6dp
  /** STORM's opening price in the fresh vol pool, WAD. `0.3e18` matches
   *  `SettleAndRoll.s.sol`'s own default. */
  INITIAL_VAR_PRICE_WAD: z.coerce.bigint().default(300_000_000_000_000_000n),
  /** Liquidity minted into the fresh vol pool. */
  VOL_LIQUIDITY: z.coerce.bigint().default(20_000_000_000n),

  /** Whether the demo trading bot runs at all on a tick. */
  DEMO_BOT_ENABLED: z.enum(["0", "1"]).default("1"),
  /** Chance (0-1) a bot round trades the vol pool (moves implied vol) instead
   *  of the underlying measured pool (which is what the hook actually
   *  samples for realized variance) — kept a minority of rounds so realized
   *  variance stays the dominant source of activity. */
  DEMO_BOT_VOL_SWAP_PROB: z.coerce.number().min(0).max(1).default(0.2),
  DEMO_BOT_SWAP_SIZE_WAD: z.coerce.bigint().default(2_000_000_000_000_000_000n), // 2e18
  /** +/- this fraction of `DEMO_BOT_SWAP_SIZE_WAD`, so continuous operation
   *  does not look like a metronome. */
  DEMO_BOT_SWAP_SIZE_JITTER_PCT: z.coerce.number().min(0).max(1).default(0.4),

  /** If set, `serve` also runs an internal `runLoop` at this interval calling
   *  the same tick a ping would — so epochs keep rolling between pings, not
   *  only when something happens to hit the endpoint. Unset disables it,
   *  leaving the service purely ping-driven. */
  ROLLER_SELF_TICK_INTERVAL_MS: z.coerce.number().int().positive().optional(),
};

export type RollerConfig = z.infer<z.ZodObject<typeof rollerConfigShape>>;

export function loadRollerConfig(): RollerConfig {
  return loadConfig(rollerConfigShape);
}
