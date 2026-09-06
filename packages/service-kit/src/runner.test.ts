import { describe, expect, it, vi } from "vitest";
import { runLoop } from "./runner.js";

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runLoop", () => {
  it("ticks repeatedly on the interval and stop() prevents further ticks", async () => {
    let count = 0;
    const loop = runLoop({
      name: "test-loop",
      intervalMs: 15,
      jitterMs: 0,
      logger: silentLogger,
      tick: () => {
        count += 1;
      },
    });

    await wait(50); // ~3 ticks
    const countAtStop = count;
    expect(countAtStop).toBeGreaterThanOrEqual(2);

    await loop.stop();
    await wait(40); // long enough for another tick to have fired if stop() didn't work
    expect(count).toBe(countAtStop);
  });

  it("stop() waits for an in-flight tick to finish before resolving", async () => {
    let finished = false;
    const loop = runLoop({
      name: "test-loop",
      intervalMs: 5,
      jitterMs: 0,
      logger: silentLogger,
      tick: async () => {
        await wait(30);
        finished = true;
      },
    });

    await wait(10); // intervalMs (5ms) has elapsed, so the first tick has started (it takes 30ms)
    await loop.stop();
    expect(finished).toBe(true);
  });

  it("escalates to alert() after maxConsecutiveFailures, and resets the count on success", async () => {
    let attempt = 0;
    const alert = vi.fn();
    const loop = runLoop({
      name: "test-loop",
      intervalMs: 5,
      jitterMs: 0,
      maxConsecutiveFailures: 2,
      logger: silentLogger,
      alert,
      tick: () => {
        attempt += 1;
        if (attempt <= 3) throw new Error(`fail ${attempt}`);
      },
    });

    await wait(60);
    await loop.stop();

    // Fails on attempts 1, 2, 3 (consecutiveFailures 1, 2, 3) — alert fires at 2 and 3.
    expect(alert.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(alert.mock.calls[0]![0]).toBe("error");
    expect(alert.mock.calls[0]![1]).toContain("consecutive tick failures");
  });

  it("onError is called with the error and the running consecutive-failure count", async () => {
    const onError = vi.fn();
    const loop = runLoop({
      name: "test-loop",
      intervalMs: 5,
      jitterMs: 0,
      logger: silentLogger,
      onError,
      tick: () => {
        throw new Error("always fails");
      },
    });
    await wait(20);
    await loop.stop();
    expect(onError).toHaveBeenCalled();
    const [err, consecutiveFailures] = onError.mock.calls[0]!;
    expect(err).toBeInstanceOf(Error);
    expect(consecutiveFailures).toBeGreaterThanOrEqual(1);
  });
});
