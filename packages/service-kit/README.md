# @volatus/service-kit

The runtime shared by every Volatus backend service (`BACKEND_HANDOFF.md`'s settlement
reporter, `sync` keeper, hedger and underwriter agents), so none of them reimplement nonce
handling, a tx journal, or secret-safe logging on their own.

This package does not know about `@volatus/onchain`. `makeWallet`, `send`, and
`getLogsChunked` all take a viem `Chain`, `PublicClient`, or `Abi` as a plain argument —
a service wires them up with `unichainSepolia`/`arcTestnet`/`unichainClient`/`arcClient` and
an ABI imported from `@volatus/onchain`, but service-kit itself only depends on `viem`. See
"A note on `@volatus/onchain`" below for why.

## Two chain facts baked into this package

1. **`eth_getLogs` range caps are real, different per chain, and Arc prunes history.**
   Measured live on 2026-09-05: Unichain Sepolia hard-rejects any range over 10,000 blocks
   (`block range greater than 10000 max`); Arc Testnet's measured ceiling is between 29,000
   and 30,000 blocks (`-32012: requested range too large`) and additionally throws away old
   history (`fromBlock: 0` → `4444: pruned history unavailable`). `logs.ts`'s
   `getLogsChunked` chunks every scan and treats a pruning error as a floor to report, not a
   fatal failure — see `CHAIN_LOG_LIMITS` for the exact numbers and error strings.
2. **On Arc, gas is paid in USDC, and it's the *same* USDC as the ERC-20 balance** — an
   18-decimal native view of the same 6-decimal funds at `0x3600…0000`, never two balances to
   add together. `wallet.ts`'s `balance()`/`requireBalance()` read the native balance, which
   on Arc already is the USDC balance.

## Modules

- **`config.ts`** — zod-validated environment. `loadConfig(shape)` loads
  `services/.env.local` (resolved from the repo root, not `process.cwd()`) into
  `process.env`, then validates the requested keys and throws — naming every missing or
  malformed one — rather than returning a partially-populated object. `commonConfigShape` /
  `loadCommonConfig()` cover the vars every service needs
  (`UNICHAIN_SEPOLIA_RPC`, `ARC_TESTNET_RPC`, `REPORTER_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY`,
  optional `ALERT_WEBHOOK_URL`, `JOURNAL_PATH`). Private keys must be `0x` + 64 hex.
  `SENSITIVE_CONFIG_KEYS` is the explicit list of field names that hold key material — pass
  it to `createLogger({ redactKeys: SENSITIVE_CONFIG_KEYS })`.

- **`logger.ts`** — structured JSON lines to stdout (`ts`, `level`, `service`, `msg`, plus
  arbitrary fields). Two guarantees: a private-key-shaped string
  (`/0x[0-9a-fA-F]{64}/`) is redacted wherever it appears, even mid-sentence in an error
  message, and any field named like `privateKey`/`secret`/`apiKey` (case-insensitive,
  underscore optional) is redacted regardless of value; and a `bigint` anywhere in the
  fields is serialized as a decimal string instead of throwing — the single most common
  crash in a viem service's logging path. `sanitizeForLog` is exported standalone so
  `alerts.ts` can reuse it for webhook payloads.

- **`journal.ts`** — the tx journal, backed by `better-sqlite3`
  (`services/.journal.sqlite` by default). `claim(service, action, key)` atomically
  reserves an action: `"fresh"` (go ahead and send), `"in_flight"` (already claimed —
  reconcile via `get()`'s `txHash`, do not resend), or `"done"`. `recordSent` /
  `recordDone` / `recordFailed` update the record; a `"failed"` action can be claimed again
  (its send never landed), an `"in_flight"` one cannot (it might have). Also a generic `kv`
  table for backfill cursors (`getCursor`/`setCursor`, bigint-safe) and the keeper's
  subscription registry (`upsertSubscription`/`listSubscriptions`/`dropSubscription`, keyed
  by `(epochId, subscriber)`).

- **`wallet.ts`** — `makeWallet({ chain, privateKey, rpcUrl })`. Sends are serialized
  through a promise queue so two concurrent callers can't collide on the same nonce; the
  nonce is read once via `getTransactionCount('pending')` and incremented locally, resynced
  from the chain after any failure. `send()` simulates first (`publicClient.simulateContract`
  — a remote `eth_call`, so Arc's local-EVM blocklist-precompile problem doesn't apply),
  then writes and waits for the receipt, returning `{ ok: true, hash, receipt }` or
  `{ ok: false, reason, revertName? }`. Reverts are decoded via `BaseError.walk` /
  `ContractFunctionRevertedError` to recover the custom error's name (`ReportWindowClosed`,
  `InsufficientCapacity`, ...). A `gasMultiplier` and `maxRetries` (with a fee bump per
  retry) cover `replacement transaction underpriced` and receipt-wait timeouts.
  `requireBalance(min)` throws so a service refuses to start silently broke.

- **`logs.ts`** — `getLogsChunked({ client, address, event, fromBlock, toBlock, maxRange })`.
  See "Two chain facts" above.

- **`alerts.ts`** — `makeAlerter({ service, webhookUrl }).alert(level, msg, fields)` always
  logs and POSTs to the webhook when configured. `deadlineAlarm({ name, deadline, margin,
  isDone, alert })` is a stateless check meant to be called on every loop tick: it fires
  once `now > deadline - margin` and `isDone()` is false, *before* the deadline (escalating
  from `warn` to `error` once the deadline itself passes) — because missing
  `reportDeadline` costs every subscriber their payout, and an alarm that fires on the
  deadline is a post-mortem, not a warning.

- **`runner.ts`** — `runLoop({ name, intervalMs, tick, onError, alert })`. Jittered
  interval, graceful `SIGINT`/`SIGTERM` shutdown that lets the in-flight tick finish, and a
  consecutive-failure counter that escalates to `alert` past a threshold. Services should be
  a `tick()` function passed here, not a bespoke `setInterval`.

## A note on `@volatus/onchain`

This package was built while `@volatus/onchain` (agent A1's package, exporting
`unichainSepolia`, `arcTestnet`, `unichainClient`, `arcClient`, and the ABIs) did not exist
yet in the workspace. Rather than add an unresolvable `workspace:*` dependency that would
break `pnpm install` for everyone, `wallet.ts` and `logs.ts` were written against viem's own
generic types (`Chain`, `PublicClient`, `Abi`, `AbiEvent`) so a caller supplies the concrete
chain/client/ABI. Once `@volatus/onchain` exists, a reporter or keeper service does:

```ts
import { unichainSepolia, unichainClient } from "@volatus/onchain";
import { makeWallet, getLogsChunked } from "@volatus/service-kit";

const reporter = makeWallet({ chain: unichainSepolia, privateKey, rpcUrl: config.UNICHAIN_SEPOLIA_RPC });
const { logs } = await getLogsChunked({ client: unichainClient, address, event, fromBlock, toBlock });
```

No change to `service-kit` itself is needed. `@volatus/onchain` is not a dependency of this
package and does not need to be for it to compose cleanly with it.
