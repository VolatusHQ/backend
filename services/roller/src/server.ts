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
 *   - `WS /live`       `live.ts`'s feed, relayed to every connected browser.
 *     Attached to this same `http.Server` (not a second port) -- Render's
 *     free tier exposes exactly one port per web service, and `ws` upgrades
 *     an existing HTTP server rather than needing its own listener.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { MEASURED_POOL_ID } from "@volatus/onchain";
import type { HistoryStore } from "./history.js";
import type { TickSummary } from "./tick.js";
import type { Logger } from "./journalReconcile.js";
import type { LiveEvent } from "./live.js";

export interface ServerDeps {
  port: number;
  history: HistoryStore;
  logger: Logger;
  runTick: () => Promise<TickSummary>;
}

export interface ServerHandle {
  server: ReturnType<typeof createServer>;
  /** Fan out one `live.ts` event to every currently-connected browser. */
  broadcastLive(event: LiveEvent): void;
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

export function startServer(deps: ServerDeps): ServerHandle {
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

  // `path: "/live"` so this socket can't be confused with a plain HTTP GET
  // landing on `/` -- the browser dials `wss://.../live` explicitly.
  const wss = new WebSocketServer({ server, path: "/live" });
  const liveClients = new Set<WebSocket>();
  // The only event worth replaying to a client that connects mid-epoch --
  // trades and market ticks are transient by nature, but "which pool is this"
  // is state a brand-new socket needs immediately, not on the next poll.
  let lastEpochEvent: LiveEvent | null = null;

  wss.on("connection", (socket) => {
    liveClients.add(socket);
    logger.info("roller: live client connected", { clients: liveClients.size });
    if (lastEpochEvent) socket.send(JSON.stringify(lastEpochEvent));

    socket.on("close", () => {
      liveClients.delete(socket);
      logger.info("roller: live client disconnected", { clients: liveClients.size });
    });
    // A socket that errors still fires `close` right after in `ws` -- this
    // just stops it logging as an ordinary disconnect.
    socket.on("error", (err) => {
      logger.warn("roller: live client socket error", { err: err.message });
    });
  });

  function broadcastLive(event: LiveEvent): void {
    if (event.type === "epoch") lastEpochEvent = event;
    const payload = JSON.stringify(event);
    for (const socket of liveClients) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  server.listen(port, () => {
    logger.info(`roller: HTTP server listening on :${port}`, { port });
  });

  return { server, broadcastLive };
}
