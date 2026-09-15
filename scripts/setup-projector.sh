#!/bin/sh
# One-time setup for the local projector service (Apple Silicon).
set -e
cd "$(dirname "$0")/.."
if [ ! -x .venv-projector/bin/python ]; then
  uv venv --python 3.12 .venv-projector
fi
uv pip install --python .venv-projector/bin/python -r server/requirements.txt
if [ ! -f .models/coreml-sketch/metadata.json ]; then
  mkdir -p .models
  SIBLING=../veil-ribbon-lab/.models/coreml-sketch
  if [ -f "$SIBLING/unet-256.mlpackage/Manifest.json" ]; then
    echo "cloning compiled Core ML models (APFS copy-on-write, no extra disk)"
    cp -Rc "$SIBLING" .models/coreml-sketch
  else
    echo "compiling Core ML models (downloads ~5 GB of weights once)"
    .venv-projector/bin/python server/prepare_models.py --sizes 256
  fi
fi
echo "ready: npm run projector"
