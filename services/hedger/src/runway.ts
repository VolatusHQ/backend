/**
 * Ported verbatim from `services/keeper/src/project.ts`, per the brief:
 * "`services/keeper/src/project.ts` exports `projectSubscription`, the pure
 * off-chain mirror of `_sync` — use it for runway reasoning instead of
 * writing your own." Copied rather than imported because `@volatus/keeper`'s
 * package entrypoint (`src/index.ts`) runs a CLI `main()` as an import-time
 * side effect and loads its own required env at module scope — it is a
 * program, not a library, so nothing outside `services/keeper` should
 * `import` it. The arithmetic below is unchanged; see the original for the
 * full rationale (it mirrors `SigmaStream._sync` branch-for-branch,
 * including the "ran dry partway through" case) and its test suite.
 *
 * `fundGate.ts` is this file's only caller here: the hedger needs exactly
 * the same "how much runway does this subscription actually have left"
 * question the keeper's gas gate asks, projected forward without a
 * transaction.
 */

export interface SubscriptionSnapshot {
  ratePerSecond: bigint;
  funded: bigint;
  lastSync: bigint;
  coveredSeconds: bigint;
}

export interface ProjectedSubscription {
  /** min(nowTs, coverageEnd) — the instant this projection is computed as of. */
  asOf: bigint;
  /** asOf - lastSync, clamped to >= 0. Zero means a real `sync` right now would be a no-op. */
  elapsedSeconds: bigint;
  /** Seconds actually billable in [lastSync, asOf] — equal to elapsedSeconds unless funded ran out first. */
  paidSeconds: bigint;
  /** Premium that would move from `funded` into `capacityPool` if synced right now. */
  accruedPremium: bigint;
  /** `funded` projected forward to `asOf`. */
  funded: bigint;
  /** `coveredSeconds` projected forward to `asOf`. */
  coveredSeconds: bigint;
  /** True when paidSeconds < elapsedSeconds: the balance would run dry before `asOf`. */
  ranDry: boolean;
  /** Projected `funded` / `ratePerSecond` — seconds of runway remaining beyond `asOf`. 0 if ratePerSecond is 0. */
  runwaySeconds: bigint;
}

/**
 * Project `sub` forward to `min(nowTs, coverageEnd)`. Read `_sync` in
 * `contracts/src/SigmaStream.sol` before touching this function — every
 * branch below has a corresponding line there, in the same order.
 */
export function projectSubscription(
  sub: SubscriptionSnapshot,
  nowTs: bigint,
  coverageEnd: bigint,
): ProjectedSubscription {
  const asOf = nowTs < coverageEnd ? nowTs : coverageEnd;

  // `_sync` returns immediately for a rate of zero (cancelled, or never
  // subscribed) without touching lastSync/funded/coveredSeconds at all.
  if (sub.ratePerSecond === 0n) {
    return {
      asOf,
      elapsedSeconds: 0n,
      paidSeconds: 0n,
      accruedPremium: 0n,
      funded: sub.funded,
      coveredSeconds: sub.coveredSeconds,
      ranDry: false,
      runwaySeconds: 0n,
    };
  }

  // `_sync`: `if (upTo <= s.lastSync) return;` — nothing has elapsed yet.
  if (asOf <= sub.lastSync) {
    return {
      asOf,
      elapsedSeconds: 0n,
      paidSeconds: 0n,
      accruedPremium: 0n,
      funded: sub.funded,
      coveredSeconds: sub.coveredSeconds,
      ranDry: false,
      runwaySeconds: sub.funded / sub.ratePerSecond,
    };
  }

  const elapsedSeconds = asOf - sub.lastSync;
  const owed = elapsedSeconds * sub.ratePerSecond;

  let paidSeconds: bigint;
  let accruedPremium: bigint;
  if (owed <= sub.funded) {
    paidSeconds = elapsedSeconds;
    accruedPremium = owed;
  } else {
    // Ran dry partway through — cover only what the balance actually buys,
    // same integer division `_sync` uses (`s.funded / s.ratePerSecond`).
    paidSeconds = sub.funded / sub.ratePerSecond;
    accruedPremium = paidSeconds * sub.ratePerSecond;
  }

  const funded = sub.funded - accruedPremium;
  return {
    asOf,
    elapsedSeconds,
    paidSeconds,
    accruedPremium,
    funded,
    coveredSeconds: sub.coveredSeconds + paidSeconds,
    ranDry: paidSeconds < elapsedSeconds,
    runwaySeconds: funded / sub.ratePerSecond,
  };
}
