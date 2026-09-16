"""Download the weights the multi-step recording engine needs (~2.5 GB, once)."""
from pathlib import Path

from huggingface_hub import snapshot_download

CACHE = Path(__file__).resolve().parents[1] / '.models' / 'hf-cache'

MODELS = [
    ('lllyasviel/control_v11f1p_sd15_depth', ['*.json', '*fp16.safetensors']),
    ('latent-consistency/lcm-lora-sdv1-5', ['*.json', 'pytorch_lora_weights.safetensors']),
    ('Lykon/dreamshaper-8', ['*.json', '*.txt', 'unet/*fp16.safetensors', 'vae/*fp16.safetensors',
                             'text_encoder/*fp16.safetensors', 'tokenizer/*', 'scheduler/*']),
]

if __name__ == '__main__':
    for repo, patterns in MODELS:
        print(f'{repo} -> {snapshot_download(repo, cache_dir=CACHE, allow_patterns=patterns)}', flush=True)
