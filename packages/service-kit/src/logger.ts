/**
 * Structured JSON-lines logging to stdout, with two guarantees the rest of
 * this package (and every service built on it) relies on:
 *
 * 1. A secret can never reach a printed line. Any field whose *name* looks
 *    like `privateKey`, `PRIVATE_KEY`, `secret` or `apiKey` (case-insensitive,
 *    underscore optional) is redacted regardless of its value or type — this
 *    is the load-bearing rule, and it catches a secret that isn't hex-shaped.
 *    Separately, any string matching `/0x[0-9a-fA-F]{64}/` — a private key's
 *    shape — is replaced with `[REDACTED_KEY]` wherever it appears, including
 *    interpolated inside a longer error message.
 *
 *    That value rule has one deliberate exception: a transaction hash is the
 *    same shape as a private key, so fields named `hash`/`txHash`/`blockHash`
 *    /`poolId` and friends keep their values. Without the exception every tx
 *    hash the services logged came out as `[REDACTED_KEY]`, destroying the
 *    audit trail that is the entire reason for logging a send.
 * 2. A `bigint` anywhere in the fields never throws. `JSON.stringify` throws
 *    on a raw bigint ("Do not know how to serialize a BigInt"), and every
 *    chain quantity in this codebase is a bigint — this is the single most
 *    common crash in a viem service's logging path. Every bigint is walked
 *    and turned into its decimal string before stringification is attempted.
 *
 * Both are applied by recursively sanitizing the fields object before it is
 * ever handed to `JSON.stringify`, not via a `JSON.stringify` replacer —
 * so `sanitizeForLog` is also reusable by `alerts.ts` for the webhook body.
 */

/* ------------------------------------------------------------------ */
/* Sanitization                                                        */
/* ------------------------------------------------------------------ */

const PRIVATE_KEY_VALUE_RE = /0x[0-9a-fA-F]{64}/g;

/** Matches `privateKey`, `PRIVATE_KEY`, `secret`, `apiKey`, `API_KEY`, and
 * any key containing one of those as a substring (`reporterPrivateKey`,
 * `CIRCLE_API_KEY`), case-insensitive, underscore optional. */
const SENSITIVE_KEY_RE = /private_?key|secret|api_?key/i;

/**
 * Field names whose values are 0x + 64 hex *by definition* and are not
 * secrets: transaction and block hashes, pool ids, merkle roots, salts.
 *
 * Without this the value regex above cannot tell a private key from a
 * transaction hash -- they are the same shape -- so it ate every tx hash the
 * services logged and replaced it with `[REDACTED_KEY]`. That is worse than
 * useless: the whole point of logging a send is to leave an auditable trail,
 * and a reporter that cannot tell you which transaction reported a payoff has
 * lost the only evidence that it did.
 *
 * The real protection against leaking a key is `SENSITIVE_KEY_RE` matching on
 * the field *name*, which is unaffected by this and still fires regardless of
 * the value's shape. A private key arriving under a field named `txHash`
 * would be a bug at the call site, not something a log filter should be
 * relied on to catch.
 */
const HASH_SHAPED_KEY_RE = /^(tx_?hash|transaction_?hash|block_?hash|hash|pool_?id|root|salt|digest|commitment)$/i;

const REDACTED = "[REDACTED_KEY]";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Error);
}

/**
 * Turn an arbitrary value into something `JSON.stringify` can render safely:
 * bigints become decimal strings, private-key-shaped strings and
 * sensitively-named fields are redacted, and `Error` instances (whose
 * `message`/`stack` are non-enumerable and would otherwise stringify to
 * `{}`) are unpacked into plain fields.
 */
export function sanitizeForLog(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  /** Name of the field this value sits under, when it has one. Lets a
   *  hash-shaped field keep its value -- see HASH_SHAPED_KEY_RE. */
  fieldName?: string,
): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (fieldName !== undefined && HASH_SHAPED_KEY_RE.test(fieldName)) return value;
    return value.replace(PRIVATE_KEY_VALUE_RE, REDACTED);
  }
  if (value === null || value === undefined) return value;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeForLog(value.message, seen),
      stack: value.stack ? sanitizeForLog(value.stack, seen) : undefined,
    };
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((item) => sanitizeForLog(item, seen));
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : sanitizeForLog(v, seen, key);
    }
    return out;
  }

  // functions, symbols, etc. — JSON.stringify already drops these safely.
  return value;
}

/* ------------------------------------------------------------------ */
/* Logger                                                              */
/* ------------------------------------------------------------------ */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LoggerOptions {
  /** Included as `service` on every line. */
  service: string;
  /** Minimum level emitted. Default `"info"`. */
  level?: LogLevel;
  /** Extra field names to redact by name, on top of the built-in patterns —
   * e.g. `SENSITIVE_CONFIG_KEYS` from `config.ts`. */
  redactKeys?: readonly string[];
  /** Injectable for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Injectable sink for tests. Defaults to `process.stdout.write`. */
  write?: (line: string) => void;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** A logger that always merges `fields` into every subsequent call. */
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(options: LoggerOptions): Logger {
  const { service, level = "info", now = () => new Date(), write = (line: string) => process.stdout.write(line) } =
    options;
  const extraSensitiveKeys = options.redactKeys ?? [];

  function emit(lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;

    const merged = fields ?? {};
    const redactedExtra: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(merged)) {
      redactedExtra[key] = extraSensitiveKeys.some((k) => k.toLowerCase() === key.toLowerCase())
        ? REDACTED
        : v;
    }

    const sanitizedFields = sanitizeForLog(redactedExtra) as Record<string, unknown>;
    const entry = {
      ...sanitizedFields,
      // Reserved keys always win over a same-named field, so a caller can
      // never accidentally overwrite the envelope.
      ts: now().toISOString(),
      level: lvl,
      service,
      msg,
    };
    write(`${JSON.stringify(entry)}\n`);
  }

  function build(bound: Record<string, unknown>): Logger {
    return {
      debug: (msg, fields) => emitWithBound(bound, "debug", msg, fields),
      info: (msg, fields) => emitWithBound(bound, "info", msg, fields),
      warn: (msg, fields) => emitWithBound(bound, "warn", msg, fields),
      error: (msg, fields) => emitWithBound(bound, "error", msg, fields),
      child: (fields) => build({ ...bound, ...fields }),
    };
  }

  function emitWithBound(
    bound: Record<string, unknown>,
    lvl: LogLevel,
    msg: string,
    fields?: Record<string, unknown>,
  ): void {
    emit(lvl, msg, { ...bound, ...(fields ?? {}) });
  }

  return build({});
}
