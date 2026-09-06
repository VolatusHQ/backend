/**
 * ABIs, hand-narrowed rather than generated.
 *
 * This is the backend's superset of `apps/web/app/app/lib/onchain/abis.ts`: it
 * carries everything the frontend reads, plus the write functions, events and
 * custom errors the backend services (reporter, keeper, hedger/underwriter
 * agents) need that a read-only UI does not. Regenerate against the source of
 * truth with `forge build` in `contracts/` and read `out/<Name>.sol/<Name>.json`
 * — every entry below was cross-checked against that compiled output and
 * against `contracts/src/*.sol` directly.
 *
 * `as const` is load-bearing — viem infers argument and return types from it.
 * Every custom error is included so viem can decode a revert into a name
 * (`NotReporter`, `InsufficientCapacity(requested, available)`, …) rather than
 * an undecoded hex blob.
 */

export const sigmaOracleAbi = [
  {
    type: "function",
    name: "tryImpliedVol",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "ok", type: "bool" },
      { name: "impliedVolWad", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "realizedVol",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "realizedVariance",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "normalizedImpliedVariance",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "epoch",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "endBlock", type: "uint64" },
      { name: "strike", type: "uint256" },
      { name: "cap", type: "uint256" },
    ],
  },
] as const;

export const sigmaHookAbi = [
  {
    type: "function",
    name: "varianceState",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "accumulator", type: "uint256" },
          { name: "lastTick", type: "int24" },
          { name: "lastBlock", type: "uint48" },
          { name: "observations", type: "uint32" },
          { name: "pendingSnapshot", type: "uint48" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "VarianceObserved",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "tick", type: "int24", indexed: false },
      { name: "accumulator", type: "uint256", indexed: false },
      { name: "observations", type: "uint32", indexed: false },
    ],
  },
] as const;

export const sigmaVaultAbi = [
  {
    type: "function",
    name: "activeEpoch",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "epoch",
    stateMutability: "view",
    inputs: [{ name: "epochId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "poolId", type: "bytes32" },
          { name: "startBlock", type: "uint48" },
          { name: "endBlock", type: "uint48" },
          { name: "horizonSeconds", type: "uint32" },
          { name: "settled", type: "bool" },
          { name: "startAccumulator", type: "uint256" },
          { name: "strikeWad", type: "uint256" },
          { name: "capWad", type: "uint256" },
          { name: "longToken", type: "address" },
          { name: "shortToken", type: "address" },
          { name: "collateralHeld", type: "uint256" },
          { name: "payoffWad", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "realizedVariance",
    stateMutability: "view",
    inputs: [{ name: "epochId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "epochCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  /* Writes. All permissionless — `settle` and `openEpoch` included, which is
     what lets a dead epoch be rolled without anyone's key. */
  {
    type: "function",
    name: "mintPair",
    stateMutability: "nonpayable",
    inputs: [
      { name: "epochId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "burnPair",
    stateMutability: "nonpayable",
    inputs: [
      { name: "epochId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "redeem",
    stateMutability: "nonpayable",
    inputs: [
      { name: "epochId", type: "uint256" },
      { name: "isLong", type: "bool" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "payout", type: "uint256" }],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [{ name: "epochId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  /**
   * Opens an epoch on `poolId` measuring from now until `endBlock`.
   * Permissionless — this is how a dead epoch (nobody left to roll it) gets
   * rolled without anyone's key.
   */
  {
    type: "function",
    name: "openEpoch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "endBlock", type: "uint48" },
      { name: "horizonSeconds", type: "uint32" },
      { name: "strikeWad", type: "uint256" },
      { name: "capWad", type: "uint256" },
    ],
    outputs: [{ name: "epochId", type: "uint256" }],
  },
  {
    type: "event",
    name: "EpochOpened",
    inputs: [
      { name: "epochId", type: "uint256", indexed: true },
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "endBlock", type: "uint48", indexed: false },
      { name: "strikeWad", type: "uint256", indexed: false },
      { name: "capWad", type: "uint256", indexed: false },
      { name: "longToken", type: "address", indexed: false },
      { name: "shortToken", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "EpochSettled",
    inputs: [
      { name: "epochId", type: "uint256", indexed: true },
      { name: "realizedVariance", type: "uint256", indexed: false },
      { name: "payoff", type: "uint256", indexed: false },
    ],
  },
  /* Custom errors declared on SigmaVault itself (contracts/src/SigmaVault.sol).
     Library and OZ-inherited errors (ReentrancyGuardReentrantCall,
     SafeERC20FailedOperation, …) are not this contract's own surface and are
     omitted. */
  {
    type: "error",
    name: "InvalidRange",
    inputs: [
      { name: "strikeWad", type: "uint256" },
      { name: "capWad", type: "uint256" },
    ],
  },
  { type: "error", name: "ZeroHorizon", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  {
    type: "error",
    name: "EndBlockInPast",
    inputs: [
      { name: "endBlock", type: "uint48" },
      { name: "currentBlock", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "PoolAlreadyHasAnActiveEpoch",
    inputs: [{ name: "epochId", type: "uint256" }],
  },
  { type: "error", name: "NoSuchEpoch", inputs: [{ name: "epochId", type: "uint256" }] },
  { type: "error", name: "EpochClosed", inputs: [{ name: "epochId", type: "uint256" }] },
  {
    type: "error",
    name: "EpochNotOver",
    inputs: [
      { name: "endBlock", type: "uint48" },
      { name: "currentBlock", type: "uint256" },
    ],
  },
  { type: "error", name: "AlreadySettled", inputs: [{ name: "epochId", type: "uint256" }] },
  { type: "error", name: "NotSettled", inputs: [{ name: "epochId", type: "uint256" }] },
  {
    type: "error",
    name: "SnapshotMissing",
    inputs: [
      { name: "epochId", type: "uint256" },
      { name: "endBlock", type: "uint48" },
    ],
  },
] as const;

/**
 * Where implied volatility is discovered: the VAR-LONG/mUSDC pool registered
 * against an epoch. `longIsCurrency0` decides which direction of a swap buys
 * VAR-LONG, so it is read rather than assumed.
 */
export const sigmaOracleVolPoolAbi = [
  {
    type: "function",
    name: "volPool",
    stateMutability: "view",
    inputs: [{ name: "epochId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "poolId", type: "bytes32" },
          { name: "longIsCurrency0", type: "bool" },
          { name: "registered", type: "bool" },
        ],
      },
    ],
  },
] as const;

/** Uniswap v4 pool state. The PoolManager keeps state in transient-ish storage
 *  slots; StateView is the read wrapper periphery ships for exactly this. */
export const stateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
  {
    type: "function",
    name: "getLiquidity",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ type: "uint128" }],
  },
  {
    type: "function",
    name: "getPositionInfo",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "positionId", type: "bytes32" },
    ],
    outputs: [
      { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
    ],
  },
] as const;

/**
 * `PoolSwapTest` from v4-core. This is how the vol pool is traded, and trading
 * it is what moves implied volatility — the whole point of the protocol.
 */
export const poolSwapTestAbi = [
  {
    type: "function",
    name: "swap",
    stateMutability: "payable",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "zeroForOne", type: "bool" },
          { name: "amountSpecified", type: "int256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
      {
        name: "testSettings",
        type: "tuple",
        components: [
          { name: "takeClaims", type: "bool" },
          { name: "settleUsingBurn", type: "bool" },
        ],
      },
      { name: "hookData", type: "bytes" },
    ],
    // BalanceDelta is a packed int256: amount0 in the high 128, amount1 in the low.
    outputs: [{ name: "delta", type: "int256" }],
  },
] as const;

/** The mock tokens' open faucet. Testnet only, by design — see MintableERC20. */
export const mintableErc20Abi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/** Minimal ERC-20 surface for allowance checks and transfers — Arc USDC and
 *  the mocks alike. */
export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/**
 * Uniswap v4 PositionManager. Positions are ERC-721s, but v4 ships no
 * enumeration, so a holder's tokens come from a `Transfer(to = holder)` log
 * scan rather than a `tokenOfOwnerByIndex` call that does not exist.
 */
export const positionManagerAbi = [
  {
    type: "function",
    name: "modifyLiquidities",
    stateMutability: "payable",
    inputs: [
      { name: "unlockData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "nextTokenId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "getPositionLiquidity",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
  {
    type: "function",
    name: "getPoolAndPositionInfo",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      // PositionInfo is a packed uint256: tickLower/tickUpper live in it.
      { name: "info", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "id", type: "uint256", indexed: true },
    ],
  },
] as const;

/** Permit2's allowance path — what PositionManager pulls tokens through. */
export const permit2Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
] as const;

export const sigmaStreamAbi = [
  {
    type: "function",
    name: "capacityPool",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "postCapacity",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    type: "function",
    name: "withdrawCapacity",
    stateMutability: "nonpayable",
    inputs: [{ name: "shareAmount", type: "uint256" }],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "subscribe",
    stateMutability: "nonpayable",
    inputs: [
      { name: "epochId", type: "uint256" },
      { name: "ratePerSecond", type: "uint256" },
      { name: "coverageNotional", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "fund",
    stateMutability: "nonpayable",
    inputs: [
      { name: "epochId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  /**
   * Re-price a live subscription. Bills everything already elapsed at the old
   * rate first (`_sync` runs before the rate changes), so re-rating can never
   * retroactively re-price coverage already accrued. This is the seam the
   * hedger agent drives — Phase 6.
   */
  {
    type: "function",
    name: "adjust",
    stateMutability: "nonpayable",
    inputs: [
      { name: "epochId", type: "uint256" },
      { name: "newRatePerSecond", type: "uint256" },
      { name: "newCoverageNotional", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancel",
    stateMutability: "nonpayable",
    inputs: [{ name: "epochId", type: "uint256" }],
    outputs: [{ name: "refund", type: "uint256" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ name: "epochId", type: "uint256" }],
    outputs: [{ name: "payout", type: "uint256" }],
  },
  {
    type: "function",
    name: "reclaimUnreported",
    stateMutability: "nonpayable",
    inputs: [{ name: "epochId", type: "uint256" }],
    outputs: [{ name: "refund", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalShares",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "shares",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "settlementReporter",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  /** The collateral token — USDC on Arc. Immutable on the contract. */
  {
    type: "function",
    name: "usdc",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "runwaySeconds",
    stateMutability: "view",
    inputs: [
      { name: "epochId", type: "uint256" },
      { name: "subscriber", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  /** Mirrors an epoch that already exists in the vault on Unichain. Reporter-only. */
  {
    type: "function",
    name: "openEpoch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "epochId", type: "uint256" },
      { name: "coverageEnd", type: "uint64" },
      { name: "reportDeadline", type: "uint64" },
    ],
    outputs: [],
  },
  /** Publishes the settled payoff measured on Unichain. Reporter-only, once per epoch. */
  {
    type: "function",
    name: "reportPayoff",
    stateMutability: "nonpayable",
    inputs: [
      { name: "epochId", type: "uint256" },
      { name: "payoffWad", type: "uint256" },
    ],
    outputs: [],
  },
  /** Bring a subscription's accrual up to date. Permissionless — the keeper's only call. */
  {
    type: "function",
    name: "sync",
    stateMutability: "nonpayable",
    inputs: [
      { name: "epochId", type: "uint256" },
      { name: "subscriber", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "epoch",
    stateMutability: "view",
    inputs: [{ name: "epochId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "coverageStart", type: "uint64" },
          { name: "coverageEnd", type: "uint64" },
          { name: "reportDeadline", type: "uint64" },
          { name: "reported", type: "bool" },
          { name: "payoffWad", type: "uint256" },
          { name: "totalCoverageSold", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "subscription",
    stateMutability: "view",
    inputs: [
      { name: "epochId", type: "uint256" },
      { name: "subscriber", type: "address" },
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "ratePerSecond", type: "uint256" },
          { name: "coverageNotional", type: "uint256" },
          { name: "funded", type: "uint256" },
          { name: "lastSync", type: "uint64" },
          { name: "coveredSeconds", type: "uint64" },
          { name: "claimed", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "EpochOpened",
    inputs: [
      { name: "epochId", type: "uint256", indexed: true },
      { name: "coverageEnd", type: "uint64", indexed: false },
      { name: "reportDeadline", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Subscribed",
    inputs: [
      { name: "epochId", type: "uint256", indexed: true },
      { name: "subscriber", type: "address", indexed: true },
      { name: "ratePerSecond", type: "uint256", indexed: false },
      { name: "coverage", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Funded",
    inputs: [
      { name: "epochId", type: "uint256", indexed: true },
      { name: "subscriber", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Adjusted",
    inputs: [
      { name: "epochId", type: "uint256", indexed: true },
      { name: "subscriber", type: "address", indexed: true },
      { name: "ratePerSecond", type: "uint256", indexed: false },
      { name: "coverage", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Synced",
    inputs: [
      { name: "epochId", type: "uint256", indexed: true },
      { name: "subscriber", type: "address", indexed: true },
      { name: "coveredSeconds", type: "uint64", indexed: false },
      { name: "premiumPaid", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PayoffReported",
    inputs: [
      { name: "epochId", type: "uint256", indexed: true },
      { name: "payoffWad", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "epochId", type: "uint256", indexed: true },
      { name: "subscriber", type: "address", indexed: true },
      { name: "payout", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PremiumRefunded",
    inputs: [
      { name: "epochId", type: "uint256", indexed: true },
      { name: "subscriber", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "CapacityPosted",
    inputs: [
      { name: "underwriter", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "shares", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "CapacityWithdrawn",
    inputs: [
      { name: "underwriter", type: "address", indexed: true },
      { name: "shares", type: "uint256", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  /* Every custom error SigmaStream declares (contracts/src/SigmaStream.sol),
     so a revert decodes to a name instead of an opaque selector. */
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "NotReporter", inputs: [] },
  { type: "error", name: "EpochExists", inputs: [{ name: "epochId", type: "uint256" }] },
  { type: "error", name: "NoSuchEpoch", inputs: [{ name: "epochId", type: "uint256" }] },
  { type: "error", name: "EpochNotOver", inputs: [{ name: "epochId", type: "uint256" }] },
  { type: "error", name: "AlreadyReported", inputs: [{ name: "epochId", type: "uint256" }] },
  { type: "error", name: "ReportWindowClosed", inputs: [{ name: "epochId", type: "uint256" }] },
  { type: "error", name: "PayoffOutOfRange", inputs: [{ name: "payoffWad", type: "uint256" }] },
  { type: "error", name: "AlreadySubscribed", inputs: [{ name: "epochId", type: "uint256" }] },
  { type: "error", name: "ZeroRate", inputs: [] },
  { type: "error", name: "NoSubscription", inputs: [{ name: "epochId", type: "uint256" }] },
  { type: "error", name: "NotReportedYet", inputs: [{ name: "epochId", type: "uint256" }] },
  { type: "error", name: "AlreadyClaimed", inputs: [{ name: "epochId", type: "uint256" }] },
  { type: "error", name: "NothingPosted", inputs: [] },
  {
    type: "error",
    name: "InsufficientCapacity",
    inputs: [
      { name: "requested", type: "uint256" },
      { name: "available", type: "uint256" },
    ],
  },
] as const;
