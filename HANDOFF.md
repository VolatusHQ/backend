# Handoff — what is left

Written 2026-09-05, at the end of the backend pass. What is **done** is in
[`BACKEND_PROGRESS.md`](./BACKEND_PROGRESS.md); this file is only the open work,
ordered by what actually blocks a demo.

Nothing here is blocked on code that does not exist. Most of it is blocked on
credentials, on a clock, or on someone deciding something.

---

## 1. Two credentials, and the claims that depend on them

**This is the largest honesty gap in the repo right now.** Both delegation paths
are written and unit-tested against mocked clients. **Neither has ever run
against a live API**, because no credentials are provisioned in this
environment.

| | Needs | Where |
|---|---|---|
| Privy session signer | `PRIVY_APP_ID`, `PRIVY_APP_SECRET` | `services/hedger/src/delegation/privySessionSigner.ts` |
| Circle agent wallet | `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `CIRCLE_WALLET_ID` | `services/underwriter/src/wallet/circleAgentWallet.ts` |

Until someone runs them, the README's central security claim —

> a fully compromised Volatus backend cannot move a user's funds anywhere except
> into premium payments on the pool they authorised, and cannot exceed the
> mandate

— is **designed for and not demonstrated**. The live hedger run used
`localSigner`, which holds a key directly, refuses to construct without
`HEDGER_ALLOW_LOCAL_SIGNER=1`, and **does not provide that property**. Do not
present the recorded `adjust` as proof of the delegation model; it is proof of
the re-rating loop.

To close it: create a Privy app, provision a session signer under the policy in
`services/hedger/policy/sigma-hedger-v1.json`, and run
`HEDGER_SIGNER_MODE=privy node dist/index.js once`. The policy must allow the
USDC `approve` to `SigmaStream` only — without it `fund` reverts, and it is easy
to miss.

If Privy's policy engine cannot express the mandate, the documented fallback is
a Circle Modular Wallet (ERC-4337 + ERC-6900) with a session-key module expiring
at `coverageEnd` — the same guarantee enforced on chain instead of in a TEE.
See `.agents/skills/use-modular-wallets/`.

**Note:** Circle's CLI spending policies are **mainnet-only**. On testnet the
caps live in `services/underwriter/src/caps.ts` and the journal. Do not imply
Circle enforces anything on this network.

---

## 2. Arc epoch 2 — a real deadline, on a clock

Arc epoch 2 is open and unreported. `reportDeadline` is **1789239788**
(2026-09-12). The vault's epoch 2 ends at Unichain block **62301001**.

If the reporter is not running when that block passes, and nobody reports before
the deadline, **every subscriber is refunded and every underwriter reclaims
capacity**. That is the fail-safe working, but it is not the demo.

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

## 3. Frontend — one real gap, one recommendation

**Not reachable in the shipped UI.** `PHASES.md` phase 4 is `🔶` for a reason
that survived this pass: the subscriber-level view of a live subscription
(`funded`, `runwaySeconds`, `coveredSeconds`) has **no reachable route**. Arc
epoch 2's subscription has run dry, which is the lapsed-coverage fail-safe
happening for real on chain, and a visitor cannot see it. That is the most
valuable honest state the protocol has and it is invisible.

**`adjust` is in the ABI but wired to nothing.** It is deployed now, so the
subscriber card in `apps/web/app/app/components/volatus/LiveStreamActions.tsx`
*could* offer it. Deliberately not wired in this pass — the recommendation is to
add it, but it is a product decision, not a bug.

**Screenshots were never taken.** `FRONTEND_VERIFIER.md`'s governing rule is
that a check answered from the code does not count. No route was captured at
three widths in this pass. **Phase 2's "honest empty states" claim is therefore
asserted, not verified.** Run the verifier before believing it.

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

- **Who holds the reporter key?** It is currently a fresh testnet throwaway in
  `services/.env.local` that passed through an agent session. A 2-of-3 multisig
  is the right answer before this is anything but a demo. It is `immutable`, so
  changing it means another redeploy.
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

Full checks: `pnpm -r test` (331), `cd contracts && forge test` (167),
`pnpm -F web build`.
