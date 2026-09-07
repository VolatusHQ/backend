/**
 * `checkDeadlineAlarm` wires this service's Arc epoch state into
 * `@volatus/service-kit`'s `deadlineAlarm` — the piece BACKEND_HANDOFF.md
 * calls "the difference between a payout and a mass refund." This tests the
 * wiring (right deadline, right margin, right `isDone`), not `deadlineAlarm`
 * itself (already covered in `packages/service-kit`).
 */
import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { checkDeadlineAlarm } from "../src/tick.js";

function streamClient(epoch: {
  coverageEnd: bigint;
  reportDeadline: bigint;
  reported: boolean;
}): PublicClient {
  return {
    readContract: vi.fn(async () => ({
      coverageStart: 0n,
      coverageEnd: epoch.coverageEnd,
      reportDeadline: epoch.reportDeadline,
      reported: epoch.reported,
      payoffWad: 0n,
      totalCoverageSold: 0n,
    })),
  } as unknown as PublicClient;
}

describe("checkDeadlineAlarm", () => {
  it("does not fire while comfortably inside the margin window", async () => {
    const reportDeadline = 1_789_239_788n;
    const margin = 21_600; // 6h
    // Freeze "now" via a client that also reports the current block/time --
    // deadlineAlarm's own `now` defaults to the real clock, so drive this
    // via a deadline far enough in the future that "now" (real time) is
    // still outside the margin. Use a deadline ~100 years out instead of
    // trying to mock Date.now().
    const farFuture = BigInt(Math.floor(Date.now() / 1000)) + 100n * 365n * 24n * 60n * 60n;
    const alert = vi.fn();
    await checkDeadlineAlarm({
      epochId: 2n,
      arcClient: streamClient({ coverageEnd: 1n, reportDeadline: farFuture, reported: false }),
      alert,
      deadlineAlarmMarginSeconds: margin,
    });
    expect(alert).not.toHaveBeenCalled();
    void reportDeadline;
  });

  it("fires BEFORE the deadline once inside the margin window, while unreported", async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const margin = 21_600; // 6h
    const reportDeadline = now + 100n; // deadline is 100s in the future -- inside a 6h margin
    const alert = vi.fn();

    const fired = await checkDeadlineAlarm({
      epochId: 2n,
      arcClient: streamClient({ coverageEnd: 1n, reportDeadline, reported: false }),
      alert,
      deadlineAlarmMarginSeconds: margin,
    });

    expect(alert).toHaveBeenCalledTimes(1);
    const [level, msg] = alert.mock.calls[0]!;
    expect(level).toBe("warn"); // still before the deadline itself -> warn, not error
    expect(msg).toContain("reportPayoff(2)");
    void fired;
  });

  it("never fires once the epoch is already reported, no matter how close the deadline is", async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const alert = vi.fn();
    await checkDeadlineAlarm({
      epochId: 2n,
      arcClient: streamClient({ coverageEnd: 1n, reportDeadline: now - 1_000_000n, reported: true }),
      alert,
      deadlineAlarmMarginSeconds: 21_600,
    });
    expect(alert).not.toHaveBeenCalled();
  });

  it("does nothing for an epoch that has never been mirrored onto Arc (coverageEnd == 0)", async () => {
    const alert = vi.fn();
    const client = streamClient({ coverageEnd: 0n, reportDeadline: 0n, reported: false });
    await checkDeadlineAlarm({
      epochId: 3n,
      arcClient: client,
      alert,
      deadlineAlarmMarginSeconds: 21_600,
    });
    expect(alert).not.toHaveBeenCalled();
    expect(client.readContract).toHaveBeenCalledTimes(1); // still reads once to find out
  });
});
