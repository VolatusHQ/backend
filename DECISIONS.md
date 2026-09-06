# Decisions and deviations

Every place the built protocol departs from what `README.md` specifies, why, and the evidence.

`README.md` is the product spec and stays the statement of intent. This file is the running
record of where reality pushed back. **Nothing is recorded here as a deviation unless it was
verified — each entry names the test, measurement or on-chain call that establishes it.**

If you are updating the README to match, work from this file. If you are reviewing the
contracts and something contradicts the README, look here before assuming it is a bug.

Status key: **Applied** — in the code today. **Planned** — agreed, not yet built.

---

## Index

| # | Deviation | Severity | Status |
|---|---|---|---|
| [1](#1-variance-legs-are-erc-20-not-erc-6909) | Variance legs are ERC-20, not ERC-6909 | **Architectural** | Applied |
| [2](#2-the-accumulator-is-lifetime-monotonic-not-per-epoch) | Accumulator is lifetime-monotonic, not per-epoch | Architectural | Applied |
| [3](#3-the-hook-becomes-epoch-aware-at-the-settlement-boundary) | Hook becomes epoch-aware at the settlement boundary | Architectural | Applied |
| [4](#4-afterinitialize-is-enabled-as-well-as-afterswap) | `afterInitialize` enabled as well as `afterSwap` | Minor | Applied |
| [5](#5-basehook-now-comes-from-openzeppelin-uniswap-hooks) | `BaseHook` comes from OpenZeppelin `uniswap-hooks` | Dependency | Applied |
| [6](#6-a-redeemed-pair-returns-at-most-1-usdc-not-exactly-1-usdc) | A redeemed pair returns *at most* 1 USDC | Correctness | Applied |
| [7](#7-later-swaps-in-a-block-are-cheap-not-free) | Later swaps in a block are cheap, not free | Copy accuracy | Applied |
| [8](#8-contracts-keep-the-sigma-prefix-while-the-product-is-volatus) | Contracts keep the `Sigma` prefix | Naming | Applied |
| [9](#9-the-vault-credits-what-actually-arrived-not-what-was-requested) | Vault credits what arrived, not what was requested | Correctness | Applied |
| [10](#10-epochs-declare-their-horizon-in-seconds) | Epochs declare their horizon in seconds | Minor | Applied |
| [11](#11-the-oracle-needs-a-curator-to-name-the-vol-pool) | The oracle needs a curator to name the vol pool | Trust surface | Applied |
| [12](#12-sigmastream-needs-the-payoff-reported-across-chains) | `SigmaStream` needs the payoff reported across chains | Trust surface | Applied |
| [13](#13-the-hooks-privileged-address-cannot-come-from-msgsender) | The hook's privileged address cannot come from `msg.sender` | **Bug, found by deploying** | Applied |
| [14](#14-a-quiet-epoch-locked-its-pool-out-of-every-future-epoch) | A quiet epoch locked its pool out of every future epoch | **Bug, found by settling** | Applied |

---

## 1. Variance legs are ERC-20, not ERC-6909

**README says:** `VarianceToken.sol # ERC-6909 VAR-LONG / VAR-SHORT`, and lists ERC-6909 in the
Uniswap stack table as *"Variance tokens use the same claims standard PoolManager itself uses."*
It also requires `VAR-LONG` to trade in its own v4 pool against USDC — the step the Demo section
calls *"the moment the project lands."*

**Those two requirements are mutually exclusive.** An ERC-6909 cannot be a Uniswap v4 pool
currency.

**Evidence.** Two independent proofs, both in
`contracts/test/integration/PoolCurrencyConstraint.t.sol`:

- `test_currencyLibraryCallsDoNotExistOnAnErc6909` issues the exact two calls `CurrencyLibrary`
  makes against an ERC-6909. Both fail with **zero returndata** — meaning no such function
  exists, which no approval can fix. The selectors do not overlap:

  | | ERC-20 | ERC-6909 |
  |---|---|---|
  | transfer | `transfer(address,uint256)` `0xa9059cbb` | `transfer(address,uint256,uint256)` `0x095bcdb6` |
  | balance | `balanceOf(address)` `0x70a08231` | `balanceOf(address,uint256)` `0x00fdd58e` |

- `test_poolOverAnErc6909Initializes` and `test_poolOverAnErc6909CannotHoldLiquidity` show the
  trap in full: a pool over an ERC-6909 **initializes successfully**, because initialization
  touches no balances, and then reverts the moment liquidity is added. Operator approval is
  granted in `setUp` specifically so the failure cannot be attributed to an allowance.

**The deeper reason, which outranks the selectors:** `type Currency is address` — a pool currency
is identified by address *alone*. One address is exactly one tradable token, with nowhere to put
a token id. This rules out every multi-token standard, not just today's ERC-6909.

**Decision.** `VarianceToken` becomes a minimal, clone-initializable ERC-20. `SigmaVault` deploys
one VAR-LONG and one VAR-SHORT per epoch with `Clones.cloneDeterministic`.

**Why not keep ERC-6909 for accounting and wrap only the traded leg?** Because it does not pay
for itself. That design still deploys one ERC-20 wrapper per traded leg per epoch, so it saves a
single clone — **41,319 gas measured**, against an 891,028-gas full deploy — and in exchange adds
a wrap/unwrap step to every trade and a second ledger the solvency invariant must span. Two legs
per epoch costs ~82k gas total, which is roughly two thirds of one swap.

**Built.** `src/VarianceToken.sol` is a minimal clone-initializable ERC-20 whose supply only the
initializing vault can change. 19 tests in `test/unit/VarianceToken.t.sol` cover it, including
`test_implementationIsInert` (the un-initialized implementation can never mint),
`test_cannotInitializeTwice`, `test_clonesAreIndependent` and
`test_deterministicCloneAddressIsPredictable`.

Two choices worth flagging for review. `transfer` to `address(0)` **reverts** rather than
burning, because a leg burned outside the vault would strand collateral with no claim against
it. And `decimals` is set at initialization from the collateral token rather than fixed at 18,
so a leg mirrors USDC's 6.

**Bonus the README did not anticipate:** `cloneDeterministic` makes the VAR-LONG address
computable *before* the epoch opens, so the vol pool's `PoolKey` is known in advance rather than
discovered after deployment.

`SigmaVault` creates both legs per epoch with `cloneDeterministic`, and exposes `predictLeg` so
the vol pool's `PoolKey` can be built before the epoch is opened —
`test_legAddressIsPredictableBeforeTheEpochOpens`.

**README edits: done.** The Project Structure line, the Uniswap Stack Integration row, the
architecture diagram, the Solution section and the Where to Look entry now describe ERC-20 legs
and say why.

> **Unverified, do not repeat as fact:** whether the vault can use *PoolManager's own* ERC-6909
> claims when seeding or settling the vol pool — which would restore the stack-table row
> honestly — has **not** been tested. Treat it as an open question, not a plan.

---

## 2. The accumulator is lifetime-monotonic, not per-epoch

**README says:** `VarianceState` holds a per-epoch accumulator, and describes
`realizedVariance(epoch)` as a sum over the epoch.

**Built instead:** one accumulator per pool that only ever grows, never resets. An epoch's
variance is the difference between two snapshots of it.

**Why.** Three things fall out for free. The hook does not need to know epochs exist, so no
epoch bookkeeping sits on the swap path. There is no per-epoch state for a settlement transaction
to race. And it makes the README's own "the accumulator is append-only" claim literally true
rather than aspirational.

**Evidence.** `test_accumulatorIsMonotonic`, `test_windowsCompose`, `test_poolsAreIsolated`.

**Caveat found while testing:** the accumulator composes *exactly* (integer addition), but
converting to variance floors once per window, so splitting a window loses up to a wei. Asserted
in the safe direction by `test_windowsCompose`: splitting can lose dust, never manufacture
variance. **Consequence for the vault: settle from accumulator snapshots, never from summed
variances.**

---

## 3. The hook becomes epoch-aware at the settlement boundary

**Applied. This partially walks back #2 and that is deliberate.**

**Problem found while designing the vault:** `settle()` reads the accumulator, but the
accumulator keeps growing after `endBlock`. Settling late folds post-epoch volatility into the
payoff, and settlement timing becomes strategic for whichever side is winning. This number
settles money, so it cannot be approximate.

**Decision.** The vault registers an epoch's `endBlock` with the hook, and the pool's own first
swap at-or-after `endBlock` snapshots the accumulator. Nobody chooses that moment, so there are
no timing games. If no swap has happened since `endBlock`, the live accumulator *is* the end
value and settlement reads it directly.

Movement during the boundary block is excluded — the snapshot is taken before that observation is
applied. That is a deterministic slight undercount, chosen over a manipulable one.

**Cost, measured — not one SLOAD, but none.** `pendingSnapshot` is a `uint48` packed into the
cursor's second storage slot, which already held 24 + 48 + 32 = 104 of its 256 bits. The sampling
gate loads that slot anyway, so the boundary check reads it for free:

| Path | Before | After | Delta |
|---|---|---|---|
| Sampling swap (no epoch registered) | +15,908 | **+16,082** | +174 |
| Later swap in the same block | +3,336 | **+3,336** | 0 |
| The one crossing swap per epoch | — | **+~22,000** | one cold SSTORE |

The +174 is itself the proof the packing worked: a third storage slot would have cost ~20,000,
not 174.

**A second optimization came out of measuring it.** The snapshot was first stored as a value plus
a parallel `bool` "taken" flag — two cold SSTOREs, ~44k, on the crossing block. Storing the value
**plus one** instead lets zero mean "never recorded" while still allowing a legitimate frozen zero
(which a pool that never moved genuinely produces), halving that to ~22k. That block is paid for
by whichever swapper happens to cross the boundary, and they did not ask to fund it.

**Trust surface, stated plainly.** Only `vault` may register a boundary, and `vault` is set once
by the deployer via `setVault` and can never be changed. A permissionless registry was considered
and rejected: anyone could register an *earlier* boundary, consume the single pending slot, and
leave the real epoch permanently unsettleable. This is the hook's only privileged action, and it
cannot mint, move or freeze anything — its whole power is nominating who may ask for a snapshot.
The "no ownership" line in `SigmaHook.sol`'s security notes has been corrected accordingly.

**Evidence.** 12 tests in `test/integration/SigmaHookSnapshot.t.sol`, notably
`test_snapshotExcludesTheCrossingBlocksMovement` (the core semantic),
`test_untradedBoundaryLeavesTheLiveAccumulatorExact` (the branch settlement takes when nobody
traded after the boundary), `test_aFrozenZeroIsDistinguishableFromNeverRecorded` (the plus-one
encoding), `test_setVaultIsOneShotAndDeployerOnly` and `test_cannotOverwriteAPendingBoundary`.

---

## 4. `afterInitialize` is enabled as well as `afterSwap`

**README says:** the hook uses `afterSwap` only.

**Built instead:** `afterInitialize` as well, so the permission bits are
`AFTER_INITIALIZE_FLAG | AFTER_SWAP_FLAG`.

**Why.** Without it the pool's opening tick has no predecessor to difference against and the
first real price move is silently dropped.

**Risk.** LOW in the `v4-security-foundations` matrix. No return-delta permission is enabled, so
the NoOp rug-pull vector does not exist here.

**Evidence.** `test_hookAddressEncodesDeclaredPermissions` asserts the mined address encodes
exactly these two and asserts the dangerous permissions *off* rather than assuming it.
`test_fork_afterInitializeWasCalledByTheRealManager` confirms the live PoolManager invokes it.

---

## 5. `BaseHook` now comes from OpenZeppelin `uniswap-hooks`

**README says:** *"v4-periphery `BaseHook` — hook base class, permission flags, lifecycle
callbacks."*

**Reality — corrected after re-checking.** `BaseHook` has moved twice, and the path Uniswap's
own shipped `v4-security-foundations` skill documents is stale in every version examined:

| Where | `BaseHook` |
|---|---|
| Path in Uniswap's `v4-security-foundations` skill | `v4-periphery/src/base/hooks/BaseHook.sol` — correct in neither version below |
| v4-periphery `7ebd04b1`, pinned inside uniswap-hooks v1.2.1 | `src/utils/BaseHook.sol` |
| v4-periphery `main` at `dbb6104` | absent from `src/` entirely |

An earlier revision of this file claimed BaseHook "no longer exists anywhere in v4-periphery".
That was true of the main-branch commit first installed and **false** of the version now vendored
in the tree, where `src/utils/BaseHook.sol` is present. Corrected here rather than left standing,
since the point of this file is that its claims can be checked.

The project imports OpenZeppelin's `uniswap-hooks` version, which is the maintained successor and
documents itself as based on the v4-periphery implementation. That choice stands — it is pinned,
tagged, and does not move under the build.

**Decision.** `uniswap-hooks` is installed as the single source of `v4-core`, `v4-periphery`,
`permit2` and OpenZeppelin contracts, so exactly one copy of each exists in the tree. The
top-level `v4-periphery` install was removed to prevent two divergent copies of `v4-core`.
`HookMiner` is still from v4-periphery, at `src/utils/HookMiner.sol`.

**README edit: done.** The Stack Integration row now reads `BaseHook` (OpenZeppelin
`uniswap-hooks` v1.2.1) and notes that it moved upstream. Written up for the Uniswap team in
[`FEEDBACK.md`](./FEEDBACK.md).

---

## 6. A redeemed pair returns *at most* 1 USDC, not *exactly* 1 USDC

**README says:** *"The pair always redeems for exactly 1 USDC. Solvency is structural, not
managed."*

**Built instead:** both legs round **down independently**, so a pair redeems for `amount` or
`amount` minus up to 2 wei.

**Why.** Computing the short leg as the complement of the *rounded* long leg looks tidier and
gives exactly 1 USDC — but it lets a set of partial redemptions sum to **more** than the
collateral held. Flooring each leg means the vault can only ever retain dust, never owe it.

**The structural-solvency claim survives, and is in fact strengthened** — the invariant becomes
`collateral >= sum of all redemptions`, which is the one that actually matters.

**Evidence.** `testFuzz_pairNeverRedeemsForMoreThanItMinted` asserts the sum never exceeds the
amount minted, and that the shortfall is never more than 2 wei. Run at 1,000 cases by default and
50,000 under `FOUNDRY_PROFILE=ci`.

Reinforced at the vault level by the stateful invariant suite in
`test/fuzz/SolvencyInvariant.t.sol`, which drives random sequences of mint, burn, leg transfer,
settle and redeem across three actors — **128,000 calls, zero reverts** — and holds four
invariants throughout:

| Invariant | What it rules out |
|---|---|
| `invariant_collateralCoversEveryClaim` | Someone cannot be paid |
| `invariant_neverPaysOutMoreThanWasDeposited` | Value manufactured from nothing |
| `invariant_accountingMatchesRealBalance` | The book drifting above the real balance |
| `invariant_legSuppliesStayEqualUntilSettlement` | Legs diverging, breaking par redemption |

**README edit: done.** Both "exactly one USDC" claims in the Solution and Mechanism sections now
read "at most", with the flooring explained.

---

## 7. Later swaps in a block are cheap, not free

**README says:** *"Zero cost to any swap after the first in a block."*

**Measured:** a later swap costs **~3,336 gas** more than an identical swap through a hook that
does nothing at all.

That is a `PoolKey` hash, a mapping slot hash, one cold SLOAD and one comparison — the minimum
possible for a contract that must check whether it has already sampled. It is not zero.

**Full measurements**, from `test_gas_measurementOverhead` and `test_gas_laterSwapsInBlockAreNearlyFree`,
against three otherwise-identical pools:

| Swap | Gas | Overhead |
|---|---|---|
| No hook at all | 119,875 | — |
| Hook that does nothing | 124,810 | +4,935 (v4's own dispatch) |
| SigmaHook, first in block | 140,892 | **+16,082** (the measurement) |
| SigmaHook, later in block | 128,146 | **+3,336** (one storage read) |

Corroborated on a fork of live Unichain Sepolia — see `test_fork_gasOnTheRealManager`. The
sampling figure includes the +174 the epoch-boundary check from §3 costs.

Two things worth stating plainly: about **5k of any hooked swap is v4 architecture** nobody can
avoid, and the sampling path stays inside the `v4-security-foundations` budget of 30,000 gas for
`afterSwap`.

**A fix came out of this.** The hook originally called `getSlot0` *before* checking whether it
would use the result, so gated swaps paid for a pool read they discarded. Checking the gate first
removed it.

**README edit: done.** The Mechanism section now carries the full four-row measurement instead
of "Zero cost".

---

## 8. Contracts keep the `Sigma` prefix while the product is Volatus

`CLAUDE.md` states the product is **Volatus**; `README.md` and every contract name say
**Sigma**.

**Decision.** Contracts keep `Sigma*` — `SigmaHook`, `SigmaVault`, `SigmaOracle`. They match the
README's "Where to Look" table, which is what a judge reads while verifying the Uniswap
integration, and renaming mid-build breaks that mapping for no functional gain.

Consistent with the existing repo situation: the GitHub repo is still named `sigma` and every
`REPO_URL` still reads `github.com/CodeBlocker52/sigma`, which `CLAUDE.md` already documents as
expected rather than a bug.

---

## 9. The vault credits what actually arrived, not what was requested

**Not in the README either way** — recorded because it is a deliberate choice a reviewer will
otherwise read as noise.

`mintPair` measures the vault's collateral balance before and after the transfer and mints
against the **difference**, rather than against the `amount` argument. With a fee-on-transfer or
otherwise non-standard collateral, minting against `amount` would issue claims on collateral the
vault never received — breaking the one invariant the whole design rests on. USDC is not
fee-on-transfer today, but the vault takes its collateral token as a constructor argument, so
nothing in the code guarantees it never will be.

Related: `burnPair` and `redeem` transfer out with `SafeERC20`, and `VarianceToken` rejects
transfers to `address(0)` so a leg cannot be destroyed outside the vault, which would strand
collateral with no claim against it.

**This choice is what makes a reentrancy guard mandatory, and the combination was very nearly a
hole.** Crediting the observed delta means a re-entrant collateral can have an inner `mintPair`
complete, after which the outer call counts the inner deposit a second time and mints legs
against collateral that already backs someone else's claim. Every state-changing entry point now
carries `nonReentrant` (transient storage, so it is cheap).

`test/fuzz/ReentrancyGuard.t.sol` attacks the vault with a collateral token that calls back
mid-transfer. **The test was verified to fail with the guard removed** — 1,500 units of legs
against 1,000 units of collateral, 500 units of unbacked claims — so it is a real regression test
rather than one that passes for the wrong reason.

> Getting that proof took two attempts. The first harness had the token re-enter without funding
> itself, and because a re-entrant call originates from the *token*, the inner mint drew on the
> token's own zero balance and merely underflowed. The attack looked harmless and the test passed
> with the guard removed. A reentrancy test that cannot land its attack is worse than no test at
> all, because it reads as evidence.

---

## 9b. The manipulation-cost claim is conditional, and the README said it was not

**README said:** *"`test/fuzz/ManipulationCost.t.sol` asserts `cost > gain` across the parameter
space"* — naming a file that did not exist, for an unconditional claim that is not quite true.

**Reality.** There is always *some* `VAR-LONG` position large enough to fund an attack; the
inequality `cost > gain` cannot hold for every coverage size. What the defenses actually do is
push the break-even position far above the attack's cost.

**Measured.** `test/fuzz/ManipulationCost.t.sol` now exists and attacks a real pool with real
swaps rather than asserting a formula against itself:

| | |
|---|---|
| Ten round trips across twenty blocks cost | 0.30 units of currency |
| Variance manufactured moved the payoff by | 0.00144 |
| Break-even `VAR-LONG` position | **694x the attack's cost** |
| Five rounds / twenty rounds | 0.15 / 0.60 — exactly linear |

Three properties are asserted, not just reported: cost scales with blocks used
(`test_costScalesWithBlocksWhileGainIsCapped`); one block buys at most one clamped observation no
matter how large the swap (`testFuzz_biggerSwapsDoNotBuyMoreVariancePerBlock`); and past the cap
extra blocks buy nothing while still costing full price
(`test_pastTheCapExtraBlocksBuyNothing`).

**README edit: done.** The Manipulation Resistance section now carries the measured figures and
states the conditional form of the claim.

`sim/manipulation.ts`, which the README also references, still does not exist.

---

## 10. Epochs declare their horizon in seconds

**README says:** nothing explicit — `impliedVol` applies "a fixed scaling factor".

**Built instead:** `openEpoch` takes an explicit `horizonSeconds`, stored on the epoch and used
for every annualization.

**Why.** Annualizing needs a duration, and the only other source is block numbers — which would
hard-code an assumption about block time that differs per chain and drifts on any of them. The
README's own Limitations section calls annualization "a convention"; making the convention an
explicit per-epoch parameter is the honest version of that.

---

## 11. The oracle needs a curator to name the vol pool

**README implies:** `SigmaOracle.impliedVol()` is a pure view over on-chain state.

**Reality:** the oracle cannot discover *which* v4 pool prices a given epoch's VAR-LONG. That
pool cannot exist until the epoch's legs do, so it cannot be created inside `openEpoch`, and
letting anyone register it would let anyone point the feed at a pool they control.

**Decision.** `SigmaOracle.registerVolPool` is one-shot per epoch and restricted to a `curator`
fixed at construction.

**The trust this concentrates, bounded precisely:**

- A wrong registration makes the oracle report a wrong **implied** volatility.
- It **cannot** move collateral, and it **cannot** affect settlement — settlement reads the
  hook's accumulator and never touches this contract.
- It cannot be changed once set.
- `realizedVariance` and `realizedVol` bypass it entirely, so an integrator who does not want to
  trust a curator still has a usable feed.
- Which side of the pool VAR-LONG sits on is **derived from the key**, not supplied, so a
  mismatched flag cannot silently invert every price — `test_orientationIsDerivedFromTheKey`.

**Evidence.** 12 tests in `test/integration/SigmaOracle.t.sol`, including
`test_impliedVolMatchesAnOffChainReference` (three prices against values computed at 50 digits
outside Solidity), `test_registrationRejectsAPoolWithoutTheLeg`, `test_onlyCuratorCanRegister`
and `test_priceAboveParIsClampedNotReverted`.

**Integrator note.** `impliedVol` reverts when no vol pool is registered. A hook calling it from
`beforeSwap` would brick its own pool, so `tryImpliedVol` returns `(bool ok, uint256)` instead.
`test/integration/OracleIntegration.t.sol` shows both, and asserts the fallback path.

---

## 12. `SigmaStream` needs the payoff reported across chains

**README says:** the streaming sequence diagram shows `SigmaStream` on Arc calling
`SigmaVault` on Unichain to increment coverage, and states that Arc "is a payment rail for a
subscription, never part of settlement."

**The gap.** Those two cannot both be literal. A contract on Arc cannot read the accumulator on
Unichain, and there is no synchronous cross-chain call. Coverage has to be paid out on Arc, which
means the settled payoff `p` has to arrive there somehow.

**Decision.** `SigmaStream` takes a `settlementReporter`, fixed at construction, who publishes an
epoch's payoff exactly once and can never change it. This is the only trust surface in the
contract, and it is bounded by a fail-safe: if no report arrives by `reportDeadline`, subscribers
reclaim every unspent unit of premium via `reclaimUnreported` and underwriters withdraw their
capacity. Coverage simply never materializes.

**That keeps the README's liveness claim literally true.** If Arc, Gateway, the agents or the
reporter are unavailable, coverage lapses and nothing is stuck — and settlement of the variance
tokens on Unichain is untouched either way, because it reads the hook and has never depended on
anything here.

**What the reporter can and cannot do:** it can report a wrong payoff for coverage on Arc. It
cannot touch collateral in the vault, cannot change what VAR-LONG or VAR-SHORT redeem for, and
cannot prevent a subscriber from recovering unspent premium.

**Design notes worth flagging for review.**

- **Coverage is proportional to time actually paid for.** Stream for half the epoch, get half the
  notional. Accrual is lazy and stops at the exact second the balance runs dry, so an unfunded
  subscription stops accruing rather than accruing a debt — the fail-safe direction.
- **Topping up does not backdate.** A gap in payment is a gap in coverage, permanently
  (`test_toppingUpDoesNotBackdateCoverage`).
- **Premium is underwriter income the moment it is earned**, not at settlement, so shares minted
  later cannot dilute it (`test_sharesDoNotDiluteEarnedPremium`).
- **Payout is capped by the pool**, so the contract can never promise more than it holds.
- **`block.timestamp` is used deliberately**, not block numbers: a rate quoted per second must
  not change meaning when block times drift. A validator nudging the clock moves premium and
  coverage by the same proportion in the same direction. Nothing settles on it.

**Evidence.** 22 tests in `test/integration/SigmaStream.t.sol`, notably
`test_coverageLapsesWhenPremiumRunsDry`, `test_partiallyFundedSubscriberIsPaidProRata`,
`test_ifTheReporterNeverReportsEveryoneGetsTheirMoneyBack` and `test_underwritersAbsorbTheLoss`.

**README edit needed:** the streaming sequence diagram shows a direct `Stream -> Vault` call that
does not exist. It should show the reporter publishing the payoff instead.

---

## 13. The hook's privileged address cannot come from `msg.sender`

**Found by the first real deployment. No test could have caught it as written.**

`SigmaHook` originally set `deployer = msg.sender` in its constructor and gated `setVault` on it.
That is wrong for a v4 hook specifically: a hook's address has to encode its permissions, so it
**must** be deployed through the deterministic CREATE2 factory at `0x4e59…4956C` — which makes
`msg.sender` inside the constructor the *factory*, not the deploying account.

The consequence would have been permanent: `setVault` callable only by a factory that cannot call
anything, so the hook could never be pointed at a vault, so no epoch could ever register a
settlement boundary. The contract would be live, correct-looking, and inert.

**Why the tests all passed.** Every suite deployed the hook with `new SigmaHook{salt: salt}(...)`
directly from the test contract, which makes `msg.sender` the test contract — the right answer by
accident. The bug only exists on the path that no test took.

**Fix.** `vaultSetter` is an explicit constructor argument. `test_vaultSetterSurvivesCreate2FactoryDeployment`
now deploys through the factory the way a deployment actually does, asserts the mined address
matches, and asserts `vaultSetter` is the intended admin and *not* the factory.

**Second-order consequence, also found by deploying.** Once the admin no longer came from
`msg.sender`, deploying through the factory became safe — which mattered, because
`new C{salt: s}` inside a `forge script` did **not** route through the factory in simulation, so
the mined address never matched and `PoolManager` rejected the hook. Both deploy scripts now call
the factory explicitly rather than relying on Foundry's routing.

Written up for the Uniswap team in [`FEEDBACK.md`](./FEEDBACK.md).

---

## 14. A quiet epoch locked its pool out of every future epoch

**Found by rolling epoch 1 into epoch 2 on a live deployment. No test caught it.**

An epoch whose boundary passes with **no further trading** never fires its snapshot. Settlement
handles that correctly — it falls back to the live accumulator, which is exact in that case, and
`test_settlesWhenNobodyTradedAfterTheBoundary` proved it. What nothing tested was what happens
*next*: the hook's `pendingSnapshot` slot stays occupied, and `requestSnapshot` deliberately
refuses to overwrite a pending boundary. So `openEpoch` reverted with `SnapshotAlreadyPending` and
the pool could not host another epoch.

Self-healing but not harmless: any swap on the pool fires the stale boundary and frees the slot,
so the lockout lasts until somebody happens to trade. On a quiet pool — exactly the pool least
likely to be traded — that is indefinite.

**Fix.** `SigmaHook.releaseSnapshot(poolId)`, vault-only, called by `settle`. After settlement the
epoch's payoff is frozen and its boundary is no longer needed by anyone. If the snapshot already
fired the slot is zero and the call is a no-op.

**Why no test found it.** Every suite tested a single epoch's lifecycle. None opened a *second*
epoch on the same pool after a quiet settlement — the two behaviours were each correct in
isolation and only conflicted in sequence.

Three tests now cover it, and the first was verified to fail with the fix removed:
`test_poolCanHostAnotherEpochAfterAQuietSettlement`, `test_onlyVaultCanReleaseASnapshot`, and
`test_releaseIsANoOpWhenTheSnapshotAlreadyFired`.

**The contracts were redeployed** with the fix; every address in `README.md` and
`INTEGRATION.md` is from the fixed deployment. The previous deployment settled its epoch
correctly first, which is what surfaced the bug:

```
realized variance 0.038152  vs cap 0.020000  ->  payoff pinned at 1.0
VAR-LONG  redeemed 16,316.81  ->  paid in full
VAR-SHORT redeemed 25,000.00  ->  paid nothing
collateral left 8,683.19 against 8,683.19 VAR-LONG still in the vol pool
```

That last line is the solvency invariant holding exactly, on chain, at settlement.

---

## Verified environment facts

Not deviations — things confirmed rather than assumed, recorded so nobody re-derives them.

| Fact | How it was confirmed |
|---|---|
| Unichain Sepolia chain ID is **1301** | `eth_chainId` against `sepolia.unichain.org` returned `0x515` |
| PoolManager `0x00B036B58a818B1BC34d502D3fE730Db729e62AC` | Three ways: v4-periphery broadcast records for chain 1301; live `eth_getCode` plus `owner()` returning the same `0x5b73…0519` as its constructor arg; the published deployments page |
| PositionManager `0xf969Aee60879C54bAAed9F3eD26147Db216Fd664` | Broadcast records + live code + deployments page |
| StateView `0xc199F1072a74D4e905ABa1A84d9a45E2546B6222` | Broadcast records + live code + deployments page |
| Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Live code + deployments page |
| All four checksums | `cast to-check-sum-address` — one was wrong on first write and caught by the compiler |
| Public RPC serves archive state past block 60,000,000 | Probed `eth_getCode` at five historical blocks, so the fork block can be pinned |
| `ln(1.0001)^2 = 9.99900009165833409437e-9` | Computed at 50 decimal digits outside Solidity; pinned by `test_constant_matchesLnSquared` |
| A pool moving one tick per second is **56.154115%** annualized vol | `test_volatility_oneTickPerSecond`, checked against the same 50-digit reference, with truncation proven one-directional |
| `MAX_TICK_DELTA = 1000` is **+10.5165%** of price | Computed `1.0001^1000` at 50 digits |
