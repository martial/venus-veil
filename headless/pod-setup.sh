#!/bin/bash
# One-time setup on a RunPod GPU pod (any Ubuntu image with an NVIDIA GPU).
# Everything heavy goes to /workspace, which survives pod restarts.
#
#   curl -fsSL https://raw.githubusercontent.com/martial/venus-veil/main/headless/pod-setup.sh | bash
set -euo pipefail
REPO=${VENUS_REPO:-https://github.com/martial/venus-veil.git}
DIR=${VENUS_DIR:-/workspace/venus-veil}
export HF_HOME=${HF_HOME:-/workspace/huggingface}
export DEBIAN_FRONTEND=noninteractive

say() { printf '\n\033[1m[venus] %s\033[0m\n' "$*"; }

say "system packages"
apt-get update -qq
apt-get install -y -qq --no-install-recommends git curl ca-certificates ffmpeg openssl >/dev/null
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

say "code"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone --depth 1 "$REPO" "$DIR"; fi
cd "$DIR"

say "python"
if ! python3 -c "import torch, sys; sys.exit(0 if torch.cuda.is_available() else 1)" 2>/dev/null; then
  pip install -q --index-url https://download.pytorch.org/whl/cu124 torch==2.5.1
fi
# keep the image's own CUDA torch; install everything else
grep -v '^torch==' server/requirements-cuda.txt | grep -v '^#' | grep -v '^$' > /tmp/venus-requirements.txt
pip install -q -r /tmp/venus-requirements.txt
python3 -c "import torch; print('torch', torch.__version__, '· cuda', torch.cuda.is_available(), '·', torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')"

say "app"
npm ci --no-audit --no-fund
npm install --no-save --no-audit --no-fund playwright
npx playwright install --with-deps chromium
npm run build

say "weights (~2.5 GB, once)"
python3 server/fetch_quality.py

say "done — start it with: bash $DIR/headless/pod-start.sh"
