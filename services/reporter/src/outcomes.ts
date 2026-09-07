/**
 * Every custom-error revert this service can hit, mapped to exactly one of
 * four behaviours — the table in `BACKEND_HANDOFF.md` § Service 1, made
 * exhaustive and unit-testable without a chain.
 *
 *   - `success` — the desired end state already holds (someone else's tx, or
 *     an earlier attempt of ours, got there first). Journal it `done`, move on.
 *   - `retry`   — transient. Leave the journal record `failed` (reclaimable)
 *     and try again next tick. No alarm; this is expected traffic (calling
 *     `settle` before `endBlock`, calling `reportPayoff` before `coverageEnd`).
 *   - `terminal`— permanent for this one epoch. Alarm loudly, journal it
 *     `done` (so it is never retried — retrying a `ReportWindowClosed` can
 *     only ever revert the same way, forever) and move on to other epochs.
 *   - `fatal`   — a configuration bug, not a chain state. Alarm loudly and
 *     stop the whole service (`FatalReporterError`) rather than one epoch,
 *     because a wrong reporter key fails identically on every epoch and every
 *     future tick, and continuing to retry only ever generates identical
 *     noise.
 */

export type RevertOutcome =
  | { kind: "success" }
  | { kind: "retry" }
  | { kind: "terminal"; reason: string }
  | { kind: "fatal"; reason: string };

/** `SigmaStream.openEpoch` — job 1a. */
export function classifyOpenEpochRevert(revertName: string | undefined): RevertOutcome {
  switch (revertName) {
    case "EpochExists":
      // Belt-and-braces: the on-chain read in discovery.ts already checks
      // this before sending, so hitting it here means a race, not a bug.
      return { kind: "success" };
    case "NotReporter":
      return {
        kind: "fatal",
        reason: "NotReporter: REPORTER_PRIVATE_KEY does not match SigmaStream.settlementReporter()",
      };
    default:
      return { kind: "retry" };
  }
}

/** `SigmaVault.settle` — job 1b step 1. Permissionless; not reporter-gated. */
export function classifySettleRevert(revertName: string | undefined): RevertOutcome {
  switch (revertName) {
    case "AlreadySettled":
      // BACKEND_HANDOFF.md: "Handle AlreadySettled as success, not failure."
      // Some other permissionless caller (or an earlier attempt of ours that
      // landed after we timed out waiting) settled it first.
      return { kind: "success" };
    case "EpochNotOver":
      // We gate on `currentBlock >= endBlock` before calling settle, so this
      // is only reachable via a race at the boundary block. Back off.
      return { kind: "retry" };
    case "NoSuchEpoch":
      // Discovered from a vault `EpochOpened` log, so the epoch exists; an
      // RPC serving a stale/lagging view is the only realistic cause. Retry.
      return { kind: "retry" };
    default:
      return { kind: "retry" };
  }
}

/** `SigmaStream.reportPayoff` — job 1b step 3. */
export function classifyReportPayoffRevert(revertName: string | undefined): RevertOutcome {
  switch (revertName) {
    case "AlreadyReported":
      // "success — it is one-shot and immutable" (BACKEND_HANDOFF.md).
      return { kind: "success" };
    case "NotReporter":
      return {
        kind: "fatal",
        reason: "NotReporter: REPORTER_PRIVATE_KEY does not match SigmaStream.settlementReporter()",
      };
    case "NoSuchEpoch":
      // "openEpoch was never called for this id — go do job 1a first."
      // job 1a re-attempts every known epoch every tick, so this self-heals;
      // no alarm needed unless it never clears.
      return { kind: "retry" };
    case "EpochNotOver":
      return { kind: "retry" };
    case "ReportWindowClosed":
      return {
        kind: "terminal",
        reason:
          "ReportWindowClosed: the report deadline passed before reportPayoff landed. " +
          "Unrecoverable — every subscriber reclaims unspent premium via reclaimUnreported " +
          "and every underwriter withdraws capacity. This epoch will never be reported.",
      };
    case "PayoffOutOfRange":
      return {
        kind: "terminal",
        reason:
          "PayoffOutOfRange: payoffWad handed to reportPayoff was outside [0, 1e18]. " +
          "The vault itself should never produce that — this points at a bug in this " +
          "service (a rescale, a wrong field read), not the chain. Do not retry blindly; " +
          "find the bug, then clear this epoch's journal record to try again.",
      };
    default:
      return { kind: "retry" };
  }
}

/**
 * Thrown out of a tick to stop the whole service (`runLoop`'s caller decides
 * how — see `index.ts`), rather than being swallowed as one more failed tick.
 * Reserved for `fatal` outcomes: a wrong key fails identically forever, so
 * "retry next tick" is actively misleading operator behaviour.
 */
export class FatalReporterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalReporterError";
  }
}
