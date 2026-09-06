# @volatus/onchain

Chains, deployed addresses, ABIs, unit conversions and read-only RPC clients
for Volatus, in one typed package.

## Why this exists

The frontend and the backend services each talk to the same contracts on the
same two chains. Before this package, that meant two hand-maintained copies of
every address and every decimal assumption — one in `apps/web`, one wherever
the backend put it — and no way to notice when they drifted apart. An address
typo or a stale constant produces a plausible wrong number, not an error: a
call to the old, dead `SigmaStream` still returns *something*, it just isn't
the contract anyone meant.

`@volatus/onchain` is the one place both sides import from. `test/drift.test.ts`
checks this package's constants against the frontend's copy on every test run,
so a future edit to one without the other fails loudly instead of shipping
quietly. The one standing exception is `SIGMA_STREAM`, tracked explicitly
until the frontend is re-pointed at the redeployed contract — see that file
for why.

## The one rule

**WAD is `1e18`. Volatility, variance and payoff ratios are WAD.** Everything
on Arc — the premium stream, `capacityPool`, `funded`, `coverageNotional`,
`ratePerSecond` — and all collateral on the vault, is **6 decimals**. Never add
a WAD value to a 6dp value, and never scale one into the other by hand: the
contracts do that multiplication where it needs to happen (`SigmaStream.claim`
scales a WAD `payoffWad` against a 6dp notional internally), and nothing in
this package does it for you. `src/units.ts` exists to make the two scales
impossible to confuse by accident, not to convert between them.

## Layout

```
src/chains.ts     viem chain defs — Unichain Sepolia (1301), Arc Testnet (5042002)
src/addresses.ts  deployed addresses, the measured pool id, decimal constants
src/units.ts      WAD <-> number, 6dp USDC <-> number, duration formatting
src/abis.ts       ABIs — reads, writes, events and custom errors, `as const`
src/clients.ts    one read-only PublicClient per chain, module scope
src/index.ts      re-exports everything
test/drift.test.ts   asserts this package agrees with apps/web's onchain copy
```

## Usage

```ts
import { SIGMA_STREAM, sigmaStreamAbi, arcClient, usdcToNumber } from "@volatus/onchain";

const sub = await arcClient.readContract({
  address: SIGMA_STREAM,
  abi: sigmaStreamAbi,
  functionName: "subscription",
  args: [2n, subscriberAddress],
});

console.log(usdcToNumber(sub.funded)); // dollars, not a 6dp integer
```
