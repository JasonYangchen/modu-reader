#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."
PORT="${PORT:-4173}"
URL="http://127.0.0.1:${PORT}/"

if command -v node >/dev/null 2>&1; then
  PORT="$PORT" node scripts/serve.cjs &
elif command -v python3 >/dev/null 2>&1; then
  python3 -m http.server "$PORT" --bind 127.0.0.1 &
elif command -v python >/dev/null 2>&1; then
  python -m http.server "$PORT" --bind 127.0.0.1 &
else
  echo "Node.js or Python is required." >&2
  exit 1
fi

SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' INT TERM EXIT
sleep 1

if command -v open >/dev/null 2>&1; then
  open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true
fi

echo "Modu Reader: $URL"
echo "Press Ctrl+C to stop."
wait "$SERVER_PID"
