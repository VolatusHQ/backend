# @volatus/keeper

Service 2 of `BACKEND_HANDOFF.md`: the permissionless `sync` keeper for
`SigmaStream` on Arc.

## What it does, and what it does not do

`SigmaStream.sync(epochId, subscriber)` is permissionless arithmetic on money
that is already inside the contract, earmarked to that subscriber's epoch. It
moves nothing anywhere the subscriber did not already commit it — it just
credits elapsed time against the funded balance and transfers the earned
premium from `subscription.funded` into `capacityPool`, where underwriters
can see and withdraw it. Nobody signs anything for this to happen; the only
signatures in this whole flow are the subscriber's own `subscribe`, `fund`,
and `adjust` calls. The keeper's entire job is to call `sync` often enough
that premium actually *reaches* underwriters and the on-chain figures stay
honest — not to make a number move on a screen.

**The UI meter does not need this service to look live.** `coveredSeconds`
and `funded` between two real syncs are a deterministic function of
`lastSync`, `ratePerSecond` and the wall clock — see `_sync` in
`contracts/src/SigmaStream.sol`. `src/project.ts`'s `projectSubscription`
computes exactly that projection off-chain, with no RPC call, so a frontend
can show a smoothly decreasing runway between keeper ticks without ever
sending a transaction. This module exports that function specifically so
there is one implementation of the projection, not a frontend copy that can
drift from what the contract actually does.

## The gas-vs-premium arithmetic (why this is not "call sync every 30s")

`BACKEND_HANDOFF.md`'s literal shape is "every 30–60s, for each active
subscription, call sync." That is wrong at the rates this protocol actually
runs at, and this service does not implement it literally.

Measured live against this deployment, from the keeper key
(tx `0xd47a57cbe0dc51e4c95836ab14e664c4230105b0ac67bf0eecce5c16d7f4fc24`,
BRIEF.md): one `sync` cost **68,887 gas / 0.00172218 USDC**. On Arc, gas *is*
USDC — there is no separate "cheap" native token subsidizing it. At the
seeded demo rate (`ratePerSecond = 100`, i.e. 0.0001 USDC/s):

| Tick interval | Premium accrued | Gas to collect it | Overhead |
|---|---|---|---|
| 30s | 0.003 USDC | 0.00172 USDC | **57%** |
| 60s | 0.006 USDC | 0.00172 USDC | 29% |
| ~17s (breakeven) | ~0.0017 USDC | 0.00172 USDC | ~100% |

So instead of a fixed send interval, every tick computes what a real `sync`
would move (`projectSubscription`, mirroring `_sync`'s "ran dry partway"
branch exactly) and a live gas estimate (`gas.ts`: `estimateGas` × current
fee, not a hardcoded constant — fee markets move and BRIEF's number is one
measurement from one day), then gates the send (`gate.ts`, `shouldSync`) on
whichever of these is true:

- **economic** — accrued premium is worth at least `KEEPER_SAFETY_FACTOR`×
  (default 10×) the estimated gas cost. The normal case.
- **max-interval** — `KEEPER_MAX_SYNC_INTERVAL_SECONDS` has elapsed since
  `lastSync` regardless of amount, so a very low rate is never left un-synced
  forever waiting to clear the economic bar.
- **epoch-ending** — `coverageEnd` is within `KEEPER_EPOCH_END_MARGIN_SECONDS`.
  Past `coverageEnd`, elapsed time stops growing (`_sync` clamps at it), so
  whatever is unswept right now is *all it will ever be* — if the economic
  bar hasn't cleared by then, waiting longer does not help.
- **draining** — projected runway is down to `KEEPER_DRAIN_MARGIN_SECONDS`
  seconds, the same freeze, triggered by running out of money instead of
  epoch.

`_sync` is a no-op when nothing has elapsed since `lastSync` (`upTo <=
s.lastSync` in the Solidity), so calling it too often is **harmless to
correctness** — it will never double-charge or corrupt state. It is not
harmless to the keeper wallet's own runway, which is the entire reason this
gate exists instead of a fixed interval.

## The subscription registry

Subscriptions are discovered from `Subscribed` logs on Arc
(`src/registry.ts`, via `@volatus/service-kit`'s `getLogsChunked`), starting
from a persisted cursor (`KEEPER_SEED_BLOCK` the first time). **Arc prunes
history**, so a log scan can only ever *extend* the registry, never be its
source of truth: the journal (`@volatus/service-kit`'s `journal.ts`,
`upsertSubscription`/`listSubscriptions`/`dropSubscription`) is authoritative,
and a subscription once written there stays tracked until this service
explicitly drops it — independent of whether a later scan could still see
the block it was created in. When a scan hits Arc's pruning error, the floor
is recorded (`keeper:subscribed:prunedBefore` in the journal's `kv` table)
and logged plainly: anything subscribed before that block is invisible to
log scanning and must be added by hand with `seedSubscription()`.

A tracked subscription is dropped (per `BACKEND_HANDOFF.md` § Service 2) when
any of, checked in this order:

1. `ratePerSecond == 0` — cancelled.
2. `runwaySeconds == 0 && funded == 0`, both read live from chain (not
   projected) — drained. Using the on-chain values rather than the
   projection means a subscription is only ever dropped once a real sync has
   already confirmed it is dry, never on a guess.
3. `now > coverageEnd` — the epoch is over.

The gate is evaluated (and a final sync sent, if due) *before* the drop
check runs on the same tick, so a subscription that just crossed
`coverageEnd` or just ran dry gets one last attempt at sweeping whatever
premium is still unswept before it leaves the registry. Nothing is lost if
that attempt fails or is skipped either way — `claim()` runs its own
`_sync` internally, so a subscriber's final payout is correct regardless of
whether the keeper ever gets around to it.

## Commands

```bash
pnpm -F @volatus/keeper build

pnpm -F @volatus/keeper start          # the gated tick loop
DRY_RUN=1 pnpm -F @volatus/keeper start   # same loop, logs decisions, sends nothing

pnpm -F @volatus/keeper status         # one-shot report, never sends — see below
```

`status` runs the exact same discovery + projection + gate logic as a real
tick, forced read-only regardless of `DRY_RUN`, and prints one line per
tracked subscription: `lastSync`, elapsed, projected accrued premium,
projected runway, whether a sync is due right now, and why (or why not, with
the accrued-vs-gas ratio).

`start` refuses to run if the keeper wallet's balance is below
`KEEPER_MIN_BALANCE_USDC` (default 0.05 USDC) — a keeper that is silently
broke is worse than one that is loudly down.

## Configuration

Only what this service actually needs (see `src/config.ts`) — it never
touches Unichain and never holds the reporter's key, so it does not load
`@volatus/service-kit`'s full `commonConfigShape`:

| Var | Default | |
|---|---|---|
| `ARC_TESTNET_RPC` | — required | |
| `KEEPER_PRIVATE_KEY` | — required | unprivileged; needs USDC on Arc for gas |
| `JOURNAL_PATH` | `services/.journal.sqlite` | |
| `ALERT_WEBHOOK_URL` | — optional | |
| `DRY_RUN` | `0` | `1` logs sync decisions on `start`, sends nothing |
| `KEEPER_SAFETY_FACTOR` | `10` | economic gate multiplier |
| `KEEPER_MAX_SYNC_INTERVAL_SECONDS` | `3600` | backstop |
| `KEEPER_EPOCH_END_MARGIN_SECONDS` | `120` | forced final sync window |
| `KEEPER_DRAIN_MARGIN_SECONDS` | `120` | forced final sync window |
| `KEEPER_TICK_INTERVAL_MS` | `30000` | how often the loop *evaluates* the gate — not how often it sends |
| `KEEPER_SEED_BLOCK` | `0` | checkpoint for the first log scan |
| `KEEPER_MIN_BALANCE_USDC` | `0.05` | `start` refuses below this |

## Two bugs this service surfaced in the shared packages — both now fixed

Neither was fixable from inside this service, so they were reported rather
than patched locally, and then fixed at the root. Recorded here because the
way they hid is the interesting part: both are invisible to `vitest` and to
`next build`, and only appear when something actually runs `node dist/…`.

1. **`packages/onchain`'s compiled output was not valid Node ESM.** It builds
   with `moduleResolution: "bundler"` and re-exported with extensionless
   relative specifiers (`export * from "./chains"`) — fine under a bundler
   (webpack, esbuild, vitest), rejected by Node's own resolver at runtime
   with `ERR_MODULE_NOT_FOUND`. Nothing in the repo had run a built artifact
   under plain Node before, so nothing had noticed. Fixed in
   `packages/onchain/src/*` by writing the specifiers with `.js`, which is
   what Node requires and what `service-kit` was already doing correctly.

2. **`service-kit`'s `runLoop` scheduled its next tick on an `unref`'d
   timer**, so a daemon whose only pending work *is* the loop exits
   immediately after `runLoop()` returns — it would start, log that it had
   started, and die before the first tick. Fixed in
   `packages/service-kit/src/runner.ts`; `stop()` clears the timer, so a
   ref'd timer does not hold a shutdown open.

Both fixes are proven by this service running under a plain
`node dist/index.js status`, with no loader hook and no keep-alive.

## Verification

See the top-level task report for the full paste of `build`/`typecheck`/
`test` output, the live `status` run against the real subscription on Arc
epoch 2, and the measured before/after of a real `sync`: elapsed 2697s,
`capacityPool` +269700 (exactly `2697 × 100`), `coveredSeconds` +2697
(exactly `elapsed`), tx
`0x1b7f6193c16025b81d76bcf0f06ee01d40a08829555f4c21c5ed8c2cf7324978`.
