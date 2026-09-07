/**
 * One full pass: discover + mirror new vault epochs (job 1a), then for every
 * epoch this service knows about, try to settle it on Unichain and report it
 * to Arc (job 1b), and check the deadline alarm. `runLoop` (service-kit)
 * calls this on an interval; `index.ts --once`/`DRY_RUN=1` call it exactly
 * once.
 */

import type { PublicClient } from "viem";
import { sigmaStreamAbi, SIGMA_STREAM } from "@volatus/onchain";
import { deadlineAlarm, type AlertFn, type Journal, type Wallet } from "@volatus/service-kit";
import { discoverAndMirrorEpochs } from "./discovery.js";
import { listKnownEpochIds } from "./knownEpochs.js";
import { reportEpoch } from "./report.js";
import { settleEpoch } from "./settle.js";
import type { Logger } from "./journalReconcile.js";

export interface TickContext {
  journal: Journal;
  unichainClient: PublicClient;
  arcClient: PublicClient;
  unichainWallet: Wallet;
  arcWallet: Wallet;
  logger: Logger;
  alert: AlertFn;
  reportDeadlineMarginSeconds: bigint;
  deadlineAlarmMarginSeconds: number;
  scanStartBlock: bigint;
  dryRun: boolean;
}

export async function tick(ctx: TickContext): Promise<void> {
  const discovered = await discoverAndMirrorEpochs(ctx);

  // Union with the journal's own record, deduped: a real run's journal
  // already contains every epoch discovery has ever found, so this is a
  // no-op there. Under DRY_RUN (which never writes to the journal) this is
  // what lets settle/report preview epochs found in *this very scan* on an
  // otherwise pristine journal.
  const known = new Set(listKnownEpochIds(ctx.journal));
  for (const id of discovered) known.add(id);
  const epochIds = [...known].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const epochId of epochIds) {
    const { settled, payoffWad } = await settleEpoch({ epochId, ...ctx });
    if (settled && payoffWad !== null) {
      await reportEpoch({ epochId, payoffWad, ...ctx });
    }
    await checkDeadlineAlarm({ epochId, ...ctx });
  }
}

export async function checkDeadlineAlarm(params: {
  epochId: bigint;
  arcClient: PublicClient;
  alert: AlertFn;
  deadlineAlarmMarginSeconds: number;
}): Promise<void> {
  const key = params.epochId.toString();
  const streamEpoch = await params.arcClient.readContract({
    address: SIGMA_STREAM,
    abi: sigmaStreamAbi,
    functionName: "epoch",
    args: [params.epochId],
  });
  if (streamEpoch.coverageEnd === 0n) return; // not mirrored yet -- no deadline to guard

  await deadlineAlarm({
    name: `reportPayoff(${key})`,
    deadline: Number(streamEpoch.reportDeadline),
    margin: params.deadlineAlarmMarginSeconds,
    isDone: () => streamEpoch.reported,
    alert: params.alert,
  });
}
