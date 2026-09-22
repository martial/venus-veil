#!/bin/bash
# Start the diffusion service and the web page on a pod. Prints the address.
#   bash headless/pod-start.sh            # web page + service, token protected
#   VENUS_PORT=8888 bash headless/pod-start.sh
set -euo pipefail
DIR=${VENUS_DIR:-/workspace/venus-veil}
PORT=${VENUS_PORT:-5191}
LOGS=${VENUS_LOGS:-/workspace/venus-logs}
export HF_HOME=${HF_HOME:-/workspace/huggingface}
# the pod shows every host CPU but may use a dozen: keep the math libraries to that
export OMP_NUM_THREADS=${OMP_NUM_THREADS:-8} MKL_NUM_THREADS=${MKL_NUM_THREADS:-8}
cd "$DIR"
mkdir -p "$LOGS"

# one token per pod, kept so a restart keeps the same link
TOKEN_FILE=/workspace/venus-token
[ -s "$TOKEN_FILE" ] || openssl rand -hex 12 > "$TOKEN_FILE"
TOKEN=${VENUS_TOKEN:-$(cat "$TOKEN_FILE")}

pkill -f "server/server.py" 2>/dev/null || true
pkill -f "server/advanced_worker.py" 2>/dev/null || true
pkill -f "headless/serve.mjs" 2>/dev/null || true
sleep 1

nohup "${VENUS_VENV:-/workspace/venus-venv}/bin/python" server/server.py > "$LOGS/service.log" 2>&1 &
if [ -x "${VENUS_ADVANCED_VENV:-/workspace/venus-advanced-venv}/bin/python" ]; then
  nohup "${VENUS_ADVANCED_VENV:-/workspace/venus-advanced-venv}/bin/python" server/advanced_worker.py > "$LOGS/advanced.log" 2>&1 &
fi
nohup node headless/serve.mjs --port "$PORT" --token "$TOKEN" > "$LOGS/web.log" 2>&1 &

printf 'waiting for the diffusion service'
for _ in $(seq 1 120); do
  if curl -s -m 3 http://127.0.0.1:5193/health | grep -q '"status":"ready"'; then echo ' ready'; break; fi
  printf '.'; sleep 3
done

# an ssh session does not inherit the pod's environment; the container's first process has it
POD=${RUNPOD_POD_ID:-$(tr '\0' '\n' < /proc/1/environ 2>/dev/null | sed -n 's/^RUNPOD_POD_ID=//p')}
POD=${POD:-<pod-id>}
cat <<INFO

  web page   https://${POD}-${PORT}.proxy.runpod.net/?token=${TOKEN}
             (expose HTTP port ${PORT} in the pod settings if it is not listed)
  headless   cd $DIR && node headless/render.mjs --seconds 8 --engine best --out /workspace/clip.mp4
  logs       $LOGS/service.log · $LOGS/web.log
INFO
