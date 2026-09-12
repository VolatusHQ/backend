/**
 * The pingable HTTP surface. Plain `node:http` -- nothing else in this
 * codebase uses a web framework, and a tick is a handful of sequential
 * on-chain writes that can legitimately take longer than a naive pinger's
 * timeout, so the design here is deliberately fire-and-forget:
 *
 *   - `GET /healthz`   trivial 200, zero chain calls. Render's health check.
 *   - `GET /` and `GET /tick`   kick off a tick (guarded by `tickInFlight` so
 *     two overlapping pings cannot both start one) and respond immediately
 *     with 202 -- this is what keeps a free-tier Render web service warm.
 *   - `GET /status`    read-only JSON snapshot of the last tick's outcome.
 *   - `GET /vol-history?poolId=` Feature B's trailing-history source, CORS-open
 *     (it only leaks public on-chain-derived numbers, same posture as every
 *     other read in `frontend/app/app/lib/onchain/reads.ts`).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MEASURED_POOL_ID } from "@volatus/onchain";
import type { HistoryStore } from "./history.js";
import type { TickSummary } from "./tick.js";
import type { Logger } from "./journalReconcile.js";

export interface ServerDeps {
  port: number;
  history: HistoryStore;
  logger: Logger;
  runTick: () => Promise<TickSummary>;
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(jsonSafe(body));
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(payload);
}

export function startServer(deps: ServerDeps): ReturnType<typeof createServer> {
  const { port, history, logger, runTick } = deps;

  let tickInFlight = false;
  let lastSummary: TickSummary | null = null;
  let lastError: string | null = null;

  function fireTick(): void {
    if (tickInFlight) return;
    tickInFlight = true;
    runTick()
      .then((summary) => {
        lastSummary = summary;
        lastError = null;
      })
      .catch((err) => {
        lastError = err instanceof Error ? err.message : String(err);
        logger.error("roller: tick triggered by a ping failed", { err: lastError });
      })
      .finally(() => {
        tickInFlight = false;
      });
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    if (url.pathname === "/" || url.pathname === "/tick") {
      fireTick();
      sendJson(res, 202, { accepted: true, tickInFlight });
      return;
    }

    if (url.pathname === "/status") {
      sendJson(res, 200, { tickInFlight, lastSummary, lastError });
      return;
    }

    if (url.pathname === "/vol-history") {
      const poolId = (url.searchParams.get("poolId") ?? MEASURED_POOL_ID) as `0x${string}`;
      sendJson(res, 200, { poolId, samples: history.list(poolId) });
      return;
    }

    sendJson(res, 404, { error: `no such route: ${url.pathname}` });
  });

  server.listen(port, () => {
    logger.info(`roller: HTTP server listening on :${port}`, { port });
  });

  return server;
}
