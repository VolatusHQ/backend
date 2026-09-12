#!/usr/bin/env bash
# Keeps the roller's Render free-tier dyno awake by hitting /tick on an
# interval. Render spins the process down after ~15 min with no inbound HTTP
# request -- that kills the in-process self-tick loop (ROLLER_SELF_TICK_INTERVAL_MS)
# with it, which is why the vol pool's 8-step reseed (mint/approve/mintPair/
# initialize/registerVolPool/seed liquidity -- see roll.ts) never gets enough
# retries in a row to finish before an epoch rolls again.
#
# Run this continuously (tmux, nohup, systemd -- anything that keeps it alive
# while your machine is on). It does not sign or send any transaction itself;
# it only pings the already-deployed roller, which holds ROLLER_PRIVATE_KEY
# and does the actual trading.
#
# Usage:
#   ./keep-warm.sh                              # default URL, 60s interval
#   ROLLER_URL=http://localhost:8787/tick ./keep-warm.sh   # point at a local roller
#   INTERVAL_SECONDS=300 ./keep-warm.sh

set -u

ROLLER_URL="${ROLLER_URL:-https://volatus-roller.onrender.com/tick}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-60}"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
}

log "keep-warm: pinging $ROLLER_URL every ${INTERVAL_SECONDS}s (Ctrl-C to stop)"

while true; do
  response="$(curl -sS -m 20 -w '\n%{http_code}' "$ROLLER_URL" 2>&1)"
  status="${response##*$'\n'}"
  body="${response%$'\n'*}"
  if [ "$status" = "202" ] || [ "$status" = "200" ]; then
    log "tick ok ($status): $body"
  else
    log "tick FAILED (status=$status): $body"
  fi
  sleep "$INTERVAL_SECONDS"
done
