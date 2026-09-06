/**
 * Off-chain projection of what `SigmaStream._sync` (contracts/src/SigmaStream.sol)
 * would do if called right now. This mirrors that function's arithmetic
 * exactly, including the "ran dry partway through" branch, rather than
 * approximating it — the acceptance criterion for Service 2 is that
 * `capacityPool` grows by exactly `elapsed × ratePerSecond`, and a projection
 * that isn't bit-for-bit the same as the contract would eventually disagree
 * with it.
 *
 * `coveredSeconds` and `funded` between two real syncs are a deterministic
 * function of `lastSync`, `ratePerSecond` and the clock (BACKEND_HANDOFF.md
 * §Service 2, BRIEF.md's measured section) — so this same function serves two
 * callers with different needs from one implementation:
 *
 *   - a frontend meter, which extrapolates a live, smoothly-decreasing number
 *     between keeper ticks without ever sending a transaction;
 *   - the keeper's own gas gate (`gate.ts`), which needs to know how much
 *     premium a real `sync` would actually move before deciding whether
 *     sending one is worth the gas.
 *
 * Nothing here calls the chain. `now` and `coverageEnd` are both unix
 * seconds, matching `block.timestamp` and `Epoch.coverageEnd` on Arc.
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
