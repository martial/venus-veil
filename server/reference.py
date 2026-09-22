"""The dropped photo as an image prompt (IP-Adapter), for the PyTorch engines.

The veil's depth stays cloth-only; the photo reaches the model through its
cross-attention instead, so a dropped sculpture changes what the light shows
without being painted into the shape. The photo is encoded once by CLIP and
each frame refers to it by id.

The live engine's UNet (SDXS) keeps only 6 of SD 1.5's 16 cross-attention
layers, so the SD 1.5 adapter is transplanted onto the matching ones, by
position and width. Measured on an RTX 5090: the figure takes the photo's body
and head, a coiled dragon brings coils; about 2 ms a frame. The 'plus' adapter
does not survive the transplant (the figure dissolves), so the base one is used.
"""
import hashlib
from collections import OrderedDict
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.models' / 'hf-cache'
REPO = 'h94/IP-Adapter'
WEIGHTS = 'models/ip-adapter_sd15.safetensors'
ENCODER = 'models/image_encoder'
# SDXS attn2 key -> SD 1.5 attn2 key (odd ids count every attention processor in
# registration order: down blocks, up blocks, mid). SD 1.5: down1.0=5 down2.0=9
# up1.0=13 up1.1=15 up2.0=19 up2.1=21, the same widths as SDXS's six layers.
SDXS_LAYERS = {1: 5, 3: 9, 5: 13, 7: 15, 9: 19, 11: 21}


def available():
    """True when the adapter and its image encoder are on disk."""
    folder = CACHE / f'models--{REPO.replace("/", "--")}' / 'snapshots'
    if not folder.exists():
        return False
    return any((s / WEIGHTS).exists() and (s / ENCODER / 'config.json').exists() for s in folder.iterdir())


def snapshot():
    from huggingface_hub import snapshot_download
    return Path(snapshot_download(REPO, allow_patterns=[WEIGHTS, f'{ENCODER}/*'], cache_dir=CACHE, local_files_only=True))


def attach_to_sdxs(unet):
    """Give the one-step UNet an image prompt: the SD 1.5 adapter on its six layers."""
    from safetensors.torch import load_file
    state = load_file(snapshot() / WEIGHTS)
    layers = {k[len('ip_adapter.'):]: v for k, v in state.items() if k.startswith('ip_adapter.')}
    projection = {k[len('image_proj.'):]: v for k, v in state.items() if k.startswith('image_proj.')}
    remapped = {f'{new}.{name}': layers[f'{old}.{name}']
                for new, old in SDXS_LAYERS.items() for name in ('to_k_ip.weight', 'to_v_ip.weight')}
    unet._load_ip_adapter_weights([{'image_proj': projection, 'ip_adapter': remapped}])


def set_scale(unet, scale):
    for processor in unet.attn_processors.values():
        if hasattr(processor, 'scale'):
            processor.scale = [float(scale)]


class ReferenceStore:
    """Photos by id: encoded once with CLIP ViT-H, kept for the frames that name them."""

    def __init__(self, device='cuda', keep=16):
        from transformers import CLIPImageProcessor, CLIPVisionModelWithProjection
        self.device = device
        self.encoder = CLIPVisionModelWithProjection.from_pretrained(
            snapshot() / ENCODER, torch_dtype=torch.float16).to(device).eval()
        self.processor = CLIPImageProcessor()
        self.keep = keep
        self.items = OrderedDict()

    def add(self, data):
        """Encoded bytes of a photo -> id. The same photo gets the same id."""
        import io
        from PIL import Image
        key = hashlib.sha1(data).hexdigest()[:16]
        if key in self.items:
            self.items.move_to_end(key)
            return key
        image = Image.open(io.BytesIO(data)).convert('RGB')
        with torch.inference_mode():
            pixels = self.processor(images=image, return_tensors='pt').pixel_values.to(self.device, torch.float16)
            self.items[key] = self.encoder(pixels).image_embeds[:, None]      # (1, 1, 1024)
        while len(self.items) > self.keep:
            self.items.popitem(last=False)
        return key

    def get(self, key):
        return self.items.get(key)
