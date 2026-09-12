/**
 * Turns a raw WAD-scaled volatility number into something a trader or LP can
 * actually read — a low/medium/high-style tier plus a "is the rate I'd pay
 * currently rich or cheap" qualifier — instead of a bare "661.8% annualized"
 * figure with no context.
 *
 * Two independent inputs, deliberately not one blended score:
 *
 *   - **Magnitude**: where the current implied vol sits, as a percentile,
 *     against *this pool's own trailing history*. Never a fixed global
 *     cutoff ("<20%=low") — annualization is an uncalibrated convention
 *     (see README.md's Limitations section), and testnet pools already show
 *     600–900%+ routinely, so a global scale would call almost everything
 *     "extreme." Relative-to-self is the only honest comparison available.
 *   - **Richness**: reuses `spreadWad`/`dataSufficient` verbatim from
 *     `services/underwriter/src/signals.ts` (`spreadWad = impliedVolWad -
 *     realizedVolWad`, `null` whenever there isn't enough data to trust it)
 *     — the same signal that already decides the underwriter's post/withdraw
 *     capacity calls, evaluated against that service's own default
 *     thresholds (`services/underwriter/src/config.ts`:
 *     `UW_POST_SPREAD_THRESHOLD_WAD` +5%, `UW_WITHDRAW_SPREAD_THRESHOLD_WAD`
 *     -2%). This answers "is the rate I'd pay right now priced rich or cheap
 *     relative to what's actually happening" — the underwriter's own
 *     fairness signal, read from the other side of the trade.
 *
 * Canonical copy lives here (`packages/onchain`); `frontend/app/app/lib/onchain/severity.ts`
 * is a byte-identical mirror, same convention as `addresses.ts`/`abis.ts` —
 * there is no shared npm package between the frontend and backend repos, so
 * duplicate-and-drift-test is the established pattern (`test/drift.test.ts`).
 */

export type VolTier = "very-low" | "low" | "typical" | "high" | "extreme";
export type RichnessQualifier = "rich" | "cheap" | "neutral" | "insufficient-data";

/** Percentile cut points. Illustrative defaults, not a calibrated spec —
 *  same "deliberately coarse" spirit as `underwrite-data.ts`'s existing
 *  `Opportunity` thresholds. Adjust freely; nothing else depends on the
 *  exact numbers. */
export const TIER_THRESHOLDS = {
  veryLow: 0.1,
  low: 0.35,
  high: 0.65,
  extreme: 0.9,
} as const;

export const TIER_LABELS: Record<VolTier, string> = {
  "very-low": "Very low",
  low: "Low",
  typical: "Typical",
  high: "High",
  extreme: "Extreme",
};

/** Mirrors `services/underwriter/src/config.ts`'s defaults
 *  (`UW_POST_SPREAD_THRESHOLD_WAD` / `UW_WITHDRAW_SPREAD_THRESHOLD_WAD`) —
 *  the underwriter's own config is per-deployment-tunable and not something
 *  the frontend can read live, so this is a snapshot of the default, not a
 *  live value. */
export const DEFAULT_RICHNESS_THRESHOLDS = {
  postSpreadThresholdWad: 50_000_000_000_000_000n, // +5%
  withdrawSpreadThresholdWad: -20_000_000_000_000_000n, // -2%
} as const;

export interface VolSeverity {
  tier: VolTier;
  /** In [0, 1]. Fraction of the trailing sample series strictly below the current value. */
  percentile: number;
  richness: RichnessQualifier;
  spreadWad: bigint | null;
}

/**
 * Fraction of `trailing` strictly below `current`, in `[0, 1]`. `0.5`
 * ("typical") when there is no trailing history yet — not `0` or `1`, either
 * of which would assert an extreme the data does not support.
 */
export function percentileRank(current: bigint, trailing: readonly bigint[]): number {
  if (trailing.length === 0) return 0.5;
  let below = 0;
  for (const v of trailing) if (v < current) below += 1;
  return below / trailing.length;
}

export function tierFromPercentile(p: number): VolTier {
  if (p < TIER_THRESHOLDS.veryLow) return "very-low";
  if (p < TIER_THRESHOLDS.low) return "low";
  if (p < TIER_THRESHOLDS.high) return "typical";
  if (p < TIER_THRESHOLDS.extreme) return "high";
  return "extreme";
}

/**
 * `dataSufficient=false` (or a `null` spread) always returns
 * `"insufficient-data"` — never a guessed richness. Matches the codebase's
 * existing rule, stated in `signals.ts`'s own module doc: "a missing
 * measurement is not a zero-risk measurement."
 */
export function richnessFromSpread(
  spreadWad: bigint | null,
  dataSufficient: boolean,
  thresholds: { postSpreadThresholdWad: bigint; withdrawSpreadThresholdWad: bigint } = DEFAULT_RICHNESS_THRESHOLDS,
): RichnessQualifier {
  if (!dataSufficient || spreadWad === null) return "insufficient-data";
  if (spreadWad >= thresholds.postSpreadThresholdWad) return "rich";
  if (spreadWad <= thresholds.withdrawSpreadThresholdWad) return "cheap";
  return "neutral";
}

export interface ComputeVolSeverityParams {
  currentImpliedVolWad: bigint;
  /** This pool's own trailing implied-vol samples, oldest-to-newest order does not matter. */
  trailingImpliedVolWad: readonly bigint[];
  /** `impliedVolWad - realizedVolWad`, or `null` -- exactly `signals.ts`'s `spreadWad`. */
  spreadWad: bigint | null;
  /** Exactly `signals.ts`'s `dataSufficient`. */
  dataSufficient: boolean;
  richnessThresholds?: { postSpreadThresholdWad: bigint; withdrawSpreadThresholdWad: bigint };
}

export function computeVolSeverity(params: ComputeVolSeverityParams): VolSeverity {
  const percentile = percentileRank(params.currentImpliedVolWad, params.trailingImpliedVolWad);
  return {
    tier: tierFromPercentile(percentile),
    percentile,
    richness: richnessFromSpread(params.spreadWad, params.dataSufficient, params.richnessThresholds),
    spreadWad: params.spreadWad,
  };
}

/** "High · pricing rich", "Typical", "Extreme · not enough data yet", etc. —
 *  a single read, not two numbers to reconcile in your head. */
export function formatSeverityLabel(severity: VolSeverity): string {
  const base = TIER_LABELS[severity.tier];
  switch (severity.richness) {
    case "rich":
      return `${base} · pricing rich`;
    case "cheap":
      return `${base} · pricing cheap`;
    case "insufficient-data":
      return `${base} · not enough data yet`;
    case "neutral":
    default:
      return base;
  }
}
