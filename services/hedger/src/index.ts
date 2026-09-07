#!/usr/bin/env node
/**
 * Entrypoint for `@volatus/hedger` — BACKEND_HANDOFF.md's Service 3.
 *
 *   node dist/index.js start    (default) — run the re-rate loop.
 *   node dist/index.js once     — a single tick, then exit.
 *   node dist/index.js status   — one-shot report, never sends a transaction.
 *
 * `DRY_RUN=1` applies to `start` and `once`: the loop still reads the oracle,
 * derives gamma, computes the target and evaluates drift, it just never signs.
 * `status` is always dry.
 *
 * **On the signer.** The agent never holds the user's key. The production path
 * is a Privy session signer under a TEE policy pinned to `SigmaStream`
 * (`delegation/privySessionSigner.ts`), which is built and unit-tested against
 * a mocked Privy client and has NEVER run against Privy's live API — no
 * `PRIVY_APP_ID`/`PRIVY_APP_SECRET` is provisioned here. `localSigner` exists
 * only to demonstrate the loop on testnet with a key we already own; it
 * refuses to construct unless `HEDGER_ALLOW_LOCAL_SIGNER=1`, and it does NOT
 * provide the delegation property — see README.md.
 */

import { arcClient, unichainClient } from "@volatus/onchain";
import {
  createLogger,
  makeAlerter,
  openJournal,
  runLoop,
  SENSITIVE_CONFIG_KEYS,
} from "@volatus/service-kit";
import { loadHedgerConfig, mandateFromConfig } from "./config.js";
import { makeLocalSigner } from "./delegation/localSigner.js";
import { formatStatusReport } from "./status.js";
import { runHedgerTick, type HedgerTickDeps } from "./tick.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "start";
  const config = loadHedgerConfig();
  const logger = createLogger({ service: "hedger", redactKeys: SENSITIVE_CONFIG_KEYS });
  const journal = openJournal(config.JOURNAL_PATH);
  const alerter = makeAlerter({ service: "hedger", logger, webhookUrl: config.ALERT_WEBHOOK_URL });

  const nowTs = BigInt(Math.floor(Date.now() / 1000));
  const mandate = mandateFromConfig(config, nowTs);

  const baseDeps: Omit<HedgerTickDeps, "dryRun" | "signer"> = {
    mandate,
    journal,
    unichainClient,
    arcClient,
    logger,
    positionScanFromBlock: config.HEDGER_POSITION_SCAN_START_BLOCK,
  };

  if (command === "status") {
    // No signer is constructed at all here, so `status` cannot send even by mistake.
    const result = await runHedgerTick({ ...baseDeps, dryRun: true });
    process.stdout.write(`${formatStatusReport(result, mandate)}\n`);
    journal.close();
    return;
  }

  if (command !== "start" && command !== "once") {
    process.stderr.write(`unknown command "${command}" — expected "start", "once" or "status"\n`);
    process.exitCode = 1;
    journal.close();
    return;
  }

  const dryRun = config.DRY_RUN === "1";

  // Only built when something might actually be sent. `makeLocalSigner` throws
  // unless HEDGER_ALLOW_LOCAL_SIGNER is exactly "1".
  const signer = dryRun
    ? undefined
    : makeLocalSigner({
        privateKey: config.DEPLOYER_PRIVATE_KEY as `0x${string}`,
        rpcUrl: config.ARC_TESTNET_RPC,
        allowFlag: config.HEDGER_ALLOW_LOCAL_SIGNER,
        streamAddress: mandate.streamAddress,
        usdcAddress: mandate.usdcAddress,
      });

  if (command === "once") {
    const result = await runHedgerTick({ ...baseDeps, dryRun, signer });
    process.stdout.write(`${formatStatusReport(result, mandate)}\n`);
    journal.close();
    return;
  }

  logger.info("hedger starting", {
    dryRun,
    mandate: mandate.id,
    owner: mandate.owner,
    epochId: mandate.epochId,
    intervalMs: config.HEDGER_TICK_INTERVAL_MS,
  });

  const loop = runLoop({
    name: "hedger",
    intervalMs: config.HEDGER_TICK_INTERVAL_MS,
    logger,
    alert: alerter.alert,
    tick: async () => {
      const r = await runHedgerTick({ ...baseDeps, dryRun, signer });
      logger.info("hedger tick", {
        ivOk: r.ivResult.ok,
        skipped: r.skippedReason,
        adjust: r.adjustDecision?.due ?? false,
        fund: r.fundDecision?.due ?? false,
        spent: r.cumulativeSpentUsdc,
        hash: r.adjustSendResult?.ok ? r.adjustSendResult.hash : undefined,
      });
    },
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void loop.stop().then(() => journal.close());
    });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
