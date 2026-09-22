# Venus Veil, headless. Renders the veil in headless Chromium and makes the
# light with Stable Diffusion on the GPU. Built for a RunPod-style box.
#
#   docker build -f headless/Dockerfile -t venus-veil .
#   docker run --gpus all -v $PWD/out:/out venus-veil --seconds 8 --engine best --out /out/clip.mp4
FROM nvidia/cuda:12.8.1-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models/huggingface \
    OMP_NUM_THREADS=8 \
    MKL_NUM_THREADS=8 \
    NODE_MAJOR=22

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git ffmpeg python3 python3-pip python3-venv \
      libgl1 libglib2.0-0 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
      libpango-1.0-0 libcairo2 fonts-liberation \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# python side: torch from the CUDA wheel index, then the rest
COPY server/requirements-cuda.txt server/requirements-cuda.txt
RUN pip3 install --no-cache-dir --index-url https://download.pytorch.org/whl/cu128 torch==2.7.1 \
    && pip3 install --no-cache-dir -r server/requirements-cuda.txt

# node side: the app, its build, and Chromium for the headless renderer
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npx playwright install --with-deps chromium
COPY . .
RUN npm run build

# weights are baked in so a container starts rendering immediately
RUN python3 server/fetch_quality.py

ENTRYPOINT ["sh", "headless/entrypoint.sh"]
CMD ["--seconds", "8", "--engine", "best", "--out", "/out/venus-veil.mp4"]
