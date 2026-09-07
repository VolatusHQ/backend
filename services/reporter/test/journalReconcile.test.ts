/**
 * The crash-recovery contract this service leans on hardest: "A crashed
 * in-flight action comes back in_flight, never fresh — so you reconcile by
 * looking up the tx hash rather than blindly re-sending" (task brief,
 * mirroring `@volatus/service-kit`'s own journal.ts docs).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openJournal, type Journal } from "@volatus/service-kit";
import type { PublicClient } from "viem";
import { resolveClaim } from "../src/journalReconcile.js";

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fakeLogger() } as never;
}

function fakeClientWithReceipt(receipt: { status: "success" | "reverted" } | null): PublicClient {
  return {
    getTransactionReceipt: vi.fn(async () => {
      if (receipt === null) throw new Error("not found");
      return receipt as never;
    }),
  } as unknown as PublicClient;
}

describe("resolveClaim", () => {
  let journal: Journal;
  beforeEach(() => {
    journal = openJournal(":memory:");
  });
  afterEach(() => journal.close());

  it("a brand-new key is claimed and returns proceed: true", async () => {
    const decision = await resolveClaim({
      journal,
      service: "reporter",
      action: "reportPayoff",
      key: "2",
      publicClient: fakeClientWithReceipt(null),
      isDoneOnChain: async () => false,
      logger: fakeLogger(),
    });
    expect(decision).toEqual({ proceed: true });
  });

  it("a done record returns proceed: false without touching the chain", async () => {
    journal.claim("reporter", "reportPayoff", "2");
    journal.recordDone("reporter", "reportPayoff", "2", "0xabc");
    const isDoneOnChain = vi.fn();
    const decision = await resolveClaim({
      journal,
      service: "reporter",
      action: "reportPayoff",
      key: "2",
      publicClient: fakeClientWithReceipt(null),
      isDoneOnChain,
      logger: fakeLogger(),
    });
    expect(decision.proceed).toBe(false);
    expect(isDoneOnChain).not.toHaveBeenCalled();
  });

  it("in_flight with a hash whose receipt succeeded -> reconciled to done, not resent", async () => {
    journal.claim("reporter", "reportPayoff", "2");
    journal.recordSent("reporter", "reportPayoff", "2", "0xdeadbeef");
    const decision = await resolveClaim({
      journal,
      service: "reporter",
      action: "reportPayoff",
      key: "2",
      publicClient: fakeClientWithReceipt({ status: "success" }),
      isDoneOnChain: async () => {
        throw new Error("must not be reached when a hash is present");
      },
      logger: fakeLogger(),
    });
    expect(decision.proceed).toBe(false);
    expect(journal.get("reporter", "reportPayoff", "2")?.status).toBe("done");
  });

  it("in_flight with a hash whose receipt reverted -> reclaimed and safe to resend", async () => {
    journal.claim("reporter", "reportPayoff", "2");
    journal.recordSent("reporter", "reportPayoff", "2", "0xdeadbeef");
    const decision = await resolveClaim({
      journal,
      service: "reporter",
      action: "reportPayoff",
      key: "2",
      publicClient: fakeClientWithReceipt({ status: "reverted" }),
      isDoneOnChain: async () => false,
      logger: fakeLogger(),
    });
    expect(decision).toEqual({ proceed: true });
  });

  it("in_flight with a hash whose receipt is not yet found -> blocked, NOT resent", async () => {
    journal.claim("reporter", "reportPayoff", "2");
    journal.recordSent("reporter", "reportPayoff", "2", "0xdeadbeef");
    const decision = await resolveClaim({
      journal,
      service: "reporter",
      action: "reportPayoff",
      key: "2",
      publicClient: fakeClientWithReceipt(null),
      isDoneOnChain: async () => false,
      logger: fakeLogger(),
    });
    expect(decision.proceed).toBe(false);
    // Still in_flight -- nothing was recorded as done or failed, so a naive
    // caller cannot mistake this for permission to send again.
    expect(journal.get("reporter", "reportPayoff", "2")?.status).toBe("in_flight");
  });

  it(
    "the crash-recovery case: in_flight with NO recorded hash (crashed between claim and send) and " +
      "on-chain state shows the action already happened -> self-heals to done",
    async () => {
      journal.claim("reporter", "reportPayoff", "2"); // simulates the crash: no recordSent ever ran
      const decision = await resolveClaim({
        journal,
        service: "reporter",
        action: "reportPayoff",
        key: "2",
        publicClient: fakeClientWithReceipt(null),
        isDoneOnChain: async () => true, // e.g. reported() reads true on Arc
        logger: fakeLogger(),
      });
      expect(decision.proceed).toBe(false);
      expect(journal.get("reporter", "reportPayoff", "2")?.status).toBe("done");
    },
  );

  it(
    "the crash-recovery case that matters most: in_flight with NO recorded hash and on-chain state shows " +
      "it has NOT happened -> BLOCKED, never silently treated as fresh, never resent",
    async () => {
      journal.claim("reporter", "reportPayoff", "2"); // crash before recordSent
      const decision = await resolveClaim({
        journal,
        service: "reporter",
        action: "reportPayoff",
        key: "2",
        publicClient: fakeClientWithReceipt(null),
        isDoneOnChain: async () => false,
        logger: fakeLogger(),
      });
      expect(decision.proceed).toBe(false);
      expect(decision.reason).toMatch(/blocked/i);
      // Critically: still in_flight. A caller that ignored `proceed: false`
      // and called claim() again would still get "in_flight", not "fresh" --
      // there is no path from here to an automatic resend.
      expect(journal.claim("reporter", "reportPayoff", "2")).toBe("in_flight");
    },
  );

  it("a restart with a real sqlite file reproduces the same in_flight-no-hash block (not just :memory:)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "reporter-journal-test-"));
    const dbPath = join(dir, "journal.sqlite");
    try {
      const before = openJournal(dbPath);
      before.claim("reporter", "reportPayoff", "2");
      before.close(); // simulates the process dying right after claim()

      const after = openJournal(dbPath);
      const decision = await resolveClaim({
        journal: after,
        service: "reporter",
        action: "reportPayoff",
        key: "2",
        publicClient: fakeClientWithReceipt(null),
        isDoneOnChain: async () => false,
        logger: fakeLogger(),
      });
      expect(decision.proceed).toBe(false);
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
