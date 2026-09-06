import { describe, expect, it, vi } from "vitest";
import type { AbiEvent } from "viem";
import { CHAIN_LOG_LIMITS, getLogsChunked } from "./logs.js";

const testEvent = { type: "event", name: "Test", inputs: [] } as const satisfies AbiEvent;

/** A fake `PublicClient` exposing only what `getLogsChunked` touches. */
function fakeClient(
  chainId: number | undefined,
  getLogsImpl: (params: { fromBlock: bigint; toBlock: bigint }) => unknown[],
) {
  return {
    chain: chainId === undefined ? undefined : { id: chainId },
    getLogs: vi.fn(async (params: { fromBlock: bigint; toBlock: bigint; address: unknown; event: unknown }) =>
      getLogsImpl({ fromBlock: params.fromBlock, toBlock: params.toBlock }),
    ),
  };
}

describe("getLogsChunked — chunk boundaries", () => {
  it("covers a range that is not a multiple of maxRange with no gap and no overlap", async () => {
    const calls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    const client = fakeClient(undefined, (params) => {
      calls.push(params);
      return [{ blockNumber: params.fromBlock }]; // one tagged "log" per chunk
    });

    const result = await getLogsChunked({
      client: client as never,
      address: "0x0000000000000000000000000000000000000001",
      event: testEvent,
      fromBlock: 1n,
      toBlock: 25_000n,
      maxRange: 9_000n,
    });

    expect(calls).toEqual([
      { fromBlock: 1n, toBlock: 9_000n },
      { fromBlock: 9_001n, toBlock: 18_000n },
      { fromBlock: 18_001n, toBlock: 25_000n },
    ]);

    // No gap: every consecutive pair is contiguous (next.fromBlock === prev.toBlock + 1).
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]!.fromBlock).toBe(calls[i - 1]!.toBlock + 1n);
    }
    // No overlap: each chunk's own range is well-formed and disjoint from the next.
    for (const call of calls) {
      expect(call.toBlock).toBeGreaterThanOrEqual(call.fromBlock);
    }
    // Full coverage: first chunk starts at fromBlock, last ends at toBlock.
    expect(calls[0]!.fromBlock).toBe(1n);
    expect(calls.at(-1)!.toBlock).toBe(25_000n);
    // The final chunk is the short remainder (25000 - 18001 + 1 = 7000), not padded or dropped.
    expect(calls.at(-1)!.toBlock - calls.at(-1)!.fromBlock + 1n).toBe(7_000n);

    expect(result.logs).toHaveLength(3);
    expect(result.prunedBefore).toBeUndefined();
  });

  it("produces exactly one chunk when the range fits within maxRange", async () => {
    const client = fakeClient(undefined, () => [{}]);
    await getLogsChunked({
      client: client as never,
      address: "0x0000000000000000000000000000000000000001",
      event: testEvent,
      fromBlock: 100n,
      toBlock: 200n,
      maxRange: 9_000n,
    });
    expect(client.getLogs).toHaveBeenCalledTimes(1);
    expect(client.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 100n, toBlock: 200n }),
    );
  });

  it("produces an exact-multiple range with no trailing empty chunk", async () => {
    const calls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    const client = fakeClient(undefined, (params) => {
      calls.push(params);
      return [];
    });
    await getLogsChunked({
      client: client as never,
      address: "0x0000000000000000000000000000000000000001",
      event: testEvent,
      fromBlock: 0n,
      toBlock: 17_999n, // exactly two chunks of 9000
      maxRange: 9_000n,
    });
    expect(calls).toEqual([
      { fromBlock: 0n, toBlock: 8_999n },
      { fromBlock: 9_000n, toBlock: 17_999n },
    ]);
  });

  it("defaults maxRange from CHAIN_LOG_LIMITS by client.chain.id", async () => {
    const calls: bigint[] = [];
    const client = fakeClient(1301, (params) => {
      calls.push(params.toBlock - params.fromBlock + 1n);
      return [];
    });
    await getLogsChunked({
      client: client as never,
      address: "0x0000000000000000000000000000000000000001",
      event: testEvent,
      fromBlock: 0n,
      toBlock: 20_000n,
    });
    expect(calls[0]).toBe(CHAIN_LOG_LIMITS[1301]);
  });

  it("rejects toBlock before fromBlock", async () => {
    const client = fakeClient(undefined, () => []);
    await expect(
      getLogsChunked({
        client: client as never,
        address: "0x0000000000000000000000000000000000000001",
        event: testEvent,
        fromBlock: 100n,
        toBlock: 50n,
      }),
    ).rejects.toThrow();
  });
});

describe("getLogsChunked — Arc pruning", () => {
  it("skips pruned chunks, keeps scanning newer ones, and reports prunedBefore", async () => {
    const client = fakeClient(5_042_002, (params) => {
      if (params.toBlock < 18_000n) {
        const err = new Error("server returned an error response: error code 4444: pruned history unavailable");
        throw err;
      }
      return [{ blockNumber: params.fromBlock }];
    });

    const result = await getLogsChunked({
      client: client as never,
      address: "0x0000000000000000000000000000000000000001",
      event: testEvent,
      fromBlock: 0n,
      toBlock: 27_000n,
      maxRange: 9_000n,
    });

    // Chunks: [0,8999] pruned, [9000,17999] pruned, [18000,26999] ok, [27000,27000] ok.
    expect(result.prunedBefore).toBe(18_000n);
    expect(result.logs).toHaveLength(2);
  });

  it("propagates a non-pruning error instead of swallowing it", async () => {
    const client = fakeClient(undefined, () => {
      throw new Error("-32012: requested range too large");
    });
    await expect(
      getLogsChunked({
        client: client as never,
        address: "0x0000000000000000000000000000000000000001",
        event: testEvent,
        fromBlock: 0n,
        toBlock: 100n,
        maxRange: 50n,
      }),
    ).rejects.toThrow(/range too large/);
  });
});
