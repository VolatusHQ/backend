import { describe, expect, it } from "vitest";
import type { Address, PublicClient } from "viem";
import { MEASURED_POOL_KEY } from "@volatus/onchain";
import { findOwnedPositions } from "./position.js";

const OWNER = "0x7975E591c26e6c6D9B0CFd9A81f6d61A921C080c" as Address;
const OTHER_OWNER = "0x0000000000000000000000000000000000dEaD" as Address;

// (upper << 32) | (lower << 8), matching decodePositionInfo's packing.
function packInfo(tickLower: number, tickUpper: number): bigint {
  const lower = BigInt.asUintN(24, BigInt(tickLower));
  const upper = BigInt.asUintN(24, BigInt(tickUpper));
  return (upper << 32n) | (lower << 8n);
}

interface FakeToken {
  tokenId: bigint;
  owner: Address;
  liquidity: bigint;
  poolKey: typeof MEASURED_POOL_KEY | { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  tickLower: number;
  tickUpper: number;
}

function fakeClient(tokens: FakeToken[]): PublicClient {
  return {
    chain: { id: 1301 },
    async getLogs() {
      return tokens.map((t) => ({ args: { id: t.tokenId } }));
    },
    async readContract(params: { functionName: string; args: readonly unknown[] }) {
      const tokenId = params.args[0] as bigint;
      const token = tokens.find((t) => t.tokenId === tokenId);
      if (!token) throw new Error("burned");
      switch (params.functionName) {
        case "ownerOf":
          return token.owner;
        case "getPositionLiquidity":
          return token.liquidity;
        case "getPoolAndPositionInfo":
          return [token.poolKey, packInfo(token.tickLower, token.tickUpper)];
        default:
          throw new Error(`unexpected functionName ${params.functionName}`);
      }
    },
  } as unknown as PublicClient;
}

const OTHER_POOL_KEY = { ...MEASURED_POOL_KEY, fee: 500 };

describe("findOwnedPositions", () => {
  it("returns a live, owned position in the measured pool", async () => {
    const client = fakeClient([
      { tokenId: 1n, owner: OWNER, liquidity: 5_000n, poolKey: MEASURED_POOL_KEY, tickLower: -60, tickUpper: 60 },
    ]);
    const positions = await findOwnedPositions({ client, owner: OWNER, fromBlock: 0n, toBlock: 100n });
    expect(positions).toEqual([{ tokenId: 1n, liquidity: 5_000n, tickLower: -60, tickUpper: 60 }]);
  });

  it("excludes a token owned by someone else", async () => {
    const client = fakeClient([
      { tokenId: 1n, owner: OTHER_OWNER, liquidity: 5_000n, poolKey: MEASURED_POOL_KEY, tickLower: -60, tickUpper: 60 },
    ]);
    const positions = await findOwnedPositions({ client, owner: OWNER, fromBlock: 0n, toBlock: 100n });
    expect(positions).toEqual([]);
  });

  it("excludes a closed position (zero liquidity)", async () => {
    const client = fakeClient([
      { tokenId: 1n, owner: OWNER, liquidity: 0n, poolKey: MEASURED_POOL_KEY, tickLower: -60, tickUpper: 60 },
    ]);
    const positions = await findOwnedPositions({ client, owner: OWNER, fromBlock: 0n, toBlock: 100n });
    expect(positions).toEqual([]);
  });

  it("excludes a position in a different pool", async () => {
    const client = fakeClient([
      { tokenId: 1n, owner: OWNER, liquidity: 5_000n, poolKey: OTHER_POOL_KEY, tickLower: -60, tickUpper: 60 },
    ]);
    const positions = await findOwnedPositions({ client, owner: OWNER, fromBlock: 0n, toBlock: 100n });
    expect(positions).toEqual([]);
  });

  it("returns an empty list, not an error, when the owner holds no position at all", async () => {
    const client = fakeClient([]);
    const positions = await findOwnedPositions({ client, owner: OWNER, fromBlock: 0n, toBlock: 100n });
    expect(positions).toEqual([]);
  });

  it("treats a burned token (ownerOf reverts) as gone, not as an error", async () => {
    const client = {
      chain: { id: 1301 },
      async getLogs() {
        return [{ args: { id: 42n } }];
      },
      async readContract() {
        throw new Error("ERC721: invalid token ID");
      },
    } as unknown as PublicClient;
    const positions = await findOwnedPositions({ client, owner: OWNER, fromBlock: 0n, toBlock: 100n });
    expect(positions).toEqual([]);
  });
});
