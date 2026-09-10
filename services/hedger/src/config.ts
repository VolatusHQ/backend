/**
 * The hedger's environment, layered on `@volatus/service-kit`'s `loadConfig`
 * — same idiom as `services/keeper/src/config.ts`: this service declares
 * exactly what it needs rather than pulling in `commonConfigShape` wholesale,
 * so it can never be started with the reporter's or keeper's key loaded by
 * accident.
 *
 * **Where the mandate's field values come from, and why env is honest here.**
 * PHASES.md/BACKEND_HANDOFF.md ask for a mandate that is "typed and
 * persisted" with cumulative spend "tracked in the journal so a restart
 * cannot forget it." This service is a single-mandate demo process, not a
 * multi-tenant mandate store — there is no user-facing mandate-creation flow
 * in scope here (that would live in `apps/web`, out of bounds for this
 * service). So the mandate's *shape* is typed (`mandate.ts`'s `Mandate`) and
 * its *immutable field values* are boot-time configuration, exactly like
 * every other tuning constant the keeper and reporter already load this way
 * (`KEEPER_SAFETY_FACTOR`, `REPORT_DEADLINE_MARGIN_SECONDS`, ...). The part
 * that actually must survive a restart — cumulative spend — is the one
 * BACKEND_HANDOFF.md calls out by name, and that lives in the journal
 * (`spend.ts`), not in this file or in process memory.
 *
 * Defaults below match the live demo state BRIEF.md documents: epoch 2 on
 * the measured pool, owned by the deployer/demo LP
 * `0x7975E591...080c`, currently subscribed at `ratePerSecond 100`,
 * `coverageNotional 4000000`. A real deployment overrides every
 * `HEDGER_MANDATE_*` var per user/mandate; nothing here is meant to be the
 * only mandate this code could ever run.
 */

import { z } from "zod";
import { loadConfig, optionalUrlSchema, privateKeySchema, rpcUrlSchema } from "@volatus/service-kit";
import { ARC_USDC, MEASURED_POOL_ID, SIGMA_STREAM } from "@volatus/onchain";
import type { Address, Hex } from "viem";
import type { Mandate } from "./mandate.js";

/**
 * `SigmaVault`'s Unichain deploy block (same value `services/reporter`
 * independently declares as `MEASURED_VAULT_DEPLOY_BLOCK`, from
 * `contracts/broadcast/DeployTestnet.s.sol/1301/run-latest.json`). No v4
 * position relevant to this protocol can predate it, so it is the honest
 * floor for the position log scan (`position.ts`) — declared again here
 * rather than imported across the service boundary (see `runway.ts`'s
 * header for why services in this repo do not import each other's
 * internals).
 */
export const MEASURED_VAULT_DEPLOY_BLOCK = 61_561_322n;

/**
 * The demo LP + underwriter address. Updated 2026-09-10: the previous address,
 * `0x7975E591c26e6c6D9B0CFd9A81f6d61A921C080c`, has no subscription on the
 * redeployed `VolatusStream` (`0xE44b6a47b29b097CE5c20BF17830cfb5df734354`) —
 * a fresh contract starts with zero subscribers, zero capacity. This is the
 * keeper's own operational wallet, real-subscribed on-chain: `postCapacity`
 * (10 USDC), `subscribe(epochId 2, rate 55, notional 4 USDC)`, `fund` (4 USDC),
 * all three confirmed on Arc. Not a secret; it is a public address.
 */
export const DEMO_OWNER_ADDRESS: Address = "0xD717489b5A7CC47dF2a8057ce4658002026FE5de";

export const hedgerConfigShape = {
  UNICHAIN_SEPOLIA_RPC: rpcUrlSchema,
  ARC_TESTNET_RPC: rpcUrlSchema,
  JOURNAL_PATH: z.string().optional(),
  ALERT_WEBHOOK_URL: optionalUrlSchema,

  /** "1" runs a tick read-only: logs what it would adjust/fund and why, sends nothing. */
  DRY_RUN: z.enum(["0", "1"]).default("0"),

  /** How often `start` re-evaluates the mandate. */
  HEDGER_TICK_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),

  /** Floor for the v4 position `Transfer` log scan — see `MEASURED_VAULT_DEPLOY_BLOCK` above. */
  HEDGER_POSITION_SCAN_START_BLOCK: z.coerce.bigint().default(MEASURED_VAULT_DEPLOY_BLOCK),

  /**
   * Gates `delegation/localSigner.ts` — must be exactly `"1"`. Unset by
   * default, so a normal `start`/`status` run can never reach the local
   * signer by accident; only the explicit one-shot demonstration
   * (`once`, see index.ts and README.md § Verification) sets it.
   */
  HEDGER_ALLOW_LOCAL_SIGNER: z.string().optional(),
  /** The key `localSigner.ts` uses when the flag above is set — testnet only, never a user's key. See README.md § Delegation. */
  DEPLOYER_PRIVATE_KEY: privateKeySchema.optional(),

  /**
   * Which `Signer` implementation `index.ts` builds for `start`/`once`.
   * `"local"` (default) is the testnet demonstration path above. `"privy"`
   * is the production delegation path (`delegation/privySessionSigner.ts` +
   * `delegation/privyClient.ts`) and requires `PRIVY_APP_ID`,
   * `PRIVY_APP_SECRET` and `PRIVY_WALLET_ID` — the last one comes from
   * running `scripts/provisionPrivy.ts` once, which also creates the policy
   * the wallet is bound to.
   */
  HEDGER_SIGNER_MODE: z.enum(["local", "privy"]).default("local"),
  PRIVY_APP_ID: z.string().optional(),
  PRIVY_APP_SECRET: z.string().optional(),
  /** The wallet id `scripts/provisionPrivy.ts` printed — not the wallet's address. */
  PRIVY_WALLET_ID: z.string().optional(),
  /** Must match `policy/sigma-hedger-v1.json`'s `policyId` unless a rotated successor was provisioned. */
  PRIVY_POLICY_ID: z.string().default("sigma-hedger-v1"),

  /* ---- Mandate fields: see this file's header for why these are env-configured. ---- */
  HEDGER_MANDATE_ID: z.string().default("demo-epoch2"),
  HEDGER_OWNER_ADDRESS: z.string().default(DEMO_OWNER_ADDRESS),
  HEDGER_POOL_ID: z.string().default(MEASURED_POOL_ID),
  HEDGER_EPOCH_ID: z.coerce.bigint().default(2n),

  HEDGER_BASE_RATE_PER_SECOND: z.coerce.bigint().default(100n),
  HEDGER_REFERENCE_IV_WAD: z.coerce.bigint().default(10n ** 18n),
  HEDGER_MAX_RATE_PER_SECOND: z.coerce.bigint().default(100_000n),

  HEDGER_BASE_COVERAGE_NOTIONAL: z.coerce.bigint().default(4_000_000n),
  HEDGER_MAX_COVERAGE_NOTIONAL: z.coerce.bigint().default(8_000_000n),

  HEDGER_DRIFT_TOLERANCE_BPS: z.coerce.number().int().nonnegative().default(500),
  HEDGER_RUNWAY_FLOOR_SECONDS: z.coerce.bigint().default(300n),
  HEDGER_FUND_TOPUP_USDC: z.coerce.bigint().default(1_000_000n),
  HEDGER_MAX_CUMULATIVE_SPEND_USDC: z.coerce.bigint().default(5_000_000n),

  /** Added to "now" at boot to compute `Mandate.expiresAt`. A real mandate-creation flow would set an absolute expiry instead. */
  HEDGER_MANDATE_TTL_SECONDS: z.coerce.bigint().default(30n * 86_400n),
};

export type HedgerConfig = z.infer<z.ZodObject<typeof hedgerConfigShape>>;

export function loadHedgerConfig(): HedgerConfig {
  return loadConfig(hedgerConfigShape);
}

/** `nowTs` is a parameter, not `Date.now()` internally, so this stays testable and so `expiresAt` is computed once per boot, not per call. */
export function mandateFromConfig(config: HedgerConfig, nowTs: bigint): Mandate {
  return {
    id: config.HEDGER_MANDATE_ID,
    owner: config.HEDGER_OWNER_ADDRESS as Address,
    poolId: config.HEDGER_POOL_ID as Hex,
    epochId: config.HEDGER_EPOCH_ID,
    streamAddress: SIGMA_STREAM,
    usdcAddress: ARC_USDC,
    baseRatePerSecond: config.HEDGER_BASE_RATE_PER_SECOND,
    referenceIvWad: config.HEDGER_REFERENCE_IV_WAD,
    maxRatePerSecond: config.HEDGER_MAX_RATE_PER_SECOND,
    baseCoverageNotional: config.HEDGER_BASE_COVERAGE_NOTIONAL,
    maxCoverageNotional: config.HEDGER_MAX_COVERAGE_NOTIONAL,
    driftToleranceBps: config.HEDGER_DRIFT_TOLERANCE_BPS,
    runwayFloorSeconds: config.HEDGER_RUNWAY_FLOOR_SECONDS,
    fundTopUpUsdc: config.HEDGER_FUND_TOPUP_USDC,
    maxCumulativeSpendUsdc: config.HEDGER_MAX_CUMULATIVE_SPEND_USDC,
    expiresAt: nowTs + config.HEDGER_MANDATE_TTL_SECONDS,
  };
}
