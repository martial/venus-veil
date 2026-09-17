#!/bin/sh
# Start the diffusion service, then render. Both stop when the render is done.
set -e
cd "$(dirname "$0")/.."
python3 server/server.py &
service=$!
trap 'kill $service 2>/dev/null || true' EXIT INT TERM
exec node headless/render.mjs "$@"
