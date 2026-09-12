import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig, optionalUrlSchema, privateKeySchema, rpcUrlSchema } from "./config.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("loadConfig", () => {
  it("throws, naming the missing variable, rather than returning a partial config", () => {
    delete process.env.SOME_TEST_RPC;
    expect(() => loadConfig({ SOME_TEST_RPC: rpcUrlSchema })).toThrowError(/SOME_TEST_RPC/);
  });

  it("throws naming a malformed private key", () => {
    process.env.SOME_TEST_KEY = "not-a-key";
    expect(() => loadConfig({ SOME_TEST_KEY: privateKeySchema })).toThrowError(/SOME_TEST_KEY/);
  });

  it("returns a typed, validated object when everything parses", () => {
    process.env.SOME_TEST_RPC = "https://example.invalid";
    process.env.SOME_TEST_KEY = `0x${"11".repeat(32)}`;
    const config = loadConfig({
      SOME_TEST_RPC: rpcUrlSchema,
      SOME_TEST_KEY: privateKeySchema,
      OPTIONAL_THING: z.string().optional(),
    });
    expect(config.SOME_TEST_RPC).toBe("https://example.invalid");
    expect(config.SOME_TEST_KEY).toBe(`0x${"11".repeat(32)}`);
    expect(config.OPTIONAL_THING).toBeUndefined();
  });
});

describe("optionalUrlSchema", () => {
  it("an unset variable parses to undefined", () => {
    delete process.env.SOME_TEST_WEBHOOK;
    const config = loadConfig({ SOME_TEST_WEBHOOK: optionalUrlSchema });
    expect(config.SOME_TEST_WEBHOOK).toBeUndefined();
  });

  it("an empty string -- what a blank dashboard field like Render's actually sets -- also parses to undefined, not a validation error", () => {
    process.env.SOME_TEST_WEBHOOK = "";
    const config = loadConfig({ SOME_TEST_WEBHOOK: optionalUrlSchema });
    expect(config.SOME_TEST_WEBHOOK).toBeUndefined();
  });

  it("a real URL still parses through unchanged", () => {
    process.env.SOME_TEST_WEBHOOK = "https://example.invalid/hook";
    const config = loadConfig({ SOME_TEST_WEBHOOK: optionalUrlSchema });
    expect(config.SOME_TEST_WEBHOOK).toBe("https://example.invalid/hook");
  });

  it("a non-empty, non-URL string still fails loudly rather than being silently dropped", () => {
    process.env.SOME_TEST_WEBHOOK = "not-a-url";
    expect(() => loadConfig({ SOME_TEST_WEBHOOK: optionalUrlSchema })).toThrowError(/SOME_TEST_WEBHOOK/);
  });
});
