# Handoff — what is left

Written 2026-09-05, at the end of the backend pass. **Updated 2026-09-06** after
a second pass closed part of §1 and all of §3 — see the status line at the top
of each section below. What is **done** is in
[`BACKEND_PROGRESS.md`](./BACKEND_PROGRESS.md); this file is only the open work,
ordered by what actually blocks a demo.

Nothing here is blocked on code that does not exist. Everything left is blocked
on a reply from someone outside this repo, on a clock, or on someone deciding
something.

---

## 1. Two credentials, and the claims that depend on them

**Status: code fixed and provisioned for real on both sides. Both are now
blocked purely on a reply from outside the team — nothing left to build.**

Both delegation paths were originally written against a *guessed* SDK shape
and unit-tested against a mock of that guess — never checked against what the
real packages actually export. That guess was wrong for Privy and, it turned
out, right for Circle. Both are now checked line-by-line against the installed
`.d.ts` files of the real SDKs, not docs summaries:

| | Needs | Where | Now blocked on |
|---|---|---|---|
| Privy session signer | `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_WALLET_ID` | `services/hedger/src/delegation/privyClient.ts` | **Privy Support enabling Arc Testnet** (`eip155:5042002`) for the app — see below |
| Circle agent wallet | `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `CIRCLE_WALLET_ID` | `services/underwriter/src/wallet/circleAgentWallet.ts` | **Nobody has provisioned these credentials yet** — ask whoever owns the Circle account |

**Privy — what actually happened.** `privyClient.ts` was rewritten against
`@privy-io/node@0.34.0`'s real types (the ergonomic `PrivyClient` exposes
`wallets()`/`policies()` as *methods*, not properties, and
`wallets().ethereum().sendTransaction()` unwraps the `{method, data: {...}}`
envelope for you — an earlier version of this code assumed a different,
wrong shape). `scripts/provisionPrivy.ts` was run for real against the live
Privy app (`cmto2m69k014s0cl7k1r56dmg`): it created policy
`oewjjjsoc3fer1oi5luuqs0w` and wallet `ijhrb0nov4f6mxjiac76i0z9`
(`0x4e2234E0365CAff02748D9551C881fF4B6FA8F52`), funded with testnet USDC.
Running the hedger for real against it (`HEDGER_SIGNER_MODE=privy`,
`node dist/index.js once`) gets exactly one error, from Privy's own API, not
from this code:

```
401 {"error":"App is not authorized to transact on chain eip155:5042002"}
```

Arc Testnet is not in Privy's self-serve chain list anywhere in the dashboard
(checked Wallet infrastructure → Assets, → Advanced → Smart wallets, → Advanced
→ More — none of them cover it). A message was sent to Privy's support channel
on 2026-09-05 asking them to enable it; **as of this writing there is no
reply.** Once one lands, re-run the exact command above — nothing else should
need to change. If Privy's answer is "you can't," the documented fallback is
a Circle Modular Wallet (ERC-4337 + ERC-6900) with a session-key module
expiring at `coverageEnd`. See `.agents/skills/use-modular-wallets/`.

**Circle — what actually happened.** `index.ts` was passing the real
`initiateDeveloperControlledWalletsClient()` client to `makeCircleAgentWallet`
through an `as unknown as` cast, which silently skipped type-checking. The
cast has been removed and it now compiles clean with **no cast at all** —
real, structural proof `CircleWalletsClient`'s hand-written shape
(`getWallet`, `createContractExecutionTransaction`, `getTransaction`) matches
the real SDK, not just an assumption. What is still unverified is everything
only a live API call can confirm: authentication succeeding, a real wallet id
resolving, a transaction actually landing on Arc. Nobody has provided
`CIRCLE_API_KEY`/`CIRCLE_ENTITY_SECRET`/`CIRCLE_WALLET_ID` yet — ask whoever
manages the team's Circle developer account.

**Note:** Circle's CLI spending policies are **mainnet-only**. On testnet the
caps live in `services/underwriter/src/caps.ts` and the journal. Do not imply
Circle enforces anything on this network.

---

## 2. Arc epoch 2 — a real deadline, on a clock

**Status: still not running. Still blocked on the reporter key, below.**

Arc epoch 2 is open and unreported. `reportDeadline` is **1789239788**
(2026-09-12). The vault's epoch 2 ends at Unichain block **62301001** — as of
2026-09-06 the chain is at block **61813011**, so roughly 488,000 blocks
(~5.6 days at ~1s/block) remain. Re-check both live before trusting these —
they were read directly off both chains, not copied from an earlier doc.

If the reporter is not running when that block passes, and nobody reports before
the deadline, **every subscriber is refunded and every underwriter reclaims
capacity**. That is the fail-safe working, but it is not the demo.

**The keeper, unlike the reporter, is unblocked and has been proven live.** It
needs no privileged key — `sync()` is permissionless — so a fresh throwaway
key was generated, funded with testnet USDC via the Circle faucet, and run for
real on 2026-09-05: it synced real premium multiple times, each with its own
tx hash on Arc. It was stopped (gracefully, `SIGTERM`) when the machine running
it shut down, not because of a bug. Anyone can restart it — see § Running any
of it — or run it continuously somewhere that stays on; it does not need to be
the same person who resolves the reporter key.

```bash
cd services/reporter && node dist/index.js status   # what it thinks is pending
cd services/reporter && node dist/index.js start    # the loop, with the alarm armed
```

The deadline alarm fires at `reportDeadline − margin`, not at the deadline.
Leave the margin generous.

**A second, quieter risk:** the measured pool has not traded since epoch 2
opened, so `realizedVariance` is 0 and the epoch would settle at a payoff of 0 —
a claim that pays nothing. If the demo needs a non-zero payout on the real pool,
someone has to drive swaps on it before `endBlock`:

```bash
cd contracts
POOL_FEE=3000 POOL_TICK_SPACING=60 ROUNDS=6 SWAP_SIZE=100000000000000000 \
  forge script script/DemoVolatility.s.sol --rpc-url $UNICHAIN_SEPOLIA_RPC \
  --private-key $PRIVATE_KEY --broadcast --slow
```

Send transactions **one at a time** — Unichain rejects multi-tx broadcasts with
`in-flight transaction limit reached for delegated accounts`, and the swaps
above may need to be `cast send` calls instead. Check the router allowances
first; a missing `approve` shows up as `panic: arithmetic underflow` on these
mocks, not as a revert string.

---

## 3. Frontend — one gap fixed, one still open, one recommendation

**The reachability gap is fixed as of 2026-09-06.** The subscriber-level view
of a live subscription (`funded`, `runwaySeconds`, `coveredSeconds`) previously
had no reachable route — you could only see it by connecting the exact wallet
that holds the subscription. `apps/web/app/app/markets/page.tsx` now reads
`readSubscription(LIVE_EPOCH_ID, DEMO_SUBSCRIBER_ADDRESS)` server-side (a plain
view call, no wallet needed) and a new `SubscriberPanel` in `LiveFeed.tsx`
renders it publicly on `/app/markets`, including an honest message when
coverage has lapsed — the most valuable state the protocol has, now visible to
every visitor rather than only whoever holds one specific key. The same pass
also fixed `LiveFeed.tsx`'s stat rows, which used `flex-wrap` with a different
number of stats per panel and looked visually unaligned across the two-column
layout; they are now a consistent CSS grid.

**`adjust` is in the ABI but wired to nothing.** Still true, still deliberate —
the subscriber card in
`apps/web/app/app/components/volatus/LiveStreamActions.tsx` *could* offer a
human-triggered re-rate now that `adjust` is deployed. Not wired, because
whether a human should be able to re-rate their own coverage by hand is a
product decision, not a bug.

**Screenshots still were never taken.** `FRONTEND_VERIFIER.md`'s governing rule
is that a check answered from the code does not count, and that still holds
for the new panel: it was verified by reading the rendered HTML output over
`curl`, not from an actual screenshot at three widths. **Phase 2's "honest
empty states" claim, and now this panel's layout claim, are asserted from
markup, not verified from an image.** Run the verifier before believing either.

---

## 4. Phase 7 — Gateway Nanopayments relay: deliberately not built

`BACKEND_HANDOFF.md` says to skip it for the demo, and that judgment held. Arc
gas is sub-cent USDC with sub-second finality, so direct `fund()` top-ups
already give per-second granularity in practice. Gateway is the scaling story,
not a prerequisite.

Two unknowns flagged in `PROGRESS.md` are **still unresolved** and should be
settled before it is promised anywhere: whether Nanopayments' hosted
verification needs an API key or allowlist, and what a realistic per-second
stream actually costs. Arc Testnet is Gateway domain 26. See
`.agents/skills/use-gateway/`.

---

## 5. Decisions that are someone's, not the code's

- **Who holds the reporter key?** It is currently a fresh testnet throwaway that
  passed through an agent session, and lives only in whoever ran that session's
  local `services/.env.local` — confirmed 2026-09-06 that it is **not** the
  person picking up this handoff next; it needs to come from whoever holds it.
  A 2-of-3 multisig is the right answer before this is anything but a demo. It
  is `immutable`, so changing it means another redeploy.
- **`reclaimUnreported` does not `_sync` first** (`DECISIONS.md` §15). On the
  fail-safe path the split between a subscriber's refund and underwriter income
  therefore depends on when someone last called the permissionless `sync`. It is
  not a theft vector and it leans the same fail-safe direction as the rest of
  the contract, so it was documented rather than fixed. **If `SigmaStream` is
  ever redeployed, add the `_sync` — it is one line.**
- **~3 USDC is stranded** on the dead `SigmaStream` at `0xD7EeD2a6…C074`.
  Testnet, low stakes. `withdrawCapacity` it out only if the team holds shares.

---

## Running any of it

```bash
pnpm install
pnpm -r build

cp services/.env.example services/.env.local   # then fill in the keys
cd services/reporter    && node dist/index.js status
cd services/keeper      && node dist/index.js status
cd services/hedger      && node dist/index.js status
cd services/underwriter && node dist/index.js status
```

Every service has `status` (always read-only, never sends) and `DRY_RUN=1`
(evaluates everything, sends nothing). **Start with `status` on all four** — it
is the fastest way to see what the chain actually looks like right now, and none
of it can spend anything.

**The hedger's `status` needs zero credentials at all** — `index.ts` never
constructs a signer for it, so it is always safe to run, even with nothing in
`.env.local` but the two RPC URLs. `once`/`start` read `HEDGER_SIGNER_MODE`
(`local` default, or `privy` — see §1) to decide which signer to build, and
throw with a clear message if that mode's required config is missing, rather
than silently falling back to the other.

**Getting the keeper running for real needs no coordination with anyone** —
`sync()` is permissionless. Generate a throwaway key, fund it a few dollars of
Arc testnet USDC via [faucet.circle.com](https://faucet.circle.com), put it in
`KEEPER_PRIVATE_KEY`/`KEEPER_ADDRESS`, then `cd services/keeper && node
dist/index.js start`. It picks up exactly where its registry/journal left off
on restart.

Full checks: `pnpm -r test` (335), `cd contracts && forge test` (167),
`pnpm -F web build`.

**A drift trap to know about:** `packages/onchain/test/drift.test.ts` iterates
every constant `apps/web`'s onchain copy exports and fails if
`@volatus/onchain` doesn't export the same name with the same value. Adding a
constant to one tree without the other (e.g. `DEMO_SUBSCRIBER_ADDRESS`,
2026-09-06) fails this test immediately — `pnpm -r test` catches it, so run
that before pushing any change to either `addresses.ts`.
