/**
 * The tx journal — `BACKEND_HANDOFF.md`'s "persist (epochId → openEpoch tx,
 * settle tx, reportPayoff tx) so a restart never double-sends or, worse,
 * silently skips."
 *
 * Backed by `better-sqlite3`: synchronous, transactional, one file. That is
 * enough at this scale — the reporter and keeper are single processes per
 * service, and the journal's job is surviving a *restart* of that one
 * process, not coordinating a fleet. SQLite's own file locking is what
 * protects against two processes racing on the same file; it is not a
 * distributed lock service and nothing here pretends otherwise.
 *
 * The core primitive is `claim`, an atomic compare-and-reserve:
 *
 *   - No record yet → insert it as `in_flight`, return `"fresh"`. The caller
 *     is clear to build and send the transaction.
 *   - Record is `in_flight` → return `"in_flight"` without changing
 *     anything. This is the crash-recovery case: a previous run (or a
 *     concurrent one) already claimed this action. The caller must NOT
 *     re-send; it must call `get()`, look at `txHash`, and reconcile against
 *     the chain (check the receipt) rather than blindly resubmitting.
 *   - Record is `done` → return `"done"`. Nothing to do.
 *   - Record is `failed` → treated as claimable again, same as no record:
 *     inserted back to `in_flight`, returns `"fresh"`. A recorded failure
 *     means the send definitely did not land (simulation reverted, the RPC
 *     rejected it before broadcast, etc.), so retrying is safe — and every
 *     write this journal guards (`openEpoch`, `reportPayoff`, `sync`) is
 *     already idempotent on-chain (`EpochExists`, `AlreadyReported`), so a
 *     spurious retry after a real failure costs nothing worse than a revert.
 *
 * `claim` never tells the caller to send twice for the same key: the one gap
 * — a claim recorded but the process crashing before `recordSent` — is
 * inherent to any at-least-once send. It surfaces as `in_flight` with a null
 * `txHash`, which `get()` makes visible so the operator can tell the
 * difference between "reconcile from a real tx" and "this was claimed but
 * nothing was ever broadcast."
 */

import Database from "better-sqlite3";
import { resolveJournalPath } from "./config.js";

export type ActionStatus = "in_flight" | "done" | "failed";
export type ClaimResult = "fresh" | "in_flight" | "done";

export interface ActionRecord {
  service: string;
  action: string;
  key: string;
  status: ActionStatus;
  txHash: string | null;
  result: unknown;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SubscriptionRecord {
  epochId: string;
  subscriber: string;
  status: string;
  payload: unknown;
  updatedAt: number;
}

export interface Journal {
  /** Atomically reserve `(service, action, key)`. See module doc for the state machine. */
  claim(service: string, action: string, key: string): ClaimResult;
  /** Record that a transaction was broadcast for a claimed action. Must be claimed first. */
  recordSent(service: string, action: string, key: string, txHash: string): void;
  /** Record that the transaction landed. Terminal — `claim` returns `"done"` from here on. */
  recordDone(service: string, action: string, key: string, txHash: string, result?: unknown): void;
  /** Record that the attempt failed before or without landing. `claim` may reserve it again. */
  recordFailed(service: string, action: string, key: string, error: unknown): void;
  get(service: string, action: string, key: string): ActionRecord | null;
  list(service: string): ActionRecord[];

  /** Generic cursor storage for backfills — block numbers, kept bigint-safe as text. */
  getCursor(name: string): bigint | null;
  setCursor(name: string, block: bigint | number): void;

  /** The keeper's subscription registry, keyed by (epochId, subscriber). */
  upsertSubscription(
    epochId: bigint | string,
    subscriber: string,
    status: string,
    payload?: unknown,
  ): void;
  listSubscriptions(epochId?: bigint | string): SubscriptionRecord[];
  dropSubscription(epochId: bigint | string, subscriber: string): void;

  close(): void;
}

interface ActionRow {
  service: string;
  action: string;
  key: string;
  status: ActionStatus;
  tx_hash: string | null;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface SubscriptionRow {
  epoch_id: string;
  subscriber: string;
  status: string;
  payload: string | null;
  updated_at: number;
}

function toActionRecord(row: ActionRow): ActionRecord {
  return {
    service: row.service,
    action: row.action,
    key: row.key,
    status: row.status,
    txHash: row.tx_hash,
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSubscriptionRecord(row: SubscriptionRow): SubscriptionRecord {
  return {
    epochId: row.epoch_id,
    subscriber: row.subscriber,
    status: row.status,
    payload: row.payload ? JSON.parse(row.payload) : null,
    updatedAt: row.updated_at,
  };
}

/** Open (creating if needed) the journal at `dbPath`, or the config default. */
export function openJournal(dbPath?: string): Journal {
  const path = resolveJournalPath(dbPath);
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS actions (
      service    TEXT NOT NULL,
      action     TEXT NOT NULL,
      key        TEXT NOT NULL,
      status     TEXT NOT NULL,
      tx_hash    TEXT,
      result     TEXT,
      error      TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (service, action, key)
    );

    CREATE TABLE IF NOT EXISTS kv (
      name  TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      epoch_id   TEXT NOT NULL,
      subscriber TEXT NOT NULL,
      status     TEXT NOT NULL,
      payload    TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (epoch_id, subscriber)
    );
  `);

  const getActionStmt = db.prepare<[string, string, string], ActionRow>(
    "SELECT * FROM actions WHERE service = ? AND action = ? AND key = ?",
  );
  const insertActionStmt = db.prepare(
    `INSERT INTO actions (service, action, key, status, tx_hash, result, error, created_at, updated_at)
     VALUES (@service, @action, @key, @status, @txHash, @result, @error, @now, @now)`,
  );
  const reclaimActionStmt = db.prepare(
    `UPDATE actions SET status = 'in_flight', tx_hash = NULL, result = NULL, error = NULL, updated_at = @now
     WHERE service = @service AND action = @action AND key = @key`,
  );
  const upsertActionStmt = db.prepare(
    `INSERT INTO actions (service, action, key, status, tx_hash, result, error, created_at, updated_at)
     VALUES (@service, @action, @key, @status, @txHash, @result, @error, @now, @now)
     ON CONFLICT (service, action, key) DO UPDATE SET
       status = excluded.status,
       tx_hash = excluded.tx_hash,
       result = excluded.result,
       error = excluded.error,
       updated_at = excluded.updated_at`,
  );

  const claim = db.transaction((service: string, action: string, key: string): ClaimResult => {
    const row = getActionStmt.get(service, action, key);
    if (!row) {
      insertActionStmt.run({
        service,
        action,
        key,
        status: "in_flight",
        txHash: null,
        result: null,
        error: null,
        now: Date.now(),
      });
      return "fresh";
    }
    if (row.status === "done") return "done";
    if (row.status === "failed") {
      reclaimActionStmt.run({ service, action, key, now: Date.now() });
      return "fresh";
    }
    return "in_flight"; // already in_flight — do not re-send, reconcile via get()
  });

  function recordSent(service: string, action: string, key: string, txHash: string): void {
    const row = getActionStmt.get(service, action, key);
    if (!row) {
      throw new Error(
        `journal: recordSent("${service}", "${action}", "${key}") called without a prior claim()`,
      );
    }
    upsertActionStmt.run({
      service,
      action,
      key,
      status: "in_flight",
      txHash,
      result: null,
      error: null,
      now: Date.now(),
    });
  }

  function recordDone(
    service: string,
    action: string,
    key: string,
    txHash: string,
    result?: unknown,
  ): void {
    upsertActionStmt.run({
      service,
      action,
      key,
      status: "done",
      txHash,
      result: result === undefined ? null : JSON.stringify(result),
      error: null,
      now: Date.now(),
    });
  }

  function recordFailed(service: string, action: string, key: string, error: unknown): void {
    const existing = getActionStmt.get(service, action, key);
    upsertActionStmt.run({
      service,
      action,
      key,
      status: "failed",
      txHash: existing?.tx_hash ?? null,
      result: null,
      error: error instanceof Error ? error.message : String(error),
      now: Date.now(),
    });
  }

  function get(service: string, action: string, key: string): ActionRecord | null {
    const row = getActionStmt.get(service, action, key);
    return row ? toActionRecord(row) : null;
  }

  const listActionsStmt = db.prepare<[string], ActionRow>(
    "SELECT * FROM actions WHERE service = ? ORDER BY created_at ASC",
  );
  function list(service: string): ActionRecord[] {
    return listActionsStmt.all(service).map(toActionRecord);
  }

  const getCursorStmt = db.prepare<[string], { value: string }>("SELECT value FROM kv WHERE name = ?");
  const setCursorStmt = db.prepare(
    `INSERT INTO kv (name, value) VALUES (@name, @value)
     ON CONFLICT (name) DO UPDATE SET value = excluded.value`,
  );
  function getCursor(name: string): bigint | null {
    const row = getCursorStmt.get(name);
    return row ? BigInt(row.value) : null;
  }
  function setCursor(name: string, block: bigint | number): void {
    setCursorStmt.run({ name, value: block.toString() });
  }

  const upsertSubscriptionStmt = db.prepare(
    `INSERT INTO subscriptions (epoch_id, subscriber, status, payload, updated_at)
     VALUES (@epochId, @subscriber, @status, @payload, @now)
     ON CONFLICT (epoch_id, subscriber) DO UPDATE SET
       status = excluded.status,
       payload = excluded.payload,
       updated_at = excluded.updated_at`,
  );
  function upsertSubscription(
    epochId: bigint | string,
    subscriber: string,
    status: string,
    payload?: unknown,
  ): void {
    upsertSubscriptionStmt.run({
      epochId: epochId.toString(),
      subscriber,
      status,
      payload: payload === undefined ? null : JSON.stringify(payload),
      now: Date.now(),
    });
  }

  const listAllSubscriptionsStmt = db.prepare<[], SubscriptionRow>(
    "SELECT * FROM subscriptions ORDER BY updated_at ASC",
  );
  const listSubscriptionsForEpochStmt = db.prepare<[string], SubscriptionRow>(
    "SELECT * FROM subscriptions WHERE epoch_id = ? ORDER BY updated_at ASC",
  );
  function listSubscriptions(epochId?: bigint | string): SubscriptionRecord[] {
    const rows =
      epochId === undefined
        ? listAllSubscriptionsStmt.all()
        : listSubscriptionsForEpochStmt.all(epochId.toString());
    return rows.map(toSubscriptionRecord);
  }

  const dropSubscriptionStmt = db.prepare(
    "DELETE FROM subscriptions WHERE epoch_id = ? AND subscriber = ?",
  );
  function dropSubscription(epochId: bigint | string, subscriber: string): void {
    dropSubscriptionStmt.run(epochId.toString(), subscriber);
  }

  return {
    claim,
    recordSent,
    recordDone,
    recordFailed,
    get,
    list,
    getCursor,
    setCursor,
    upsertSubscription,
    listSubscriptions,
    dropSubscription,
    close: () => db.close(),
  };
}
