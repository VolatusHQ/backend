import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig, privateKeySchema, rpcUrlSchema } from "./config.js";

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
