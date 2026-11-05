#!/bin/bash
# fatcat-lsbridge entry point: the Bridge and the file API (fileapi/) as two
# processes of one container. If either exits, the script exits non-zero so the
# machine restarts ([[restart]] policy in fly.toml) instead of running half-up.
set -u
mkdir -p /app/data/vault /app/data/location_data /app/data/tmp /app/data/mcp-trash
rm -rf /deno-dir/location_data && ln -s /app/data/location_data /deno-dir/location_data

deno run --allow-read --allow-write=/app/data,/tmp --allow-env --allow-net fileapi/main.ts &
API=$!
deno task run &
BRIDGE=$!

trap 'kill -TERM "$API" "$BRIDGE" 2>/dev/null; wait' TERM INT
wait -n "$API" "$BRIDGE"
code=$?
echo "[start] a process exited (code $code); stopping the other so the machine restarts" >&2
kill -TERM "$API" "$BRIDGE" 2>/dev/null
wait
exit 1
