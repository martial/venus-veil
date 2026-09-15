#!/bin/sh
set -e
cd "$(dirname "$0")/.."
if [ ! -x .venv-projector/bin/python ] || [ ! -f .models/coreml-sketch/metadata.json ]; then
  echo "projector not set up yet: npm run projector:setup"; exit 1
fi
exec .venv-projector/bin/python server/server.py
