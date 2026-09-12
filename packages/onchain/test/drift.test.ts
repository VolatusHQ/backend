/**
 * The important test in this package.
 *
 * `frontend/app/app/lib/onchain/` (a sibling repo, not a subdirectory of this
 * one since the three-repo split) is still a separate, TypeScript-only copy
 * of the same chains/addresses/constants this package exports — the frontend
 * has not been repointed at `@volatus/onchain` yet. Until it is, the two
 * trees can silently drift: someone fixes an address here and forgets there,
 * or the reverse, and the result is not an error, it is a plausible wrong
 * number.
 *
 * This file cannot `import` the web copy — it lives in a different repo
 * entirely and is not built as a library — so it reads the web source files
 * as *text* and greps them with the same regex a human would use to
 * spot-check by eye. That is deliberately unsophisticated: the point is to
 * catch a literal typo or a forgotten edit, not to parse TypeScript.
 *
 * Every failure message below names the constant, so a future divergence
 * fails loudly instead of as a bare "expected true, got false".
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as onchainAddresses from "../src/addresses";
import { arcTestnet, unichainSepolia } from "../src/chains";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webOnchainDir = resolve(__dirname, "../../../../frontend/app/app/lib/onchain");

const webAddressesSrc = readFileSync(resolve(webOnchainDir, "addresses.ts"), "utf8");
const webChainsSrc = readFileSync(resolve(webOnchainDir, "chains.ts"), "utf8");

/**
 * The old, dead SigmaStream address the web copy still points at as of this
 * writing (PHASES.md § Ground truth, WIRING.md § Redeploy). Its
 * `settlementReporter` is immutable and set to a key nobody holds, so nothing
 * reported on it will ever settle — see `src/addresses.ts` for the full story.
 *
 * The `SIGMA_STREAM` exemption that used to live here is gone: `frontend` was
 * repointed at the new deployment on 2026-09-05, so the address now falls into
 * the ordinary byte-identical check like every other one. The dead address is
 * still named below, as a value neither tree is allowed to drift back to.
 */
const DEAD_SIGMA_STREAM = "0xD7EeD2a64762A7038d64886882161bA1b1EfC074";

/** `export const NAME: Address = "0x...";` — the same shape every address in
 *  both trees is declared with. */
const ADDRESS_LITERAL_RE = /export const (\w+): Address = "(0x[0-9a-fA-F]{40})"/g;

function extractAddressLiterals(src: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of src.matchAll(ADDRESS_LITERAL_RE)) {
    found.set(match[1], match[2]);
  }
  return found;
}

describe("frontend onchain copy does not disagree with @volatus/onchain", () => {
  const webAddresses = extractAddressLiterals(webAddressesSrc);

  it("found address literals to compare (the regex itself did not silently break)", () => {
    expect(webAddresses.size).toBeGreaterThan(5);
  });

  it("neither tree points at the dead SigmaStream", () => {
    // The old contract's `settlementReporter` is immutable and set to a key
    // nobody holds, so no epoch on it can ever be reported. Pointing anything
    // at it again is a silent, total failure -- the UI would read plausible
    // numbers off a contract that can never pay out.
    expect(
      webAddresses.get("SIGMA_STREAM"),
      "frontend has drifted back to the dead SigmaStream",
    ).not.toBe(DEAD_SIGMA_STREAM);
    expect(
      onchainAddresses.SIGMA_STREAM,
      "@volatus/onchain has drifted back to the dead SigmaStream",
    ).not.toBe(DEAD_SIGMA_STREAM);
  });

  for (const [name, webValue] of extractAddressLiterals(webAddressesSrc)) {
    it(`${name} is byte-identical between frontend and @volatus/onchain`, () => {
      const pkgValue = (onchainAddresses as Record<string, unknown>)[name];
      expect(
        typeof pkgValue,
        `@volatus/onchain does not export a constant named ${name}, but frontend does`,
      ).toBe("string");
      expect(
        pkgValue,
        `${name} has diverged: frontend has ${webValue}, @volatus/onchain has ${pkgValue}`,
      ).toBe(webValue);
    });
  }

  it("USDC_DECIMALS is 6 in both trees", () => {
    expect(onchainAddresses.USDC_DECIMALS, "@volatus/onchain USDC_DECIMALS").toBe(6);
    expect(webAddressesSrc, "web addresses.ts USDC_DECIMALS literal").toMatch(
      /export const USDC_DECIMALS = 6\b/,
    );
  });

  it("WAD is 10n ** 18n in both trees", () => {
    expect(onchainAddresses.WAD, "@volatus/onchain WAD").toBe(10n ** 18n);
    expect(webAddressesSrc, "web addresses.ts WAD literal").toMatch(
      /export const WAD = 10n \*\* 18n\b/,
    );
  });

  it("chain ids 1301 (Unichain Sepolia) and 5042002 (Arc Testnet) match both trees", () => {
    const webIds = [...webChainsSrc.matchAll(/id:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(webIds, "frontend chains.ts must define Unichain Sepolia's id 1301").toContain(1301);
    expect(webIds, "frontend chains.ts must define Arc Testnet's id 5042002").toContain(5042002);
    expect(unichainSepolia.id, "@volatus/onchain unichainSepolia.id").toBe(1301);
    expect(arcTestnet.id, "@volatus/onchain arcTestnet.id").toBe(5042002);
  });
});

/**
 * `severity.ts` is meant to be a byte-identical mirror, not a set of
 * individually-checked constants the way `addresses.ts` is above -- so the
 * drift check is simpler and stricter: the two files must be identical.
 * Whitespace-normalized (trailing newline / CRLF-vs-LF) rather than a raw
 * byte comparison, so the check fails on a real edit, not a line-ending diff.
 */
describe("frontend's severity.ts is a byte-identical mirror of @volatus/onchain's", () => {
  it("packages/onchain/src/severity.ts and frontend/.../onchain/severity.ts are identical", () => {
    const pkgSrc = readFileSync(resolve(__dirname, "../src/severity.ts"), "utf8");
    const webSrc = readFileSync(resolve(webOnchainDir, "severity.ts"), "utf8");
    const normalize = (s: string) => s.replace(/\r\n/g, "\n").trimEnd();
    expect(
      normalize(webSrc),
      "frontend/app/app/lib/onchain/severity.ts has diverged from packages/onchain/src/severity.ts -- copy the file over again",
    ).toBe(normalize(pkgSrc));
  });
});
