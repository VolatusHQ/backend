# Backend handoff — Arc streaming services

**You own phases 5–7 of [`PHASES.md`](./PHASES.md).** This file is self-contained: everything
needed to build them is here or linked from here. You do not need to read the frontend code.

Four services, in dependency order:

| # | Service | Blocks | Priority |
|---|---|---|---|
| 1 | **Settlement reporter** | every payout on Arc | **do this first** |
| 2 | **`sync` keeper** | the live meter, underwriter income | **do this second** |
| 3 | **Hedger agent** | the "continuously repriced" claim | Circle prize surface |
| 4 | **Underwriter agent** | the sell side | Circle prize surface |
| 5 | Gateway Nanopayments relay | nothing — optional | last, or never for the demo |

Services 1 and 2 are plain keepers: read a chain, send a transaction, no AI, no prompts. They
unblock the demo. Services 3 and 4 are the agents the Circle track wants to see.

---

## Ground truth

> **Superseded 2026-09-05 — read this box first.** Everything below this box was verified
> 2026-09-04, against the *old* `SigmaStream` (`settlementReporter` immutable, set to a key
> nobody holds) and the *old* `SigmaOracle` (`curator` immutable, same problem). Both were
> redeployed on 2026-09-05 and Phase 5 (this file's own Services 1–2) then ran for real,
> end to end, against the new ones:
>
> | | Address | Note |
> |---|---|---|
> | `SigmaStream` (live) | `0x6C35BEC76B7c43DDdbF0b46E3402D1461b4233D9` | has `adjust`; old one at `0xD7EeD2a6…C074` did not |
> | `settlementReporter` | `0xFf54812Fc9EC92E51a22f67a92Cd2c09a049E30c` | team-held, replaces `0x364EDC06…5609` |
> | `SigmaOracle` (live) | `0x94F50Fb5b417024F66A80d6515b52E25426C59e5` | replaces `0xd7602c41…a7c` |
>
> Proof, not assertion: `openEpoch(3)` → variance accrued from real swaps → `sync` found the
> subscription from its `Subscribed` log → `settle(3)` on Unichain (payoff `1e18`) →
> `reportPayoff(3)` on Arc (tx `0x4d600f4a70f37c248a01014e8b217e6c5d86a1bc15f133ab7f5385b76f8b67b7`)
> → `claim(3)` paid **1.941588 USDC** + 0.169 refund (tx
> `0xb12bf74c5145cec384ff1e363387706c6c8624a678e31060da1ca99821722bc8`). Arithmetic reconciled
> exactly: `2_000_000 × 1.0 × 831/856 = 1_941_588`.
>
> Live now: Arc epoch 2 is open, unreported, `coverageEnd 1789153388`; its one subscription has
> **run dry** (`funded 0`, `runwaySeconds 0`) — the lapsed-coverage fail-safe, not a bug. Epoch 3
> is reported and claimed. `capacityPool ≈ 5889412`, `totalShares = 5000000`.
>
> The rest of this section (2026-09-04 state, old addresses, "epoch 1 unreported") is left
> intact below because Services 1 and 2 are already built against it and their logic does not
> change — it is the situation that motivated the redeploy, not a live target any more. Use the
> box above for addresses; use the prose below for how the services reason about the chain.

Verified live 2026-09-04 by direct RPC call. Reproduce any of it with the `cast` commands below.

### Chains

| | Chain ID | RPC | Native gas |
|---|---|---|---|
| Unichain Sepolia | `1301` | `https://sepolia.unichain.org` | ETH |
| Arc Testnet | `5042002` | `https://rpc.testnet.arc.network` | **USDC** |

On Arc, USDC is *simultaneously* the native gas asset (18-decimal view) and the ERC-20 at
`0x3600000000000000000000000000000000000000` (**6 decimals**). They are the **same funds**. Never
add them together, and remember your reporter/keeper wallets pay gas in USDC.

### Contracts

**Unichain Sepolia — measurement, collateral, settlement**

| Contract | Address |
|---|---|
| `SigmaHook` | `0x9215C247Ec3C0082A4bfC26515427c2737D1d040` |
| `SigmaVault` | `0xF45894c8384c440FC63Da67Bc6050e77FcaF4e83` |
| `SigmaOracle` | `0xd7602c41f01dD3a91F8768869D95f9529a112a7c` |
| mWETH / mUSDC | `0xde45563c9c596fC761e3a18ABB66aE51904de0F4` / `0xd00FaDdE160cecbB3ad946BE3542b9553c5B582B` |

Measured pool id: `0xc60f25d0a8e2ec722cc0d7f2cff8179340bd5a034351319ada88292d23f21b89`

**Arc Testnet — premium stream**

| Contract | Address |
|---|---|
| `SigmaStream` | `0xD7EeD2a64762A7038d64886882161bA1b1EfC074` |
| USDC (ERC-20 view) | `0x3600000000000000000000000000000000000000` |

ABIs: run `forge build` in `contracts/`, then read `contracts/out/<Name>.sol/<Name>.json` → `.abi`.

### Current on-chain state, and two things it tells you

```bash
# Unichain — the oracle answers
cast call 0xd7602c41f01dD3a91F8768869D95f9529a112a7c \
  "tryImpliedVol(bytes32)(bool,uint256)" \
  0xc60f25d0a8e2ec722cc0d7f2cff8179340bd5a034351319ada88292d23f21b89 \
  --rpc-url https://sepolia.unichain.org
# -> true, 9229318295930859826   (922.93% annualized)

# Arc — capacity is real
cast call 0xD7EeD2a64762A7038d64886882161bA1b1EfC074 "capacityPool()(uint256)" \
  --rpc-url https://rpc.testnet.arc.network
# -> 3002200   (3.0022 USDC: 3 posted + 0.0022 premium already earned)

cast call 0xD7EeD2a64762A7038d64886882161bA1b1EfC074 \
  "epoch(uint256)((uint64,uint64,uint64,bool,uint256,uint256))" 1 \
  --rpc-url https://rpc.testnet.arc.network
# -> (1788410886, 1788414475, 1788500875, false, 0, 22000000)
#     coverageStart coverageEnd reportDeadline reported payoffWad totalCoverageSold
```

1. **Unichain epoch 1 has ended but is not settled.** `vault.activeEpoch(poolId)` is still `1`
   and the hook's `pendingSnapshot` is set. `settle(1)` has not been called.
2. **Arc epoch 1 is unreported and its report window closes at `reportDeadline` = 1788500875
   (2026-09-04 05:47 UTC).** It had 21 minutes left when this was written, so by the time you
   read this it has almost certainly **lapsed**. `totalCoverageSold` is `22000000` — 22
   USDC-seconds of real coverage was sold against a funded subscriber.

   Confirm which world you are in before planning around it:

   ```bash
   cast block latest --rpc-url https://rpc.testnet.arc.network --field timestamp
   # compare against reportDeadline = 1788500875
   ```

   - **Lapsed (expected).** `reportPayoff(1, …)` reverts `ReportWindowClosed` and is
     unrecoverable. Epoch 1 becomes the **demonstrated fail-safe**: `reclaimUnreported(1)`
     returns the subscriber's unspent premium and underwriters withdraw capacity. That is a
     genuinely good thing to show — the refund path proven on chain, not asserted. Build the
     reporter against a **new** epoch.
   - **Still open.** Then `settle(1)` on Unichain → `reportPayoff(1, payoffWad)` on Arc →
     `claim(1)` is the fastest real end-to-end payout you will get. Take it.

   Either way the contract behaved correctly; only which story you can demo differs. **The
   lesson to carry into the reporter service: `reportDeadline` is a real operational deadline
   and missing it costs a payout.** Alarm well before it, not on it.

### ⚠ The reporter key was fixed at construction — resolved by the 2026-09-05 redeploy

```bash
# The command below still returns the OLD, dead contract's answer — kept as the historical
# demonstration of the problem. Do not call it expecting the live reporter.
cast call 0xD7EeD2a64762A7038d64886882161bA1b1EfC074 "settlementReporter()(address)" \
  --rpc-url https://rpc.testnet.arc.network
# -> 0x364EDC06254874e62FF4AD8fA4d9a45238cb5609   (a key nobody on the team holds)
```

`settlementReporter` is `immutable`. Only that address can call `openEpoch` and `reportPayoff`,
which is why the old contract above could never be reported against.

**Resolved.** `SigmaStream` was redeployed on 2026-09-05 at `0x6C35BEC76B7c43DDdbF0b46E3402D1461b4233D9`
with `settlementReporter` set to `0xFf54812Fc9EC92E51a22f67a92Cd2c09a049E30c`, a key the team
holds — confirm live with the same `cast call` against the new address. It is the only trust
surface in the contract: it can report a wrong payoff for coverage on Arc, though it can never
touch vault collateral, change what VAR-LONG/VAR-SHORT redeem for, or stop a subscriber
recovering unspent premium. Whether that key should move to a multisig is still open — see the
questions at the end of this file.

---

## Service 1 — Settlement reporter

**Why it exists.** The payoff is measured and settled on **Unichain**. `SigmaStream` is on
**Arc** and cannot read it — there is no synchronous cross-chain call. A reporter carries the
number across. This is `DECISIONS.md` §12; read it before you write code, it explains the
bound on the trust.

**Two jobs, both from the reporter key.**

### 1a. Mirror a new epoch onto Arc

Watch `SigmaVault` on Unichain for `EpochOpened`, then:

```solidity
SigmaStream.openEpoch(uint256 epochId, uint64 coverageEnd, uint64 reportDeadline)
```

- `epochId` — the **same** id the vault used. They must match; nothing enforces it.
- `coverageEnd` — a **unix timestamp** on Arc. The vault's epoch ends at a **block number** on
  Unichain. Convert: `nowTs + (endBlock - currentBlock) * ~1s` (Unichain is ~1s/block). Be
  slightly conservative — coverage ending a little early is safe; ending late sells coverage for
  a period the payoff does not cover.
- `reportDeadline` — `coverageEnd + a real operational margin`. This is your own deadline: miss
  it and every subscriber gets refunded and every underwriter reclaims capacity. 24h is
  reasonable on testnet. Do not set it tight to look responsive.
- Reverts `EpochExists` if already opened. Idempotency: read `stream.epoch(epochId)` and skip
  when `coverageEnd != 0`.

### 1b. Settle on Unichain, then report to Arc

1. Once `block.number >= epoch.endBlock`, call **`SigmaVault.settle(epochId)`** on Unichain.
   It is **permissionless** — you do not need a privileged key. It also handles the case where
   the pool never traded again after the boundary, and calls `hook.releaseSnapshot` so the pool
   can host the next epoch. **You do not need to nudge a swap to make settlement possible.**
2. Read the payoff: `SigmaVault.epoch(epochId)` → the `Epoch` struct; take **`payoffWad`** (the
   last field) and check `settled == true`. Or take it from the `EpochSettled(epochId,
   realizedVariance, payoff)` event.
3. Call on Arc:

```solidity
SigmaStream.reportPayoff(uint256 epochId, uint256 payoffWad)
```

Preconditions, all of which revert:

| Revert | Cause |
|---|---|
| `NotReporter` | wrong sender |
| `NoSuchEpoch` | `openEpoch` was never called for this id |
| `EpochNotOver` | `block.timestamp < coverageEnd` |
| `ReportWindowClosed` | `block.timestamp > reportDeadline` — **unrecoverable** |
| `AlreadyReported` | already done; it is one-shot and immutable |
| `PayoffOutOfRange` | `payoffWad > 1e18` |

`payoffWad` is WAD in `[0, 1e18]` and passes through **unchanged** from the vault — do not
rescale it. Coverage payouts on Arc are 6dp USDC, but the payoff is a WAD ratio; the contract
does that multiplication.

**Acceptance.** For a fresh epoch: `openEpoch` lands, a subscriber funds and accrues covered
seconds, `settle` runs on Unichain, `reportPayoff` lands on Arc inside the window, and the
subscriber's `claim(epochId)` pays out a non-zero amount. Tx hashes on both explorers.

**Operational must-haves.** Persist `(epochId → openEpoch tx, settle tx, reportPayoff tx)` so a
restart never double-sends or, worse, silently skips. Alert loudly when `now > reportDeadline -
margin` and the report has not landed — that alarm is the difference between a payout and a
mass refund.

---

## Service 2 — `sync` keeper

```solidity
SigmaStream.sync(uint256 epochId, address subscriber)   // permissionless
```

**Why it exists.** Premium accrual is **lazy**. `coveredSeconds` and the transfer of earned
premium from `subscription.funded` into `capacityPool` only advance when someone calls `sync`.
Without a keeper: the UI meter sits still then jumps, and underwriters see no income until
someone happens to poke the contract.

**What it does not do.** It does not move a subscriber's money anywhere they did not already
commit it — the funds are already inside `SigmaStream`, earmarked to that epoch. It is pure
arithmetic on deposited balances. That is why it is safe to leave permissionless, and it is why
**nothing signs per second.** Signatures are needed only for `subscribe`, `fund`, and `adjust`.

**Shape.** Every 30–60s, for each active subscription, call `sync`. Discover subscriptions from
`Subscribed` events on Arc; drop one when `stream.subscription(epochId, who).ratePerSecond == 0`,
when `runwaySeconds` is 0 and `funded` is 0, or when the epoch is past `coverageEnd`. Batch where
you can — one tx per subscriber is fine at demo scale, but gas is USDC so keep the wallet funded.

`_sync` is a no-op when nothing has elapsed, so over-calling is harmless. Under-calling is not:
it delays underwriter income and makes the meter lie.

**Acceptance.** `runwaySeconds` decreases monotonically without anyone touching the UI, and
`capacityPool` grows by exactly `elapsed × ratePerSecond` over a measured interval.

---

## Service 3 — Hedger agent

Per `README.md` §The Agents: *signal → position gamma × live accumulator, IV from the vol pool;
action → adjusts streamed rate and coverage notional; cadence → every tick.*

**Loop.**

1. Read `SigmaOracle.tryImpliedVol(poolId)` on Unichain. If `ok == false`, do nothing — never
   act on a missing feed.
2. Read the LP's v4 position and derive gamma exposure.
3. Compute the required `ratePerSecond` and `coverageNotional`.
4. Compare with the live `stream.subscription(epochId, lp)`. If the drift exceeds the mandate's
   tolerance, call `adjust(epochId, newRate, newNotional)` — **the function added in phase 3;
   confirm it is deployed before building this.** Until then the rate is fixed at `subscribe`
   time and this agent has nothing to act on.
5. Top up `fund(epochId, amount)` when `runwaySeconds` falls below a floor, within the mandate's
   cumulative cap.

**Do not re-rate every block just because you can.** Every adjust is a transaction and a `_sync`.
Re-rate on material IV drift, and put the threshold in the mandate so the user chose it.

### Delegation — this is the security-critical part

The agent must **never** hold the user's key. Per `README.md`, Privy secures the delegation via a
session signer under a TEE-enforced policy:

```
Policy: sigma-hedger-v1
  |- allow  method: streamPremium | adjustCoverage
  |- allow  target: SigmaStream only
  |- deny   all ERC20 transfers to other recipients
  |- cap    cumulative spend <= declared mandate
```

Property to preserve: **a fully compromised Volatus backend cannot move a user's funds anywhere
except into premium payments on the pool they authorised, and cannot exceed the mandate.**

Map the policy's method names onto the real ABI — `subscribe`, `fund`, `adjust` — and keep
`target` pinned to the `SigmaStream` address. Also allow the USDC `approve` to `SigmaStream`
only, or `fund` will revert.

The alternative, if Privy's policy engine cannot express this: a **Circle Modular Wallet (MSCA,
ERC-4337 + ERC-6900) with a session-key module** — same guarantees, enforced on-chain instead of
in a TEE, expiring at `coverageEnd`. See `.agents/skills/use-modular-wallets/`.

**Never** generate a plain EOA for the user and hold its key. See `PHASES.md` § Custody.

---

## Service 4 — Underwriter agent

*Signal → realized-vs-implied spread, inventory concentration; action → requotes offered rate,
withdraws capacity as risk concentrates.*

- Spread: `oracle.realizedVol(poolId)` vs `oracle.tryImpliedVol(poolId)`, both WAD on Unichain.
- Capacity: `postCapacity(amount)` / `withdrawCapacity(shareAmount)` on Arc. Needs a USDC
  `approve` to `SigmaStream` first.
- Utilization: `capacityPool` against the sum of subscribed `coverageNotional` — `subscribe`
  reverts `InsufficientCapacity` when notional exceeds the pool, so withdrawing capacity can
  block new subscriptions. That is intended; surface it rather than working around it.
- Shares are minted against the pool's **current** value, so premium already earned accrues to
  whoever was exposed when it was earned. Withdrawing realizes your share of premium and of any
  claims paid.

Holds a **Circle agent wallet** with a spending policy — see `.agents/skills/use-agent-wallet/`
and `.agents/skills/agent-wallet-policy/`. Note the CLI's spending policies are **mainnet-only**;
on testnet enforce caps in your own code.

---

## Service 5 — Gateway Nanopayments relay (optional)

`SigmaStream` deliberately knows nothing about Gateway. Premium arrives as ordinary USDC; the
cheapness of topping up is what makes per-second granularity viable and it happens entirely off
the contract.

If you build it: the LP's USDC sits in a Gateway Wallet as a unified balance, the client signs
burn intents / EIP-3009 authorizations for sub-cent amounts, your relay posts them to Gateway's
REST API for attestation, and `gatewayMint` on Arc lands USDC that then goes into `fund()`. Arc
Testnet is Gateway domain **26**; both it and Unichain Sepolia are supported. See
`.agents/skills/use-gateway/`.

**Skip it for the demo.** Arc gas is sub-cent USDC with sub-second finality, so direct `fund()`
top-ups already deliver per-second granularity in practice. Gateway is the scaling story.

Two unknowns flagged in `PROGRESS.md` and still unresolved: whether Nanopayments' hosted
verification requires an API key or allowlist, and what a realistic per-second stream actually
costs. Resolve both before promising this in a demo.

---

## Units — the table to keep open

Getting one of these wrong produces a plausible, wrong number rather than an error.

| Quantity | Scale | Where |
|---|---|---|
| `impliedVol`, `realizedVol` | WAD, `1e18` = 100% | Unichain |
| `realizedVariance`, `strikeWad`, `capWad` | WAD, over the **epoch horizon**, not annualized | Unichain |
| `payoffWad` | WAD in `[0, 1e18]` | Unichain → Arc, **unchanged** |
| `normalizedImpliedVariance` | WAD in `[0, 1e18]` — a *price*, not a vol % | Unichain |
| Collateral, `funded`, `capacityPool`, `coverageNotional` | **6 decimals** | Arc + vault |
| `ratePerSecond` | 6dp USDC per second | Arc |
| Arc native gas balance | 18-decimal view of the same USDC | Arc |
| Ticks, accumulator, `coveredSeconds`, `observations` | plain integers — never scale | Unichain / Arc |

`SigmaStream` uses `block.timestamp`, not block numbers, deliberately: a rate quoted per second
must not change meaning when block times drift. Your `coverageEnd` conversion is the one place
Unichain block numbers meet Arc timestamps — get it right and nothing else has to care.

---

## Environment

```bash
UNICHAIN_SEPOLIA_RPC=https://sepolia.unichain.org
ARC_TESTNET_RPC=https://rpc.testnet.arc.network

SIGMA_HOOK=0x9215C247Ec3C0082A4bfC26515427c2737D1d040
SIGMA_VAULT=0xF45894c8384c440FC63Da67Bc6050e77FcaF4e83
SIGMA_ORACLE=0x94F50Fb5b417024F66A80d6515b52E25426C59e5
SIGMA_STREAM=0x6C35BEC76B7c43DDdbF0b46E3402D1461b4233D9   # redeployed 2026-09-05, see § Ground truth
ARC_USDC=0x3600000000000000000000000000000000000000
MEASURED_POOL_ID=0xc60f25d0a8e2ec722cc0d7f2cff8179340bd5a034351319ada88292d23f21b89

REPORTER_PRIVATE_KEY=   # the only privileged key. Secret store, never a repo, never a log.
KEEPER_PRIVATE_KEY=     # unprivileged; needs USDC on Arc for gas
PRIVY_APP_ID=
PRIVY_APP_SECRET=
CIRCLE_API_KEY=
CIRCLE_ENTITY_SECRET=
```

`contracts/.env.example` already exists — extend it rather than starting a new convention.

---

## Failure modes to handle deliberately

| Situation | Correct behaviour |
|---|---|
| `tryImpliedVol` returns `ok = false` | do nothing. Never substitute a guess for a missing feed |
| Report window missed | accept it. Everyone is refunded; do not try to patch around it. Alarm *before* it happens |
| Subscriber runs dry mid-epoch | nothing to do. Coverage lapses at that second, pro-rata. This is the fail-safe direction |
| Arc RPC down | streams stop, coverage lapses, nothing is stuck. Settlement on Unichain is unaffected |
| Keeper offline | premium still owed and still collected on the next `sync`; only the meter and underwriter income lag |
| `subscribe` reverts `InsufficientCapacity` | an underwriter withdrew. Surface it; do not auto-reduce the user's requested notional without telling them |
| Epoch ended, `settle` not yet called | `activeEpoch` stays non-zero and the oracle returns the last traded price. Call `settle` — it is permissionless |

The liveness property to preserve, from `README.md`: **Arc is a payment rail for a subscription
and is never part of settlement.** If Arc, Gateway, the agents or the reporter are unavailable,
streams stop and coverage lapses — nothing is stuck, nothing is at risk, and no settlement
depends on an off-chain component. Do not build anything that breaks that sentence.

---

## Reading list, in order

1. `DECISIONS.md` §12 — why the reporter exists and exactly what it is trusted with.
2. `contracts/src/SigmaStream.sol` — the contract doc comment is the design rationale.
3. `contracts/test/integration/SigmaStream.t.sol` — 22 tests; the names are the spec.
   Especially `test_coverageLapsesWhenPremiumRunsDry`,
   `test_partiallyFundedSubscriberIsPaidProRata`,
   `test_ifTheReporterNeverReportsEveryoneGetsTheirMoneyBack`,
   `test_toppingUpDoesNotBackdateCoverage`.
4. `INTEGRATION.md` — the oracle surface, units, failure modes.
5. `README.md` §The Agents — the delegation policy you have to reproduce.
6. `PHASES.md` — where your work sits relative to the frontend.

Questions that need a decision from the team, not from you:

- The redeploy set the reporter to a single team-held EOA (`0xFf54812Fc…9E30c`). Should it move
  to a multisig? (still open, multisig strongly preferred for anything beyond testnet)
- What `reportDeadline` margin is acceptable?
- Privy session signer, or Circle Modular Wallet session key?
