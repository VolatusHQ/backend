/**
 * Every custom-error revert `adjust`/`fund` can hit, mapped to exactly one
 * of four behaviours — same shape as `services/reporter/src/outcomes.ts`,
 * ported to this service's two writes instead of that one's three.
 *
 *   - `success`  — the desired end state already holds. Journal it `done`.
 *   - `retry`    — transient (a race on `capacityPool`, a momentarily stale
 *     read). Leave the journal record `failed` (reclaimable) and try again
 *     next tick.
 *   - `terminal` — permanent for this mandate as configured right now (no
 *     live subscription to act on). Journal it `done` so it is never
 *     retried, and say why in the log — this is not a chain outage, it is
 *     "there is nothing for the hedger to do here."
 *   - `fatal`    — a bug in this service (e.g. `pricing.ts` computed a zero
 *     rate `clampRate` should have floored). Alarm and stop rather than
 *     retry identically forever.
 */

export type RevertOutcome =
  | { kind: "success" }
  | { kind: "retry" }
  | { kind: "terminal"; reason: string }
  | { kind: "fatal"; reason: string };

/** `SigmaStream.adjust`. */
export function classifyAdjustRevert(revertName: string | undefined): RevertOutcome {
  switch (revertName) {
    case "ZeroRate":
      return {
        kind: "fatal",
        reason: "ZeroRate: pricing.ts/mandate.ts's clampRate should never let a zero rate reach adjust() — this is a bug in this service, not chain state.",
      };
    case "InsufficientCapacity":
      // capacityPool moved between our read and the send (an underwriter
      // withdrew, or another subscriber's adjust/subscribe landed first).
      // Re-read and re-evaluate next tick rather than guessing a smaller number.
      return { kind: "retry" };
    case "NoSubscription":
      return {
        kind: "terminal",
        reason:
          "NoSubscription: this mandate's owner has no live subscription on this epoch. The hedger " +
          "never calls subscribe() itself (README.md § Delegation) — nothing to adjust until the LP " +
          "subscribes through the app.",
      };
    case "NoSuchEpoch":
      // The epoch hasn't been mirrored onto Arc by the reporter yet, or this
      // mandate's epochId is simply wrong. Either way, retryable without an
      // alarm — the reporter's own deadline alarm covers the former.
      return { kind: "retry" };
    default:
      return { kind: "retry" };
  }
}

/** `SigmaStream.fund`. Does not revert `InsufficientCapacity` — that check is `subscribe`/`adjust`-only. */
export function classifyFundRevert(revertName: string | undefined): RevertOutcome {
  switch (revertName) {
    case "NoSubscription":
      return {
        kind: "terminal",
        reason: "NoSubscription: nothing to fund — the hedger does not initiate subscriptions.",
      };
    case "NoSuchEpoch":
      return { kind: "retry" };
    default:
      return { kind: "retry" };
  }
}

/** Thrown out of a tick on a `fatal` outcome, to stop the service rather than retry a bug forever. */
export class FatalHedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalHedgerError";
  }
}
