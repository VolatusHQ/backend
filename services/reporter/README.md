# @volatus/reporter

Service 1 of `BACKEND_HANDOFF.md`: the settlement reporter. Without it, no epoch on Arc is
ever settled and `claim` can never pay out — the payoff is measured and settled on Unichain,
`SigmaStream` lives on Arc, and there is no synchronous cross-chain call, so something has to
carry the number across (`DECISIONS.md` §12).

## What it is trusted with, and what it is not

Quoting `DECISIONS.md` §12 directly, because this is the whole point of the design and this
service's only privilege:

> **Decision.** `SigmaStream` takes a `settlementReporter`, fixed at construction, who publishes
> an epoch's payoff exactly once and can never change it. This is the only trust surface in the
> contract, and it is bounded by a fail-safe: if no report arrives by `reportDeadline`,
> subscribers reclaim every unspent unit of premium via `reclaimUnreported` and underwriters
> withdraw their capacity. Coverage simply never materializes.
>
> **What the reporter can and cannot do:** it can report a wrong payoff for coverage on Arc. It
> cannot touch collateral in the vault, cannot change what VAR-LONG or VAR-SHORT redeem for, and
> cannot prevent a subscriber from recovering unspent premium.

Concretely:

- **Can:** call `SigmaStream.openEpoch` (mirror a vault epoch's schedule onto Arc) and
  `SigmaStream.reportPayoff` (publish the settled payoff), each exactly once per epoch, and
  call `SigmaVault.settle` on Unichain — but that call is permissionless, needing only ETH for
  gas, not this key's privilege.
- **Cannot:** touch vault collateral, change what VAR-LONG/VAR-SHORT redeem for, stop a
  subscriber's `reclaimUnreported`, or affect anything if it goes offline — a missed
  `reportDeadline` refunds everyone, it does not lock anything up. Arc is a payment rail and is
  never part of settlement (`README.md`); this service does not change that.
- **Worst case if the key leaks:** a malicious report can set a wrong `payoffWad` in
  `[0, 1e18]`, misdirecting Arc-side payouts for that one epoch's subscribers/underwriters.
  It cannot reach Unichain collateral by any path.

## The two jobs

**1a — mirror.** Watches `SigmaVault.EpochOpened` on Unichain (`getLogsChunked`, resumed from a
journal cursor) and calls `SigmaStream.openEpoch(epochId, coverageEnd, reportDeadline)` for
every epoch not yet on Arc. `coverageEnd` is converted from the vault's block-numbered
`endBlock` to an Arc unix timestamp using a block time **measured live** (two real blocks, not
a hardcoded constant — see `src/time.ts`), always rounded down: ending coverage early is safe,
ending late sells coverage for a period the payoff does not cover. `reportDeadline` is
`coverageEnd + REPORT_DEADLINE_MARGIN_SECONDS` (default 24h). An epoch whose report window
would already be closed by the time it is discovered (a very old backfilled epoch) is not
mirrored at all — see "Design notes" below.

**1b — settle, then report.** Once `block.number >= endBlock`, calls the permissionless
`SigmaVault.settle(epochId)` on Unichain, reads `payoffWad` back (cross-checked against the
`EpochSettled` event emitted by that same transaction), then calls
`SigmaStream.reportPayoff(epochId, payoffWad)` on Arc. `payoffWad` is a WAD ratio in
`[0, 1e18]` and crosses chains **unchanged** — never rescaled to a 6dp USDC amount
(`src/report.ts`'s `buildReportPayoffArgs`, tested explicitly).

## Running it

```bash
pnpm -F @volatus/reporter build

# Read-only. Never sends, never writes the journal.
pnpm -F @volatus/reporter status

# Preview exactly what a real tick would do, without sending anything.
DRY_RUN=1 pnpm -F @volatus/reporter start

# One real tick, then exit (cron-style).
pnpm -F @volatus/reporter start -- --once

# Loop forever (30s default interval, jittered).
pnpm -F @volatus/reporter start
```

Configuration is loaded from `services/.env.local` via `@volatus/service-kit`'s `loadConfig`
(fails at boot naming anything missing):

| Var | Required | Default | Meaning |
|---|---|---|---|
| `UNICHAIN_SEPOLIA_RPC` | yes | — | |
| `ARC_TESTNET_RPC` | yes | — | |
| `REPORTER_PRIVATE_KEY` | yes | — | The only key this service holds. |
| `ALERT_WEBHOOK_URL` | no | — | POSTed to on every `alert()` call. |
| `JOURNAL_PATH` | no | `services/.journal.sqlite` | |
| `REPORT_DEADLINE_MARGIN_SECONDS` | no | `86400` (24h) | Added to `coverageEnd` when mirroring. |
| `DEADLINE_ALARM_MARGIN_SECONDS` | no | `21600` (6h) | How early the deadline alarm starts firing. |
| `POLL_INTERVAL_MS` | no | `30000` | Loop tick interval (jittered by `runLoop`). |
| `VAULT_EPOCH_SCAN_START_BLOCK` | no | `61561322` (measured `SigmaVault` deploy block) | Backfill floor when the journal has no cursor yet. |

`KEEPER_PRIVATE_KEY` is deliberately **not** requested — this service only ever loads
`REPORTER_PRIVATE_KEY`, so it cannot be started with the wrong secret by accident.

## The deadline alarm

`checkDeadlineAlarm` (`src/tick.ts`) calls `@volatus/service-kit`'s `deadlineAlarm` once per
known, mirrored epoch on every tick. It fires — `warn`, then escalating to `error` once the
deadline itself passes — starting at `reportDeadline - DEADLINE_ALARM_MARGIN_SECONDS`, as long
as the epoch is not yet `reported`. This is the actual point of the service:
`BACKEND_HANDOFF.md` — "that alarm is the difference between a payout and a mass refund."

## Failure modes, mapped explicitly (`src/outcomes.ts`)

| Revert | This service's behaviour |
|---|---|
| `NotReporter` | **Fatal.** Wrong key configured. Alarms, throws `FatalReporterError`, and the loop stops the whole service rather than retrying forever. |
| `NoSuchEpoch` (on `reportPayoff`) | Retry. Job 1a re-attempts `openEpoch` for every known epoch every tick, so this self-heals once it lands. |
| `EpochExists` / `AlreadySettled` / `AlreadyReported` | Treated as **success** — each is this service's own idempotency belt-and-braces, not a failure. |
| `EpochNotOver` | Retry (too early); no alarm, this is expected traffic near a boundary. |
| `ReportWindowClosed` | **Terminal.** Alarms loudly, journals the epoch permanently as a terminal failure (never retried — a second attempt can only revert the same way forever). Every subscriber reclaims via `reclaimUnreported`. |
| `PayoffOutOfRange` | **Terminal**, and alarms as a bug in this service (a rescale, a wrong field), not the chain — the vault itself should never produce an out-of-range payoff. |

A crash mid-send is handled by `src/journalReconcile.ts`: a `journal.claim()` returning
`in_flight` is **never** treated as permission to resend. If a tx hash was recorded, its
receipt is looked up and reconciled; if not, the on-chain effect itself (`coverageEnd != 0`,
`settled`, `reported`) is the only source of truth, and if that still shows "not done," the
service blocks and logs rather than guessing — an operator resolves it by hand.

## Design notes worth flagging

- **A stale backfilled epoch is never mirrored.** If a vault `EpochOpened` is discovered so
  late that the computed `reportDeadline` would already be in the past (this really happens:
  the live vault's epoch 1 predates this Arc stream deployment entirely), `openEpoch` is
  skipped and the epoch is journaled `skipped-stale` rather than opened doomed. See
  `shouldMirrorEpoch` in `src/time.ts`.
- **Epoch discovery is journal-driven for job 1b.** `src/knownEpochs.ts` lists every epoch id
  ever filed under the `openEpoch` journal action (mirrored, already-open, or skipped-stale
  alike), and `tick.ts` settles/reports each. Under `DRY_RUN` (which never writes the journal),
  `tick.ts` unions this with whatever job 1a's *current* scan just found, so a dry run on a
  pristine journal still previews settle/report, not only mirroring.
- **`settle()` still runs even for a "skipped-stale" epoch.** It is permissionless and frees
  the hook's pending snapshot boundary (`DECISIONS.md` §14) regardless of whether Arc will ever
  see a report for it — a public good independent of this service's own reporting job.
- **The block→timestamp conversion measures, never assumes.** `src/time.ts` reads two real
  Unichain blocks (1,000 apart by default) on every mirror attempt rather than hardcoding
  "~1s/block." Measured live on 2026-09-05: blocks 61,711,100 → 61,712,100 moved the clock by
  exactly 1,000 seconds.

## Verification note: a packaging bug found (and fixed) in `@volatus/onchain`

While verifying this service by running its built `dist/` under plain `node`, `@volatus/onchain`'s
compiled output failed with `ERR_MODULE_NOT_FOUND` — its `src/*.ts` used extensionless relative
imports (`export * from "./chains"`), which `tsc`'s `"module": "ESNext"` does not rewrite to
`.js` on emit, unlike `@volatus/service-kit`'s source, which already wrote `.js` on every
relative import. Node's native ESM resolver requires the extension; bundlers (and, notably,
Vitest's own resolution) tolerate its absence, which is why this package's own test suite
never caught it. That package is outside this agent's boundary (`packages/`), so it was only
reported, not patched here — it was fixed upstream in `@volatus/onchain` during this session
(confirmed working against the rebuilt package; see the verification output below).
