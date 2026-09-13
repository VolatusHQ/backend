/**
 * Settle the active epoch on `MEASURED_POOL_ID` once it has ended, open the
 * next one, and reseed that epoch's vol pool — a TypeScript port of
 * `contracts/script/SettleAndRoll.s.sol`, run automatically every tick
 * instead of by hand.
 *
 * Three steps, each independently idempotent (on-chain check first, journal
 * claim second, same shape as `reporter/src/settle.ts`):
 *
 *   1. settle    — `SigmaVault.settle(epochId)`, permissionless.
 *   2. openEpoch — `SigmaVault.openEpoch(poolId, ...)`, permissionless, copies
 *      the settled epoch's strike/cap unchanged (only endBlock/horizon are
 *      fresh) — exactly `SettleAndRoll.s.sol`'s behavior.
 *   3. reseedVolPool — mint a fresh pair, initialize a fresh VAR-LONG/USDC
 *      pool, `registerVolPool` (curator-gated — see `outcomes.ts`), seed
 *      liquidity. A failure here degrades the demo (no implied vol this
 *      epoch) but never blocks 1 or 2, which are the protocol-critical half.
 *
 * `activeEpoch(poolId)` resets to `0` the instant `settle` lands (it is not
 * "the last epoch", it is "the currently open one"), so which epoch to roll
 * next is found by walking `epochCount()` backward to the highest id whose
 * `poolId` matches — cheap at this demo's scale, and self-healing across a
 * crash between settle and openEpoch without any extra journal state.
 */

import {
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  erc20Abi,
  mintableErc20Abi,
  poolManagerAbi,
  poolModifyLiquidityTestAbi,
  sigmaOracleAbi,
  sigmaOracleVolPoolAbi,
  sigmaVaultAbi,
  LP_ROUTER,
  MOCK_USDC,
  POOL_MANAGER,
  SIGMA_ORACLE,
  SIGMA_VAULT,
} from "@volatus/onchain";
import type { AlertFn, Journal, Wallet } from "@volatus/service-kit";
import { SERVICE } from "./constants.js";
import { classifyInitializeRevert, classifyOpenEpochRevert, classifyRegisterVolPoolRevert, classifySettleRevert, FatalRollerError } from "./outcomes.js";
import { resolveClaim, type Logger } from "./journalReconcile.js";

const TICK_LOWER = -23040;
const TICK_UPPER = 0;
const VOL_POOL_FEE = 3000;
const VOL_POOL_TICK_SPACING = 60;
const ZERO_SALT: Hex = `0x${"0".repeat(64)}`;
const WAD = 10n ** 18n;

/** Floor(sqrt(value)) for a non-negative bigint — Newton's method, same
 *  result as OpenZeppelin's `Math.sqrt` used by `_sqrtPriceFor` in Solidity. */
function isqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let x0 = value;
  let x1 = (x0 + 1n) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) >> 1n;
  }
  return x0;
}

/** Sorted `PoolKey` for two currencies. No hook on the vol pool — matches
 *  `SettleAndRoll.s.sol`'s `_key`: implied vol is discovered by ordinary
 *  trading, nothing needs to observe this pool's swaps. */
export function poolKeyFor(a: Address, b: Address) {
  const [currency0, currency1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return { currency0, currency1, fee: VOL_POOL_FEE, tickSpacing: VOL_POOL_TICK_SPACING, hooks: zeroAddress } as const;
}

/** `sqrtPriceX96` for `longToken`'s price against `collateral`, given a WAD
 *  price of long-in-collateral — exact port of `_sqrtPriceFor`. */
export function sqrtPriceFor(longToken: Address, collateral: Address, priceWad: bigint): bigint {
  const ratioWad = longToken.toLowerCase() < collateral.toLowerCase() ? priceWad : (WAD * WAD) / priceWad;
  return isqrt((ratioWad * (1n << 192n)) / WAD);
}

function decodeEpochOpenedLogs(logs: Parameters<typeof parseEventLogs>[0]["logs"]) {
  return parseEventLogs({ abi: sigmaVaultAbi, eventName: "EpochOpened", logs });
}
function decodeEpochSettledLogs(logs: Parameters<typeof parseEventLogs>[0]["logs"]) {
  return parseEventLogs({ abi: sigmaVaultAbi, eventName: "EpochSettled", logs });
}

const readVaultEpoch = (client: PublicClient, epochId: bigint) =>
  client.readContract({ address: SIGMA_VAULT, abi: sigmaVaultAbi, functionName: "epoch", args: [epochId] });

/**
 * Highest epoch id whose `poolId` matches, or `null` if this pool has never
 * had an epoch opened for it — the roller does not bootstrap the very first
 * epoch on a pool, only roll an existing one. `maxScan` bounds the backward
 * walk so a pathologically large `epochCount()` (not expected at this
 * project's scale) cannot make a tick unboundedly slow; it is a safety bound,
 * not a correctness one.
 */
export async function findLatestEpochForPool(
  client: PublicClient,
  poolId: Hex,
  maxScan = 500,
): Promise<bigint | null> {
  const count = await client.readContract({ address: SIGMA_VAULT, abi: sigmaVaultAbi, functionName: "epochCount" });
  const floor = count > BigInt(maxScan) ? count - BigInt(maxScan) : 1n;
  for (let id = count; id >= floor && id >= 1n; id--) {
    const e = await readVaultEpoch(client, id);
    if (e.poolId.toLowerCase() === poolId.toLowerCase()) return id;
  }
  return null;
}

export interface RollDeps {
  client: PublicClient;
  wallet: Wallet;
  journal: Journal;
  logger: Logger;
  alert: AlertFn;
  poolId: Hex;
  nextEpochBlocks: bigint;
  nextHorizonSeconds: number;
  mintAmountUsdc: bigint;
  initialVarPriceWad: bigint;
  volLiquidity: bigint;
  dryRun: boolean;
  payoffRecheckAttempts?: number;
  payoffRecheckDelayMs?: number;
}

export interface RollResult {
  /** Whether a new epoch was opened this tick (settling alone does not count). */
  rolled: boolean;
  settledEpochId: bigint | null;
  newEpochId: bigint | null;
  volPoolRegistered: boolean;
}

const NOOP: RollResult = { rolled: false, settledEpochId: null, newEpochId: null, volPoolRegistered: false };

export async function rollIfEnded(deps: RollDeps): Promise<RollResult> {
  const { client, journal, logger, poolId } = deps;

  const epochId = await findLatestEpochForPool(client, poolId);
  if (epochId === null) {
    logger.info("no epoch found for this pool yet -- bootstrap the first one by hand, the roller only rolls", {
      poolId,
    });
    return NOOP;
  }

  let e = await readVaultEpoch(client, epochId);
  let settledByUsThisTick = false;

  if (!e.settled) {
    const currentBlock = await client.getBlockNumber();
    if (currentBlock < e.endBlock) {
      // Not ended yet -- but `reseedVolPool` only ever runs in the same tick
      // as opening a new epoch, so if *that* attempt failed (RPC lag right
      // after the openEpoch tx is the observed real-world cause -- the same
      // class of staleness `settle.ts` documents), nothing else would ever
      // retry it before this epoch ends and rolls again, potentially
      // `nextEpochBlocks` worth of time with no implied vol to show or
      // trade. Cheap to check every tick (one extra read when already
      // registered, via `resolveClaim`'s on-chain check) and self-heals the
      // moment the RPC catches up.
      const registered = await reseedVolPool({ ...deps, newEpochId: epochId, longToken: e.longToken });
      logger.info(`epoch ${epochId} not yet over, nothing to roll`, {
        epochId: epochId.toString(),
        endBlock: e.endBlock.toString(),
        currentBlock: currentBlock.toString(),
        volPoolRegistered: registered,
      });
      return { rolled: false, settledEpochId: null, newEpochId: null, volPoolRegistered: registered };
    }

    const settled = await settleEpoch({ ...deps, epochId, e });
    if (!settled) return NOOP; // logged/journaled inside settleEpoch; try again next tick
    e = await readVaultEpoch(client, epochId); // re-read: settled/payoffWad now current
    settledByUsThisTick = true;
  }

  // `VolatusVault.settle` sets `activeEpoch[poolId] = 0` unconditionally in
  // the same transaction (contracts/src/VolatusVault.sol), so if WE just
  // settled it above there is nothing to re-check -- it is 0, full stop. A
  // fresh read here would just be re-exposed to the same RPC read-lag
  // `settle.ts` documents elsewhere, and did in fact return a stale non-zero
  // value in testing. Only re-check when we did *not* settle it ourselves
  // this tick (i.e. some earlier tick or another instance settled it, and we
  // need to know whether they also already rolled it).
  if (!settledByUsThisTick) {
    const activeNow = await client.readContract({ address: SIGMA_VAULT, abi: sigmaVaultAbi, functionName: "activeEpoch", args: [poolId] });
    if (activeNow !== 0n) {
      logger.info(`epoch ${epochId} already settled and epoch ${activeNow} is already open -- nothing to roll`, {
        settledEpochId: epochId.toString(),
        activeEpochId: activeNow.toString(),
      });
      return { rolled: false, settledEpochId: epochId, newEpochId: null, volPoolRegistered: false };
    }
  }

  const opened = await openNextEpoch({ ...deps, oldEpochId: epochId, settledEpoch: e });
  if (!opened) return { rolled: false, settledEpochId: epochId, newEpochId: null, volPoolRegistered: false };

  const registered = await reseedVolPool({ ...deps, newEpochId: opened.epochId, longToken: opened.longToken });

  return { rolled: true, settledEpochId: epochId, newEpochId: opened.epochId, volPoolRegistered: registered };
}

/* -------------------------------------------------------------------- */
/* Step 1 — settle                                                       */
/* -------------------------------------------------------------------- */

async function settleEpoch(params: RollDeps & { epochId: bigint; e: Awaited<ReturnType<typeof readVaultEpoch>> }): Promise<boolean> {
  const { client, wallet, journal, logger, alert, epochId, dryRun } = params;
  const key = epochId.toString();

  if (dryRun) {
    logger.info(`[dry run] would call settle(${key})`, { epochId: key });
    return false;
  }

  const decision = await resolveClaim({
    journal,
    service: SERVICE,
    action: "settle",
    key,
    publicClient: client,
    isDoneOnChain: async () => (await readVaultEpoch(client, epochId)).settled,
    logger,
  });
  if (!decision.proceed) {
    logger.info(`skipping settle(${key}): ${decision.reason}`, { epochId: key });
    return (await readVaultEpoch(client, epochId)).settled;
  }

  const result = await wallet.send({
    address: SIGMA_VAULT,
    abi: sigmaVaultAbi,
    functionName: "settle",
    args: [epochId],
  });

  if (result.ok) {
    let e = await readVaultEpoch(client, epochId);
    const decoded = decodeEpochSettledLogs(result.receipt.logs).find((l) => l.args.epochId === epochId);

    // Unichain's RPC serves reads from behind the head -- same lag
    // `reporter/src/settle.ts` documents and works around.
    if (decoded && decoded.args.payoff !== e.payoffWad) {
      const attempts = params.payoffRecheckAttempts ?? 10;
      const delayMs = params.payoffRecheckDelayMs ?? 1_500;
      for (let attempt = 0; attempt < attempts && decoded.args.payoff !== e.payoffWad; attempt++) {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        e = await readVaultEpoch(client, epochId);
      }
    }
    if (decoded && decoded.args.payoff !== e.payoffWad) {
      await alert(
        "error",
        `roller: settle(${key}) succeeded but EpochSettled's payoff (${decoded.args.payoff}) disagrees with epoch(${key}).payoffWad (${e.payoffWad}) -- refusing to roll past this epoch`,
        { epochId: key },
      );
      journal.recordFailed(SERVICE, "settle", key, "payoff mismatch between EpochSettled event and epoch() read");
      return false;
    }

    journal.recordDone(SERVICE, "settle", key, result.hash, { payoffWad: e.payoffWad.toString() });
    logger.info(`settle(${key}) landed`, { epochId: key, hash: result.hash, payoffWad: e.payoffWad.toString() });
    return true;
  }

  const outcome = classifySettleRevert(result.revertName);
  if (outcome.kind === "success") {
    journal.recordDone(SERVICE, "settle", key, "already-settled-onchain", { reconciled: true });
    return true;
  }
  journal.recordFailed(SERVICE, "settle", key, result.reason);
  logger.warn(`settle(${key}) failed, will retry next tick`, { epochId: key, reason: result.reason });
  return false;
}

/* -------------------------------------------------------------------- */
/* Step 2 — open the next epoch                                          */
/* -------------------------------------------------------------------- */

interface OpenedEpoch {
  epochId: bigint;
  longToken: Address;
  shortToken: Address;
}

async function openNextEpoch(
  params: RollDeps & { oldEpochId: bigint; settledEpoch: Awaited<ReturnType<typeof readVaultEpoch>> },
): Promise<OpenedEpoch | null> {
  const { client, wallet, journal, logger, alert, oldEpochId, settledEpoch, poolId, dryRun } = params;
  const key = `after:${oldEpochId}`;

  if (dryRun) {
    logger.info(`[dry run] would call openEpoch(...) rolling past epoch ${oldEpochId}`, { oldEpochId: oldEpochId.toString() });
    return null;
  }

  const isDoneOnChain = async () =>
    (await client.readContract({ address: SIGMA_VAULT, abi: sigmaVaultAbi, functionName: "activeEpoch", args: [poolId] })) !== 0n;

  const decision = await resolveClaim({ journal, service: SERVICE, action: "openEpoch", key, publicClient: client, isDoneOnChain, logger });
  if (!decision.proceed) {
    logger.info(`skipping openEpoch after ${oldEpochId}: ${decision.reason}`, { oldEpochId: oldEpochId.toString() });
    return null;
  }

  const currentBlock = await client.getBlockNumber();
  const endBlock = currentBlock + params.nextEpochBlocks;

  const result = await wallet.send({
    address: SIGMA_VAULT,
    abi: sigmaVaultAbi,
    functionName: "openEpoch",
    args: [poolId, endBlock, params.nextHorizonSeconds, settledEpoch.strikeWad, settledEpoch.capWad],
  });

  if (result.ok) {
    const decoded = decodeEpochOpenedLogs(result.receipt.logs)[0];
    if (!decoded) {
      // The tx landed but we cannot see the event -- do not guess the new id.
      journal.recordFailed(SERVICE, "openEpoch", key, "openEpoch landed but no EpochOpened log was found in the receipt");
      await alert("error", `roller: openEpoch after ${oldEpochId} landed (${result.hash}) but its EpochOpened log was not found`, {});
      return null;
    }
    journal.recordDone(SERVICE, "openEpoch", key, result.hash, { epochId: decoded.args.epochId.toString() });
    logger.info(`openEpoch after ${oldEpochId} landed -- new epoch ${decoded.args.epochId}`, {
      oldEpochId: oldEpochId.toString(),
      newEpochId: decoded.args.epochId.toString(),
      hash: result.hash,
    });
    return { epochId: decoded.args.epochId, longToken: decoded.args.longToken, shortToken: decoded.args.shortToken };
  }

  const outcome = classifyOpenEpochRevert(result.revertName);
  if (outcome.kind === "success") {
    // `PoolAlreadyHasAnActiveEpoch` also comes back when the simulation runs
    // against a node still behind our own `settle` — it sees the epoch we just
    // closed as active. Journaling that as done blocks this roll for good, so
    // only accept it once a newer epoch is actually visible.
    const activeNow = await client.readContract({ address: SIGMA_VAULT, abi: sigmaVaultAbi, functionName: "activeEpoch", args: [poolId] });
    if (activeNow > oldEpochId) {
      journal.recordDone(SERVICE, "openEpoch", key, "already-open-onchain", { reconciled: true, activeEpochId: activeNow.toString() });
      return null; // someone else's epoch is now active; nothing for this tick to reseed
    }
    journal.recordFailed(SERVICE, "openEpoch", key, `PoolAlreadyHasAnActiveEpoch but activeEpoch reads ${activeNow} -- lagging read, retrying`);
    logger.warn(`openEpoch after ${oldEpochId} hit a lagging read of the epoch we just settled, will retry next tick`, {
      oldEpochId: oldEpochId.toString(),
      activeNow: activeNow.toString(),
    });
    return null;
  }
  if (outcome.kind === "fatal") {
    journal.recordFailed(SERVICE, "openEpoch", key, outcome.reason);
    await alert("error", `roller: FATAL -- ${outcome.reason}`, { oldEpochId: oldEpochId.toString() });
    throw new FatalRollerError(outcome.reason);
  }
  journal.recordFailed(SERVICE, "openEpoch", key, result.reason);
  logger.warn(`openEpoch after ${oldEpochId} failed, will retry next tick`, { oldEpochId: oldEpochId.toString(), reason: result.reason });
  return null;
}

/* -------------------------------------------------------------------- */
/* Step 3 — reseed the new epoch's vol pool                              */
/* -------------------------------------------------------------------- */

async function reseedVolPool(params: RollDeps & { newEpochId: bigint; longToken: Address }): Promise<boolean> {
  const { client, wallet, journal, logger, alert, newEpochId, longToken, dryRun } = params;
  const key = newEpochId.toString();

  if (dryRun) {
    logger.info(`[dry run] would reseed the vol pool for epoch ${newEpochId}`, { epochId: key });
    return false;
  }

  const isDoneOnChain = async () => {
    const vp = await client.readContract({ address: SIGMA_ORACLE, abi: sigmaOracleVolPoolAbi, functionName: "volPool", args: [newEpochId] });
    return vp.registered;
  };

  const decision = await resolveClaim({ journal, service: SERVICE, action: "reseedVolPool", key, publicClient: client, isDoneOnChain, logger });
  if (!decision.proceed) {
    logger.info(`skipping vol-pool reseed for epoch ${key}: ${decision.reason}`, { epochId: key });
    return await isDoneOnChain();
  }

  // From here on, `journal` already holds this claim `in_flight` (set by
  // `resolveClaim` above). Any throw between here and the next `recordDone`/
  // `recordFailed` -- a transient RPC error on one of the plain `readContract`
  // calls below being the observed real-world case -- would otherwise leave
  // that row stuck `in_flight` with no tx hash forever: `resolveClaim`'s own
  // contract refuses to ever auto-retry that state (journalReconcile.ts), so
  // nothing short of an operator manually clearing the journal recovers.
  // Catching here and recording `failed` instead keeps a network blip a
  // one-tick delay, per the journal's documented "failed is reclaimable" rule.
  try {
    return await reseedVolPoolSteps({ ...params, key, longToken });
  } catch (error) {
    journal.recordFailed(SERVICE, "reseedVolPool", key, error);
    logger.warn(`reseedVolPool(${key}) threw before completing, will retry next tick`, {
      epochId: key,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function reseedVolPoolSteps(
  params: RollDeps & { newEpochId: bigint; longToken: Address; key: string },
): Promise<boolean> {
  const { client, wallet, journal, logger, alert, newEpochId, longToken, key } = params;

  const volKey = poolKeyFor(longToken, MOCK_USDC);
  const sqrtPriceX96 = sqrtPriceFor(longToken, MOCK_USDC, params.initialVarPriceWad);

  // Mint fresh collateral, mint the epoch's pair, initialize the vol pool,
  // register it, then seed liquidity. Each `send` is awaited in order --
  // mirrors `SettleAndRoll.s.sol`'s single broadcast batch, just as
  // sequential transactions instead of one script invocation.
  const steps: Array<{ label: string; send: () => ReturnType<Wallet["send"]> }> = [
    {
      label: "mint USDC",
      send: () => wallet.send({ address: MOCK_USDC, abi: mintableErc20Abi, functionName: "mint", args: [wallet.address, params.mintAmountUsdc * 2n] }),
    },
    {
      label: "approve vault",
      send: () => wallet.send({ address: MOCK_USDC, abi: erc20Abi, functionName: "approve", args: [SIGMA_VAULT, params.mintAmountUsdc] }),
    },
    {
      label: "mintPair",
      send: () => wallet.send({ address: SIGMA_VAULT, abi: sigmaVaultAbi, functionName: "mintPair", args: [newEpochId, params.mintAmountUsdc] }),
    },
    {
      label: "initialize vol pool",
      send: () => wallet.send({ address: POOL_MANAGER, abi: poolManagerAbi, functionName: "initialize", args: [volKey, sqrtPriceX96] }),
    },
    {
      label: "registerVolPool",
      send: () => wallet.send({ address: SIGMA_ORACLE, abi: sigmaOracleAbi, functionName: "registerVolPool", args: [newEpochId, volKey] }),
    },
    {
      label: "approve long leg to LP router",
      send: () => wallet.send({ address: longToken, abi: erc20Abi, functionName: "approve", args: [LP_ROUTER, params.mintAmountUsdc] }),
    },
    {
      label: "approve USDC to LP router",
      send: () => wallet.send({ address: MOCK_USDC, abi: erc20Abi, functionName: "approve", args: [LP_ROUTER, params.mintAmountUsdc] }),
    },
    {
      label: "seed vol pool liquidity",
      send: () =>
        wallet.send({
          address: LP_ROUTER,
          abi: poolModifyLiquidityTestAbi,
          functionName: "modifyLiquidity",
          args: [
            volKey,
            { tickLower: TICK_LOWER, tickUpper: TICK_UPPER, liquidityDelta: params.volLiquidity, salt: ZERO_SALT },
            "0x",
          ],
        }),
    },
  ];

  // A retry after a later step failed must not mint a second pair: the first
  // attempt's mintPair already landed if the wallet holds this epoch's long leg
  // (nothing else gives it any before the pool is seeded).
  const longHeld = await client.readContract({ address: longToken, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address] });
  const toRun = longHeld > 0n ? steps.filter((s) => !["mint USDC", "approve vault", "mintPair"].includes(s.label)) : steps;

  for (const step of toRun) {
    const result = await step.send();
    if (result.ok) continue;

    // initialize is one-shot per pool key: a retry after a later step failed
    // in an earlier attempt hits this every time otherwise, permanently
    // stuck re-attempting a call that already succeeded -- see outcomes.ts.
    if (step.label === "initialize vol pool" && classifyInitializeRevert(result.revertName).kind === "success") {
      continue;
    }

    // registerVolPool is the one step whose failure mode is well-understood
    // (curator mismatch) and must not block future epochs -- see outcomes.ts.
    if (step.label === "registerVolPool") {
      const outcome = classifyRegisterVolPoolRevert(result.revertName);
      if (outcome.kind === "success") continue;
      if (outcome.kind === "terminal") {
        journal.recordDone(SERVICE, "reseedVolPool", key, "terminal-failure", { step: step.label, reason: outcome.reason });
        await alert("warn", `roller: epoch ${key} -- ${outcome.reason}`, { epochId: key });
        logger.warn(`reseedVolPool(${key}) stopped at ${step.label}, will never retry this epoch`, { epochId: key, reason: outcome.reason });
        return false;
      }
    }

    journal.recordFailed(SERVICE, "reseedVolPool", key, `${step.label}: ${result.reason}`);
    logger.warn(`reseedVolPool(${key}) failed at ${step.label}, will retry next tick`, { epochId: key, reason: result.reason });
    return false;
  }

  journal.recordDone(SERVICE, "reseedVolPool", key, "seeded", { volPoolKey: volKey });
  logger.info(`vol pool reseeded for epoch ${key}`, { epochId: key, volPoolKey: volKey });
  return true;
}
