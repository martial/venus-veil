#!/bin/bash
# Reuse the pod's tested CUDA Torch; isolate newer model libraries.
# HF_HOME must match pod-start.sh so a login here also works after restart.
set -euo pipefail
cd "$(dirname "$0")/.."
export HF_HOME=${HF_HOME:-/workspace/huggingface}
BASE=${VENUS_VENV:-/workspace/venus-venv}
ADVANCED=${VENUS_ADVANCED_VENV:-/workspace/venus-advanced-venv}
"$BASE/bin/python" -m venv --system-site-packages --without-pip "$ADVANCED"
TASK_SITE=$("$ADVANCED/bin/python" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')
TASK_BASE=$("$BASE/bin/python" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')
printf '%s\n' "$TASK_BASE" > "$TASK_SITE/venus-shared.pth"
# Dependencies already exist in the main service. In particular, do not replace
# Torch with a CUDA release newer than the host driver supports.
"$ADVANCED/bin/python" -m pip install --no-deps --no-cache-dir -r server/requirements-advanced.txt
"$ADVANCED/bin/python" -c 'import torch; from diffusers import Flux2KleinPipeline, FluxControlPipeline, StableDiffusionXLControlNetPipeline; assert torch.cuda.is_available(), "CUDA unavailable"; print("Optional runtime ready:", torch.__version__)'
if [ "$#" -gt 0 ]; then
  "$BASE/bin/python" server/fetch_advanced.py "$@"
fi
