/**
 * `status` command — a read-only picture of every epoch the vault knows
 * about, both chains' state, what this service's journal has recorded, and
 * what (if anything) is left to do. Deliberately independent of the
 * journal's backfill cursor: it enumerates `1..vault.epochCount()` directly
 * so it is accurate even before job 1a's log scan has ever run.
 */

import type { PublicClient } from "viem";
import { sigmaStreamAbi, sigmaVaultAbi, SIGMA_STREAM, SIGMA_VAULT, wadToRatio } from "@volatus/onchain";
import type { ActionStatus, Journal } from "@volatus/service-kit";
import { SERVICE } from "./constants.js";

export interface EpochStatus {
  epochId: bigint;
  vault: { endBlock: bigint; settled: boolean; payoffWad: bigint };
  arc: { coverageEnd: bigint; reportDeadline: bigint; reported: boolean; payoffWad: bigint } | null;
  journal: {
    openEpoch: ActionStatus | "none";
    settle: ActionStatus | "none";
    reportPayoff: ActionStatus | "none";
  };
  secondsToReportDeadline: bigint | null;
  phase:
    | "not-mirrored"
    | "ended-never-mirrored"
    | "awaiting-endBlock"
    | "settled-awaiting-report"
    | "reported"
    | "report-window-closed-unreported";
}

export interface StatusReport {
  nowUnichain: bigint;
  nowArc: bigint;
  unichainBlock: bigint;
  epochs: EpochStatus[];
}

function journalStatus(journal: Journal, action: string, key: string): ActionStatus | "none" {
  return journal.get(SERVICE, action, key)?.status ?? "none";
}

export function classifyPhase(
  vault: EpochStatus["vault"],
  arc: EpochStatus["arc"],
  nowArc: bigint,
  currentUnichainBlock?: bigint,
): EpochStatus["phase"] {
  if (arc === null) {
    // A vault epoch that has already ended and was never mirrored can never
    // usefully be mirrored: its coverage period is entirely in the past, so
    // `openEpoch` would sell coverage for time nobody can stream through, and
    // the report window derived from that past `coverageEnd` is likely closed
    // already. `discovery.ts` refuses to open these (see `shouldMirrorEpoch`);
    // status has to agree with the tick, or it reports work that will never
    // happen and reads as a stuck service.
    const ended =
      vault.settled || (currentUnichainBlock !== undefined && currentUnichainBlock >= vault.endBlock);
    return ended ? "ended-never-mirrored" : "not-mirrored";
  }
  if (arc.reported) return "reported";
  if (nowArc > arc.reportDeadline) return "report-window-closed-unreported";
  if (!vault.settled) return "awaiting-endBlock";
  return "settled-awaiting-report";
}

export async function buildStatus(params: {
  unichainClient: PublicClient;
  arcClient: PublicClient;
  journal: Journal;
}): Promise<StatusReport> {
  const { unichainClient, arcClient, journal } = params;

  const [epochCount, unichainBlock, arcBlock] = await Promise.all([
    unichainClient.readContract({ address: SIGMA_VAULT, abi: sigmaVaultAbi, functionName: "epochCount" }),
    unichainClient.getBlock(),
    arcClient.getBlock(),
  ]);

  const epochs: EpochStatus[] = [];
  for (let id = 1n; id <= epochCount; id++) {
    const [vaultEpoch, arcEpoch] = await Promise.all([
      unichainClient.readContract({ address: SIGMA_VAULT, abi: sigmaVaultAbi, functionName: "epoch", args: [id] }),
      arcClient.readContract({ address: SIGMA_STREAM, abi: sigmaStreamAbi, functionName: "epoch", args: [id] }),
    ]);

    // `endBlock` is a solidity `uint48`; abitype resolves <= 48 bits to
    // `number`, not `bigint` -- widened here, same as discovery.ts.
    const vault = {
      endBlock: BigInt(vaultEpoch.endBlock),
      settled: vaultEpoch.settled,
      payoffWad: vaultEpoch.payoffWad,
    };
    const arc =
      arcEpoch.coverageEnd !== 0n
        ? {
            coverageEnd: arcEpoch.coverageEnd,
            reportDeadline: arcEpoch.reportDeadline,
            reported: arcEpoch.reported,
            payoffWad: arcEpoch.payoffWad,
          }
        : null;

    epochs.push({
      epochId: id,
      vault,
      arc,
      journal: {
        openEpoch: journalStatus(journal, "openEpoch", id.toString()),
        settle: journalStatus(journal, "settle", id.toString()),
        reportPayoff: journalStatus(journal, "reportPayoff", id.toString()),
      },
      secondsToReportDeadline: arc ? arc.reportDeadline - arcBlock.timestamp : null,
      phase: classifyPhase(vault, arc, arcBlock.timestamp, unichainBlock.number ?? undefined),
    });
  }

  return { nowUnichain: unichainBlock.timestamp, nowArc: arcBlock.timestamp, unichainBlock: unichainBlock.number, epochs };
}

function fmtSeconds(s: bigint): string {
  const abs = s < 0n ? -s : s;
  const d = abs / 86_400n;
  const h = (abs % 86_400n) / 3_600n;
  const m = (abs % 3_600n) / 60n;
  const body = d > 0n ? `${d}d ${h}h` : h > 0n ? `${h}h ${m}m` : `${abs}s`;
  return s < 0n ? `-${body}` : body;
}

export function formatStatus(report: StatusReport): string {
  const lines: string[] = [];
  lines.push(`Unichain now: block ${report.unichainBlock} (ts ${report.nowUnichain})`);
  lines.push(`Arc now:      ts ${report.nowArc}`);
  lines.push("");

  for (const e of report.epochs) {
    lines.push(`Epoch ${e.epochId} — ${e.phase}`);
    lines.push(
      `  vault:  endBlock=${e.vault.endBlock} settled=${e.vault.settled} payoffWad=${e.vault.payoffWad} (${(wadToRatio(e.vault.payoffWad) * 100).toFixed(4)}%)`,
    );
    if (e.arc) {
      lines.push(
        `  arc:    coverageEnd=${e.arc.coverageEnd} reportDeadline=${e.arc.reportDeadline} reported=${e.arc.reported} payoffWad=${e.arc.payoffWad}`,
      );
      lines.push(
        `  time to reportDeadline: ${fmtSeconds(e.secondsToReportDeadline ?? 0n)}${e.secondsToReportDeadline !== null && e.secondsToReportDeadline < 0n ? " (PASSED)" : ""}`,
      );
    } else {
      lines.push("  arc:    not mirrored yet");
    }
    lines.push(
      `  journal: openEpoch=${e.journal.openEpoch} settle=${e.journal.settle} reportPayoff=${e.journal.reportPayoff}`,
    );

    switch (e.phase) {
      case "not-mirrored":
        lines.push("  pending: mirror onto Arc (job 1a)");
        break;
      case "ended-never-mirrored":
        lines.push(
          "  pending: NOTHING -- this vault epoch ended before it was ever mirrored, so " +
            "opening it on Arc now would sell coverage for a period already over. Skipped " +
            "deliberately, not stuck.",
        );
        break;
      case "awaiting-endBlock":
        lines.push(`  pending: wait for Unichain block >= ${e.vault.endBlock}, then settle()`);
        break;
      case "settled-awaiting-report":
        lines.push("  pending: reportPayoff() on Arc");
        break;
      case "report-window-closed-unreported":
        lines.push("  pending: NOTHING -- terminal. Subscribers reclaim via reclaimUnreported.");
        break;
      case "reported":
        lines.push("  pending: nothing, fully settled and reported");
        break;
    }
    lines.push("");
  }

  return lines.join("\n");
}
