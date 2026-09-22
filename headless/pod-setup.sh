#!/bin/bash
# One-time setup on a RunPod GPU pod (any Ubuntu image with an NVIDIA GPU).
# Everything heavy goes to /workspace, which survives pod restarts.
#
#   curl -fsSL https://raw.githubusercontent.com/martial/venus-veil/main/headless/pod-setup.sh | bash
set -euo pipefail
REPO=${VENUS_REPO:-https://github.com/martial/venus-veil.git}
DIR=${VENUS_DIR:-/workspace/venus-veil}
VENV=${VENUS_VENV:-/workspace/venus-venv}
export HF_HOME=${HF_HOME:-/workspace/huggingface}
export DEBIAN_FRONTEND=noninteractive

say() { printf '\n\033[1m[venus] %s\033[0m\n' "$*"; }

say "system packages"
apt-get update -qq
# libegl1/libgles2: without the EGL loader, headless Chromium cannot reach the GPU
# and draws WebGL on the CPU, about 16 s a frame instead of a fraction of one
apt-get install -y -qq --no-install-recommends git curl ca-certificates ffmpeg openssl python3-venv python3-pip \
  libegl1 libgles2 libopengl0 >/dev/null
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

say "code"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone --depth 1 "$REPO" "$DIR"; fi
cd "$DIR"

say "python"
# a venv on /workspace that can still see the image's own torch, so a good one is reused
[ -x "$VENV/bin/python" ] || python3 -m venv --system-site-packages "$VENV"
PY="$VENV/bin/python"
"$PY" -m pip install -q --upgrade pip
# a torch that imports is not enough: an older build reports CUDA and then has no
# kernels for a newer card (RTX 50xx is sm_120 and needs CUDA 12.8). Run one.
torch_works() { "$PY" -c "import torch; x = torch.ones(8, device='cuda'); assert float((x * 2).sum()) == 16" 2>/dev/null; }
if ! torch_works; then
  CAP=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1 | cut -d. -f1)
  if [ "${CAP:-0}" -ge 10 ]; then INDEX=cu128; VERSION=2.7.1; else INDEX=cu124; VERSION=2.5.1; fi
  say "installing torch $VERSION ($INDEX) for compute capability $CAP"
  "$PY" -m pip install -q --index-url "https://download.pytorch.org/whl/$INDEX" "torch==$VERSION"
  torch_works || { echo "torch still cannot run on this GPU"; exit 1; }
fi
# keep whichever torch works; install everything else
grep -v '^torch' server/requirements-cuda.txt | grep -v '^#' | grep -v '^$' > /tmp/venus-requirements.txt
"$PY" -m pip install -q -r /tmp/venus-requirements.txt
"$PY" -c "import torch; print('torch', torch.__version__, '· cuda', torch.version.cuda, '·', torch.cuda.get_device_name(0))"

say "app"
npm ci --no-audit --no-fund
npm install --no-save --no-audit --no-fund playwright
npx playwright install --with-deps chromium
npm run build

say "weights (~2.5 GB, once)"
"$PY" server/fetch_quality.py

say "done — start it with: bash $DIR/headless/pod-start.sh"
