import { describe, expect, it, vi } from "vitest";
import { deadlineAlarm, makeAlerter } from "./alerts.js";

describe("makeAlerter", () => {
  it("always logs, and posts to the webhook when set", async () => {
    const lines: string[] = [];
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const { alert } = makeAlerter({
      service: "reporter",
      webhookUrl: "https://hooks.example.invalid/alert",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: {
        debug: () => {},
        info: () => {},
        warn: (msg) => lines.push(msg),
        error: (msg) => lines.push(msg),
        child: () => ({ debug() {}, info() {}, warn() {}, error() {}, child() { throw new Error("unused"); } }),
      },
    });

    await alert("warn", "reportDeadline approaching", { epochId: "2" });

    expect(lines).toEqual(["reportDeadline approaching"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://hooks.example.invalid/alert");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ service: "reporter", level: "warn", msg: "reportDeadline approaching" });
  });

  it("does not attempt a webhook call when none is configured", async () => {
    const fetchImpl = vi.fn();
    const { alert } = makeAlerter({ service: "reporter", fetchImpl: fetchImpl as unknown as typeof fetch });
    await alert("error", "no webhook configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("deadlineAlarm", () => {
  const deadline = 1_000_000;
  const margin = 3600; // 1h

  it("does not fire before the margin window opens", async () => {
    const alert = vi.fn();
    const fired = await deadlineAlarm({
      name: "reportPayoff(2)",
      deadline,
      margin,
      isDone: () => false,
      alert,
      now: () => deadline - margin - 1,
    });
    expect(fired).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it("does NOT fire at exactly deadline - margin -- arms strictly after that instant, not at it", async () => {
    // BRIEF.md asks for this boundary precisely. `armAt = deadline - margin`; the
    // guard is `now <= armAt` -> don't fire, so `now === armAt` is still "not yet".
    // Documented here because it is easy to assume the margin window is closed
    // (inclusive) at its own edge -- it isn't, by one second -- and every real
    // margin in this codebase is measured in hours, so the one-second gap is
    // immaterial to the safety property but worth pinning down explicitly.
    const alert = vi.fn();
    const fired = await deadlineAlarm({
      name: "reportPayoff(2)",
      deadline,
      margin,
      isDone: () => false,
      alert,
      now: () => deadline - margin,
    });
    expect(fired).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it("fires at exactly one second past deadline - margin -- the earliest instant it can", async () => {
    const alert = vi.fn();
    const fired = await deadlineAlarm({
      name: "reportPayoff(2)",
      deadline,
      margin,
      isDone: () => false,
      alert,
      now: () => deadline - margin + 1,
    });
    expect(fired).toBe(true);
  });

  it("fires (as a warning) once inside the margin, before the deadline", async () => {
    const alert = vi.fn();
    const fired = await deadlineAlarm({
      name: "reportPayoff(2)",
      deadline,
      margin,
      isDone: () => false,
      alert,
      now: () => deadline - margin + 1,
    });
    expect(fired).toBe(true);
    expect(alert).toHaveBeenCalledWith("warn", expect.stringContaining("reportPayoff(2)"), expect.any(Object));
  });

  it("escalates to error once the deadline itself has passed", async () => {
    const alert = vi.fn();
    const fired = await deadlineAlarm({
      name: "reportPayoff(2)",
      deadline,
      margin,
      isDone: () => false,
      alert,
      now: () => deadline + 10,
    });
    expect(fired).toBe(true);
    expect(alert).toHaveBeenCalledWith("error", expect.any(String), expect.any(Object));
  });

  it("never fires once the work is done", async () => {
    const alert = vi.fn();
    const fired = await deadlineAlarm({
      name: "reportPayoff(2)",
      deadline,
      margin,
      isDone: () => true,
      alert,
      now: () => deadline + 100,
    });
    expect(fired).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });
});
