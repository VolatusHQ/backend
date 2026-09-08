/**
 * Zod-validated environment loading, shared by every backend service.
 *
 * Precedence: `services/.env.local` first, then whatever is already in
 * `process.env` (a real deployment environment variable wins over the file —
 * this is dotenv's default `override: false` behaviour, not something we
 * implement here). The file path is resolved relative to the repo root, not
 * `process.cwd()`, so a service started from its own directory
 * (`services/reporter`) and one started from the repo root both find it.
 *
 * `loadConfig` fails at boot, synchronously, naming every missing or
 * malformed variable. There is no partial success: a service that cannot
 * build a valid config must not start with half of it undefined.
 *
 * Naming convention for secrets: keep config field names identical to the
 * environment variable name (`REPORTER_PRIVATE_KEY`, not `reporterPrivateKey`).
 * `logger.ts` redacts any field whose name contains "privatekey", "secret" or
 * "apikey" case-insensitively, so a field named `REPORTER_PRIVATE_KEY` is
 * caught automatically. `SENSITIVE_CONFIG_KEYS` below is the explicit,
 * checked-in list — pass it to `createLogger({ redactKeys })` for a second,
 * name-based line of defence on top of the logger's own hex-pattern scan.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Repo root + .env.local                                              */
/* ------------------------------------------------------------------ */

const thisDir = dirname(fileURLToPath(import.meta.url));

/**
 * Walk up from a starting directory looking for `pnpm-workspace.yaml`, the
 * one file that only exists at the repo root. Tried from both
 * `process.cwd()` and this module's own install location, because a service
 * may be started from its own package directory, from the repo root, or (in
 * a test runner) from somewhere `dist`-adjacent.
 */
export function getRepoRoot(): string {
  for (const start of [process.cwd(), thisDir]) {
    let dir = start;
    for (let i = 0; i < 12; i++) {
      if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    `service-kit: could not locate the repo root (no pnpm-workspace.yaml found above ${process.cwd()} or ${thisDir})`,
  );
}

let envLoaded = false;

/** Idempotent: safe to call from every service's entrypoint and every test. */
export function loadEnvFile(): void {
  if (envLoaded) return;
  envLoaded = true;
  const root = getRepoRoot();
  // Missing file is fine — dotenv reports an error we ignore; the zod parse
  // below is what actually enforces required vars, with a real error message.
  // `quiet: true` because dotenv's default logging prints a non-JSON banner
  // (plus a rotating promotional "tip") straight to stdout, which would
  // corrupt every service's structured JSON-lines log stream.
  dotenv.config({ path: join(root, "services", ".env.local"), quiet: true });
}

/* ------------------------------------------------------------------ */
/* Reusable field schemas                                              */
/* ------------------------------------------------------------------ */

export const rpcUrlSchema = z
  .string({ required_error: "required: an http(s) RPC URL" })
  .url("must be a valid URL");

/** `0x` + 64 hex chars. Rejects anything shorter, longer, or missing the prefix. */
export const privateKeySchema = z
  .string({ required_error: "required: a 0x-prefixed 64-hex-char private key" })
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x followed by exactly 64 hex characters");

export const optionalUrlSchema = z.string().url("must be a valid URL").optional();

/**
 * Config field names that hold key material. Kept in sync by hand with
 * `commonConfigShape` below — there are only two today. Pass this to
 * `createLogger({ redactKeys: SENSITIVE_CONFIG_KEYS })`.
 */
export const SENSITIVE_CONFIG_KEYS = ["REPORTER_PRIVATE_KEY", "KEEPER_PRIVATE_KEY"] as const;

/**
 * The vars every service in `BACKEND_HANDOFF.md` needs. A given service uses
 * a subset — `loadConfig` takes whatever shape you pass it, this is just the
 * common one so nobody retypes the RPC/key fields per service.
 */
export const commonConfigShape = {
  UNICHAIN_SEPOLIA_RPC: rpcUrlSchema,
  ARC_TESTNET_RPC: rpcUrlSchema,
  REPORTER_PRIVATE_KEY: privateKeySchema,
  KEEPER_PRIVATE_KEY: privateKeySchema,
  ALERT_WEBHOOK_URL: optionalUrlSchema,
  JOURNAL_PATH: z.string().optional(),
};

export type CommonConfig = z.infer<z.ZodObject<typeof commonConfigShape>>;

/* ------------------------------------------------------------------ */
/* loadConfig                                                          */
/* ------------------------------------------------------------------ */

/**
 * Load `services/.env.local` into `process.env`, then validate `process.env`
 * against `shape`. Throws, naming every offending variable, rather than
 * returning a result the caller might not check — a config loader that can
 * be ignored is how a service half-starts.
 *
 * Only the keys named in `shape` are validated; unrelated environment
 * variables (there will be many) are ignored.
 */
export function loadConfig<Shape extends z.ZodRawShape>(shape: Shape): z.infer<z.ZodObject<Shape>> {
  loadEnvFile();
  const schema = z.object(shape);
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`service-kit: invalid configuration — ${problems}`);
  }
  return result.data;
}

/** Convenience wrapper around `loadConfig(commonConfigShape)`. */
export function loadCommonConfig(): CommonConfig {
  return loadConfig(commonConfigShape);
}

/* ------------------------------------------------------------------ */
/* Journal path default                                                */
/* ------------------------------------------------------------------ */

/**
 * Resolve the journal's sqlite path: `configured` if given (relative paths
 * resolve against the repo root, not `process.cwd()`), otherwise
 * `services/.journal.sqlite`. Creates the parent directory if missing —
 * better-sqlite3 does not do that for you.
 *
 * `:memory:` (better-sqlite3's in-memory database, used by tests) passes
 * through untouched rather than being treated as a relative path.
 */
export function resolveJournalPath(configured?: string): string {
  if (configured === ":memory:") return configured;
  const root = getRepoRoot();
  const path =
    configured && configured.length > 0
      ? isAbsolute(configured)
        ? configured
        : join(root, configured)
      : join(root, "services", ".journal.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  return path;
}
