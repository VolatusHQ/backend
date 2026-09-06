/**
 * The `status` command: a one-shot, human-readable report of what the keeper
 * is tracking and why it would or wouldn't sync each one right now. Always
 * read-only — `runKeeperTick` is called with `dryRun: true` regardless of the
 * `DRY_RUN` environment variable, because a status report is not the place a
 * transaction should ever be sent from.
 */

import { usdcToNumber, duration } from "@volatus/onchain";
import type { Address } from "viem";
import type { TickSummary } from "./tick.js";

export interface StatusReportOptions {
  walletAddress: Address;
  walletBalanceUsdc: number;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

export function formatStatusReport(summary: TickSummary, opts: StatusReportOptions): string {
  const lines: string[] = [];
  lines.push(`keeper status — as of unix ${summary.nowTs}`);
  lines.push(`wallet ${opts.walletAddress} — ${opts.walletBalanceUsdc.toFixed(6)} USDC (Arc gas is this balance)`);
  lines.push(
    `registry scan: blocks [${summary.discovery.scannedFrom}, ${summary.discovery.scannedTo}], ` +
      `${summary.discovery.newSubscriptions} newly discovered` +
      (summary.discovery.prunedBefore !== undefined
        ? `. Arc has pruned history before block ${summary.discovery.prunedBefore} — ` +
          `any subscription created earlier is invisible to log scanning and must be seeded manually.`
        : "."),
  );
  lines.push("");

  if (summary.results.length === 0) {
    lines.push("no tracked subscriptions.");
    return lines.join("\n");
  }

  const header = ["epoch", "subscriber", "lastSync", "elapsed", "accrued (USDC)", "runway", "due", "reason"];
  const widths = [6, 44, 12, 9, 16, 10, 5, 16];
  lines.push(header.map((h, i) => pad(h, widths[i]!)).join(" "));

  for (const r of summary.results) {
    if (r.error) {
      lines.push(`${pad(r.epochId.toString(), widths[0]!)} ${pad(r.subscriber, widths[1]!)} error: ${r.error}`);
      continue;
    }
    const row = [
      r.epochId.toString(),
      r.subscriber,
      r.lastSync.toString(),
      `${r.projected.elapsedSeconds}s`,
      usdcToNumber(r.projected.accruedPremium).toFixed(6),
      duration(r.projected.runwaySeconds),
      r.decision.due ? "yes" : "no",
      r.decision.reason + (r.decision.reason === "below-threshold" ? ` (${r.decision.coverageRatio.toFixed(2)}x gas)` : ""),
    ];
    lines.push(row.map((v, i) => pad(v, widths[i]!)).join(" "));
    if (r.dropReason) {
      lines.push(`  -> would drop from the registry: ${r.dropReason}`);
    }
    if (r.projected.ranDry) {
      lines.push(`  -> ran dry partway through the projected window (funded exhausted before now/coverageEnd)`);
    }
  }

  return lines.join("\n");
}
