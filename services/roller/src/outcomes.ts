/**
 * Every custom-error revert this service can hit, mapped to exactly one of
 * four behaviours — same vocabulary as `reporter/src/outcomes.ts`, adapted to
 * the contracts this service actually calls (`SigmaVault`, `VolatusOracle`,
 * `PoolManager`, `PoolModifyLiquidityTest` — all on Unichain, never
 * `SigmaStream` on Arc, which is `reporter`'s surface, not this one's).
 *
 *   - `success` — the desired end state already holds (a permissionless call
 *     someone else made first, or an earlier attempt of ours). Journal it
 *     `done`, move on.
 *   - `retry`   — transient. Leave the journal record `failed` (reclaimable)
 *     and try again next tick.
 *   - `terminal`— permanent for this one action, but must NOT stop the whole
 *     service. `settle`/`openEpoch` are permissionless and have to keep
 *     working every future epoch regardless of what happens to the vol-pool
 *     reseed — a demo-liveliness feature, not the protocol-critical half.
 *     Journal it `done` (never retried — retrying an unchanged config can
 *     only revert the same way, forever) and alert once.
 *   - `fatal`   — a configuration or code bug, not chain state, and one that
 *     would recur identically on every future attempt. Alarm loudly and stop
 *     the service, same as `reporter`'s `FatalReporterError`.
 */

export type RevertOutcome =
  | { kind: "success" }
  | { kind: "retry" }
  | { kind: "terminal"; reason: string }
  | { kind: "fatal"; reason: string };

/** `SigmaVault.settle` — permissionless, not curator- or reporter-gated. */
export function classifySettleRevert(revertName: string | undefined): RevertOutcome {
  switch (revertName) {
    case "AlreadySettled":
      // Some other permissionless caller (or an earlier attempt of ours that
      // landed after we timed out waiting) settled it first.
      return { kind: "success" };
    case "EpochNotOver":
      // We gate on `currentBlock >= endBlock` before calling settle, so this
      // is only reachable via a race at the boundary block. Back off.
      return { kind: "retry" };
    case "NoSuchEpoch":
      // Read live from `activeEpoch(poolId)`, so the epoch exists; an RPC
      // serving a stale/lagging view is the only realistic cause. Retry.
      return { kind: "retry" };
    default:
      return { kind: "retry" };
  }
}

/** `SigmaVault.openEpoch` — permissionless. Distinct from `SigmaStream.openEpoch`
 *  on Arc, which is `reporter`'s surface and keys on the unrelated `EpochExists`. */
export function classifyOpenEpochRevert(revertName: string | undefined): RevertOutcome {
  switch (revertName) {
    case "PoolAlreadyHasAnActiveEpoch":
      // Someone else (another roller instance, a manual script) already
      // rolled this pool to its next epoch. Nothing more to do here.
      return { kind: "success" };
    case "EndBlockInPast":
      // We compute `endBlock` as `currentBlock + NEXT_EPOCH_BLOCKS` right
      // before sending; only reachable via a genuine race at the read. Retry.
      return { kind: "retry" };
    case "InvalidRange":
    case "ZeroHorizon":
    case "ZeroAddress":
      // We copy strike/cap from the epoch that just settled and only compute
      // endBlock/horizon fresh (mirrors `SettleAndRoll.s.sol`) -- a revert
      // here means those copied values or our own horizon computation are
      // wrong, which is a bug in this service, not chain state. Every future
      // roll would fail the same way.
      return {
        kind: "fatal",
        reason: `${revertName}: openEpoch's computed arguments are invalid -- this is a bug in roll.ts, not chain state`,
      };
    default:
      return { kind: "retry" };
  }
}

/** `PoolManager.initialize` — one-shot per pool key (`Pool.sol:47`,
 *  `PoolAlreadyInitialized`). `reseedVolPool` retries its whole step
 *  sequence from scratch on any failure, so a repeat `initialize` call
 *  after an earlier attempt's later step failed is expected, not an error. */
export function classifyInitializeRevert(revertName: string | undefined): RevertOutcome {
  if (revertName === "PoolAlreadyInitialized") return { kind: "success" };
  return { kind: "retry" };
}

/** `VolatusOracle.registerVolPool` — curator-only, one-shot per epoch. */
export function classifyRegisterVolPoolRevert(revertName: string | undefined): RevertOutcome {
  switch (revertName) {
    case "AlreadyRegistered":
      return { kind: "success" };
    case "NotCurator":
      // Scoped to this one action, deliberately not `fatal`: settle/openEpoch
      // are permissionless and must keep rolling every future epoch even if
      // ROLLER_PRIVATE_KEY does not (or no longer) match VolatusOracle's
      // curator. A wrong key here just means no implied vol / no vol-pool
      // trading for this epoch onward -- degraded, not broken.
      return {
        kind: "terminal",
        reason:
          "NotCurator: ROLLER_PRIVATE_KEY does not match VolatusOracle.curator() -- " +
          "this epoch (and every one after it, until fixed) will settle and roll normally " +
          "but will have no registered vol pool: no implied volatility, nothing to trade.",
      };
    case "LegNotInPool":
      // The vol pool key we built doesn't actually contain the epoch's own
      // VAR-LONG leg -- a bug in how roll.ts constructs the PoolKey.
      return {
        kind: "fatal",
        reason: "LegNotInPool: the vol pool key built for registerVolPool does not contain this epoch's VAR-LONG -- bug in roll.ts",
      };
    case "NoActiveEpoch":
    case "NoVolPool":
    case "VolPoolNotInitialized":
      // Reachable only via a race with the epoch/pool-init calls this same
      // tick just sent (e.g. `PoolManager.initialize`'s effect not yet
      // visible to a lagging read). Retry.
      return { kind: "retry" };
    default:
      return { kind: "retry" };
  }
}

/**
 * Thrown out of a tick to stop the whole service — reserved for `fatal`
 * outcomes only. A `terminal` outcome (see `classifyRegisterVolPoolRevert`)
 * never throws this; it degrades one feature, not the service.
 */
export class FatalRollerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalRollerError";
  }
}
