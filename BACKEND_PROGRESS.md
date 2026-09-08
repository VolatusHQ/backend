# Backend progress — phases 5 and 6

What was built, what is proven on chain, and what is only asserted. Written
2026-09-05 at the end of the backend pass that took `BACKEND_HANDOFF.md` from a
spec to four running services.

For what is still open, read [`HANDOFF.md`](./HANDOFF.md). For the decisions
behind any of this, `DECISIONS.md`. The phase map lives in `PHASES.md`.

---

## The blocker that had to go first

`SigmaStream.settlementReporter` is `immutable` and was set to
`0x364EDC06…5609` — the deployer key nobody on the team holds, the same one
that had already stranded the old oracle's `curator`. Only that address can
call `openEpoch` and `reportPayoff`, so **no epoch on Arc could ever be
reported**: epoch 1 lapsed unreported on 2026-09-04 and every subscriber on
that contract can now do nothing but `reclaimUnreported`.

Nothing in phase 5 was possible until that was fixed, so the pass opens with a
redeploy:

| | Value |
|---|---|
| `SigmaStream` (live) | `0x6C35BEC76B7c43DDdbF0b46E3402D1461b4233D9` |
| dead, do not use | `0xD7EeD2a64762A7038d64886882161bA1b1EfC074` |
| `settlementReporter` | `0xFf54812Fc9EC92E51a22f67a92Cd2c09a049E30c` — a key we hold |
| keeper (unprivileged) | `0x8f60c22c7395e0231E8ed45AfCc5b9a92fa34370` |

The redeploy also put **`adjust`** on chain for the first time (selector
`0x6f871cec`, confirmed in the deployed bytecode). It was written and tested in
phase 3 but never deployed, and phase 6 depends on it.

Keys live in `services/.env.local`, gitignored, mode 600. **The reporter key is
a fresh testnet throwaway and should be a 2-of-3 multisig before this is
anything more than a demo.** It can publish a wrong payoff for coverage on Arc
and nothing else — it cannot touch vault collateral, change what
VAR-LONG/VAR-SHORT redeem for, or stop a subscriber recovering unspent premium
(`DECISIONS.md` §12).

---

## What is proven, with transaction hashes

### Phase 5 — the full settlement loop, end to end

`PHASES.md`'s gate for phase 5 is "`reportPayoff` lands for a real epoch and a
subscriber's `claim` pays out." It did, driven by the services themselves:

| Step | Chain | Evidence |
|---|---|---|
| `openEpoch(3)` | Arc | the reporter mirrored vault epoch 3 on its own |
| swaps → variance | Unichain | accumulator `156884` over 8 observations |
| `sync` | Arc | the keeper found the subscription from its `Subscribed` log |
| `settle(3)` | Unichain | payoff `1e18` |
| `reportPayoff(3)` | Arc | `0x4d600f4a70f37c248a01014e8b217e6c5d86a1bc15f133ab7f5385b76f8b67b7` |
| **`claim(3)`** | Arc | **paid 1.941588 USDC** + 0.169 refund — `0xb12bf74c5145cec384ff1e363387706c6c8624a678e31060da1ca99821722bc8` |

Every figure reconciles exactly, which is the point — a payout that is roughly
right is a payout nobody can audit:

```
payout = 2,000,000 × 1.0 × 831/856 = 1,941,588   observed 1,941,588
refund =   521,000 − 352 × 1000    =   169,000   observed   169,000
pool   = 7,479,000 − 1,941,588 + 352,000 = 5,889,412   observed 5,889,412
```

The 2,366-unit gap between the wallet delta and payout+refund is gas. On Arc
gas *is* USDC, out of the same balance.

This ran on a **second measured pool** (fee 500, poolId `0xd628d5cc…2760`)
opened by `contracts/script/DeployDemoPool.s.sol`, because the real pool's
epoch 2 does not end until ~2026-09-12. `SigmaVault.openEpoch` is permissionless
and keyed per pool, and `SigmaHook` has no allowlist, so this is a legitimate
second market, not a workaround.

### Phase 6 — the agents

Gate: "the hedger changes a live rate in response to a real IV move, logged."

Implied vol read **55.93%** off the oracle against a live rate of 100, giving a
target of 55 — 4500 bps of drift against a 500 bps mandate tolerance:

| | before | after | tx |
|---|---|---|---|
| `ratePerSecond` | 100 | **55** | `0x2bcce90a5a439f16ddf0bc3a1f480b47aefa573c0bf99fe88a6d59a1e0d4181d` |
| `funded` | 0 | 1 USDC | `0x99d479227e32b6d5c2c22d5a03873264e786e8eafe75cd7924c12aec01a7e691` |
| `runwaySeconds` | 0 | 18,181 | |

`coveredSeconds` stayed at 20,000 across the adjust, so the re-rate did not
resurrect lapsed coverage — the property `test_adjustDoesNotResurrectLapsedCoverage`
asserts, now also observed on a live contract.

The **underwriter**'s first live run is worth reading as a result in itself:

```
intent: HOLD
  reason: insufficient-data: no observations since the active epoch opened --
  realizedVol=0 here is a missing measurement, not a zero-risk one
```

Implied reads 55.93% while `realizedVol` reads 0, because the measured pool has
not traded since epoch 2 opened. A spread taken off that zero says "implied is
enormously rich, post everything" — a confident number derived from an absent
measurement. It compares the hook's accumulator against the epoch's
`startAccumulator`, finds them equal, and holds.

---

## What was built

```
packages/onchain       chains, addresses, ABIs (every custom error, so reverts
                       decode to names), units. A drift test holds it identical
                       to the web copy and forbids either tree drifting back to
                       the dead address.
packages/service-kit   config, a key-redacting logger, a sqlite tx journal where
                       a crashed action returns in_flight rather than fresh, a
                       nonce-serialized wallet with revert-name decoding,
                       chunked getLogs, deadline alarms, a loop runner.

services/reporter      Service 1. Mirrors vault epochs onto Arc, settles on
                       Unichain, reports the payoff. The only privileged key.
services/keeper        Service 2. Permissionless sync, gated on economics.
services/hedger        Service 3. Mandate-bound re-rating off IV and gamma.
services/underwriter   Service 4. Capacity against spread, utilization and
                       concentration.
```

**331 tests** across six packages, plus **167** `forge test` (up from 163: a
cross-chain settlement fork test was added this pass).

---

## Two places the handoff's own instructions were not followed, deliberately

Both are measurements, not preferences.

**1. The keeper does not tick every 30–60s.** `BACKEND_HANDOFF.md` § Service 2
says it should. Measured: a `sync` costs ~0.0013–0.0017 USDC of gas, and on Arc
gas *is* USDC. At the seeded `ratePerSecond` of 100, a 30-second tick accrues
0.003 USDC while burning 0.0017 to collect it — **57% overhead**. The keeper
projects accrued premium, estimates gas live, and sends only when accrued is
worth ~10× the gas, with a max-interval backstop and forced syncs when the
epoch is ending or the balance is draining. `_sync` is a no-op when nothing has
elapsed, so over-calling is harmless to correctness — it is just not free.

**2. The keeper is not what makes the meter move**, and the docs no longer imply
it is. `coveredSeconds` between syncs is a deterministic function of `lastSync`,
`ratePerSecond` and the clock, so a UI extrapolates for free with the exported
pure `projectSubscription`. The keeper's real job is getting premium to
underwriters and keeping the on-chain figure honest.

---

## Defects found by running it, not by reading it

None of these would have been caught by a test suite, which is the argument for
the live runs:

1. **`@volatus/onchain` compiled to invalid Node ESM.** `moduleResolution:
   "bundler"` allowed extensionless relative re-exports that Node's own resolver
   rejects. Invisible to `vitest` and `next build`, because neither runs a built
   artifact under plain Node.
2. **`runLoop` scheduled on an `unref`'d timer**, so a daemon whose only pending
   work was the loop started, logged that it had started, and exited before its
   first tick.
3. **The logger redacted transaction hashes.** A tx hash and a private key are
   both `0x` + 64 hex. It surfaced the first time the reporter did real work:
   `openEpoch(3) landed` with `hash: "[REDACTED_KEY]"` — the one field that line
   exists to carry.
4. **A correct safety check made fatal by a lagging RPC.** The reporter
   cross-checks `EpochSettled`'s payoff against a fresh `epoch()` read before
   reporting. Unichain served that read stale for seconds after the write, the
   check fired, and `settle` is one-shot — the epoch would have been stranded
   and everyone refunded instead of paid. It now re-reads until the node catches
   up and only treats a *persistent* disagreement as real.
5. **The keeper dropped subscriptions whose final sweep never landed.**
   `keeper status` runs dry and calls itself read-only, yet was permanently
   untracking subscriptions it had never synced — losing underwriter income to a
   status command. Found by an adversarial pass that wrote the failing test
   first.
6. **Log-scan seed blocks defaulted to 0.** Arc prunes history and a full-range
   scan is tens of millions of blocks, which trips the rate limit before finding
   anything. Now defaults to the block `SigmaStream` was deployed in.
7. **`DemoVolatility` drove the wrong pool** (hardcoded fee 3000/60), so the
   demo epoch would have accumulated no variance and settled at a payoff of 0,
   proving nothing.

---

## Chain facts worth keeping

Measured this pass; several contradict what a doc or an assumption said.

- **`eth_getLogs` caps.** Unichain rejects `toBlock - fromBlock > 10000`
  outright. Arc's ceiling moved during the session (30,000 was rejected, then
  accepted); the defaults sit far below either. Arc also **prunes history** —
  `fromBlock: 0` returns `4444 pruned history unavailable` — so log scanning can
  never be the sole source of truth for Arc state.
- **Unichain serves stale reads after a write.** Observed on `epoch().payoffWad`,
  `epochCount` and an ERC-20 `allowance`. Never trust one read-after-write.
- **Unichain rejects multi-transaction `forge script` broadcasts** with
  `-32000: in-flight transaction limit reached for delegated accounts`. Send one
  at a time.
- **Arc's USDC ERC-20 calls a blocklist precompile at `0x1800…0001`** that
  Foundry's local EVM does not have, so any `forge script` touching USDC dies
  with `StackUnderflow` before sending. Use `cast`/viem against the live RPC.
- **The mock ERC-20s underflow on insufficient allowance** rather than reverting
  with a message, so a missing `approve` presents as
  `panic: arithmetic underflow or overflow (0x11)` and looks like a maths bug.
