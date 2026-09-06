import { describe, expect, it } from "vitest";
import { createLogger, sanitizeForLog } from "./logger.js";

const FAKE_PRIVATE_KEY = `0x${"ab".repeat(32)}` as const; // 0x + 64 hex chars, shaped exactly like a real key

function captureLines(fn: (write: (line: string) => void) => void): string[] {
  const lines: string[] = [];
  fn((line) => lines.push(line));
  return lines;
}

describe("logger secret redaction", () => {
  it("never emits a private key value, even nested and even alongside other text", () => {
    const lines = captureLines((write) => {
      const logger = createLogger({ service: "test", write });
      logger.info("sending tx", {
        signer: FAKE_PRIVATE_KEY,
        note: `about to sign with ${FAKE_PRIVATE_KEY} now`,
        nested: { deeper: { keyHere: FAKE_PRIVATE_KEY } },
        list: [FAKE_PRIVATE_KEY, "safe-value"],
      });
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(FAKE_PRIVATE_KEY);
    expect(lines[0]).toContain("[REDACTED_KEY]");

    const parsed = JSON.parse(lines[0]);
    expect(parsed.signer).toBe("[REDACTED_KEY]");
    expect(parsed.note).toBe("about to sign with [REDACTED_KEY] now");
    expect(parsed.nested.deeper.keyHere).toBe("[REDACTED_KEY]");
    expect(parsed.list).toEqual(["[REDACTED_KEY]", "safe-value"]);
  });

  it("redacts by field name regardless of value shape (privateKey, PRIVATE_KEY, secret, apiKey)", () => {
    const lines = captureLines((write) => {
      const logger = createLogger({ service: "test", write });
      logger.info("config loaded", {
        privateKey: "not-hex-shaped-at-all",
        PRIVATE_KEY: "also-not-hex",
        REPORTER_PRIVATE_KEY: "still-not-hex",
        secret: "sk-live-something",
        apiKey: "abc123",
        CIRCLE_API_KEY: "abc123",
        harmless: "this stays",
      });
    });

    const parsed = JSON.parse(lines[0]);
    expect(parsed.privateKey).toBe("[REDACTED_KEY]");
    expect(parsed.PRIVATE_KEY).toBe("[REDACTED_KEY]");
    expect(parsed.REPORTER_PRIVATE_KEY).toBe("[REDACTED_KEY]");
    expect(parsed.secret).toBe("[REDACTED_KEY]");
    expect(parsed.apiKey).toBe("[REDACTED_KEY]");
    expect(parsed.CIRCLE_API_KEY).toBe("[REDACTED_KEY]");
    expect(parsed.harmless).toBe("this stays");
  });

  it("redacts extra key names passed via redactKeys (config.ts's SENSITIVE_CONFIG_KEYS hand-off)", () => {
    const lines = captureLines((write) => {
      const logger = createLogger({ service: "test", write, redactKeys: ["CUSTOM_TOKEN"] });
      logger.info("msg", { CUSTOM_TOKEN: "whatever-this-is" });
    });
    expect(JSON.parse(lines[0]).CUSTOM_TOKEN).toBe("[REDACTED_KEY]");
  });

  it("redacts inside an Error's message and stack", () => {
    const err = new Error(`boom: key was ${FAKE_PRIVATE_KEY}`);
    const lines = captureLines((write) => {
      const logger = createLogger({ service: "test", write });
      logger.error("failed", { err });
    });
    expect(lines[0]).not.toContain(FAKE_PRIVATE_KEY);
  });
});

describe("logger bigint serialization", () => {
  it("serializes bigint fields as decimal strings instead of throwing", () => {
    const lines = captureLines((write) => {
      const logger = createLogger({ service: "test", write });
      expect(() =>
        logger.info("balance read", {
          balanceWei: 8_000_000_000_000_000_000n,
          nested: { payoffWad: 500_000_000_000_000_000n },
          list: [1n, 2n, 3n],
        }),
      ).not.toThrow();
    });

    const parsed = JSON.parse(lines[0]);
    expect(parsed.balanceWei).toBe("8000000000000000000");
    expect(parsed.nested.payoffWad).toBe("500000000000000000");
    expect(parsed.list).toEqual(["1", "2", "3"]);
  });

  it("sanitizeForLog handles bigint directly", () => {
    expect(sanitizeForLog(123n)).toBe("123");
    expect(sanitizeForLog({ a: 1n })).toEqual({ a: "1" });
  });
});

describe("logger envelope", () => {
  it("includes ts, level, service, msg and cannot be overridden by a same-named field", () => {
    const lines = captureLines((write) => {
      const logger = createLogger({ service: "reporter", write, now: () => new Date("2026-09-05T00:00:00.000Z") });
      logger.warn("careful", { level: "not-a-real-level", service: "spoofed", msg: "spoofed" });
    });
    const parsed = JSON.parse(lines[0]);
    expect(parsed.ts).toBe("2026-09-05T00:00:00.000Z");
    expect(parsed.level).toBe("warn");
    expect(parsed.service).toBe("reporter");
    expect(parsed.msg).toBe("careful");
  });

  it("respects the minimum level", () => {
    const lines = captureLines((write) => {
      const logger = createLogger({ service: "test", write, level: "warn" });
      logger.debug("hidden");
      logger.info("also hidden");
      logger.warn("visible");
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).msg).toBe("visible");
  });

  it("child() binds fields onto every subsequent call", () => {
    const lines = captureLines((write) => {
      const logger = createLogger({ service: "test", write });
      const child = logger.child({ epochId: "2" });
      child.info("first");
      child.info("second", { extra: true });
    });
    expect(JSON.parse(lines[0]).epochId).toBe("2");
    expect(JSON.parse(lines[1])).toMatchObject({ epochId: "2", extra: true });
  });
});
