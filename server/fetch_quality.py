"""Download the weights for the PyTorch engines (~4 GB, once).

The multi-step recording engines, and the one-step live engine as a server runs it
(on a Mac the same one-step models are compiled to Core ML by prepare_models.py).
"""
from pathlib import Path

from huggingface_hub import snapshot_download

CACHE = Path(__file__).resolve().parents[1] / '.models' / 'hf-cache'

MODELS = [
    ('lllyasviel/control_v11f1p_sd15_depth', ['*.json', '*fp16.safetensors']),
    ('latent-consistency/lcm-lora-sdv1-5', ['*.json', 'pytorch_lora_weights.safetensors']),
    ('Lykon/dreamshaper-8', ['*.json', '*.txt', 'unet/*fp16.safetensors', 'vae/*fp16.safetensors',
                             'text_encoder/*fp16.safetensors', 'tokenizer/*', 'scheduler/*']),
    ('IDKiro/sdxs-512-dreamshaper', ['*.json', '*.txt', 'unet/*.safetensors', 'vae/*.safetensors',
                                     'text_encoder/*.safetensors', 'tokenizer/*', 'scheduler/*']),
    ('IDKiro/sdxs-512-dreamshaper-sketch', ['*.json', '*.bin']),
]

if __name__ == '__main__':
    for repo, patterns in MODELS:
        print(f'{repo} -> {snapshot_download(repo, cache_dir=CACHE, allow_patterns=patterns)}', flush=True)
