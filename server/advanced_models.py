"""Optional image engines, installed independently from the low-latency service."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.models' / 'advanced'
ENGINES = {
    'sdxl': {'label': 'SDXL Hyper · depth', 'steps': 4, 'seconds': 2, 'conditioning': 'depth + photo',
             'repos': [
                 ('stabilityai/stable-diffusion-xl-base-1.0', ['*.json', 'tokenizer*/*', 'text_encoder*/model.fp16.safetensors', 'unet/*fp16.safetensors']),
                 ('diffusers/controlnet-depth-sdxl-1.0', ['config.json', '*fp16.safetensors']),
                 ('madebyollin/sdxl-vae-fp16-fix', ['config.json', 'diffusion_pytorch_model.safetensors']),
                 ('ByteDance/Hyper-SD', ['Hyper-SDXL-4steps-lora.safetensors']),
                 ('h94/IP-Adapter', ['sdxl_models/ip-adapter_sdxl_vit-h.safetensors']),
             ]},
    'klein': {'label': 'FLUX.2 Klein · reference editing', 'steps': 4, 'seconds': 3,
              'conditioning': 'depth image + photo references (experimental)',
              'repos': [('black-forest-labs/FLUX.2-klein-4B', ['*.json', 'tokenizer/*', 'text_encoder/*', 'transformer/*', 'vae/*'])]},
    'flux': {'label': 'FLUX.1 Depth · detailed', 'steps': 20, 'seconds': 15, 'conditioning': 'depth + text',
             'repos': [('black-forest-labs/FLUX.1-Depth-dev', ['*.json', 'tokenizer*/*', 'text_encoder*/*', 'transformer/*', 'vae/*'])]},
}


def catalog():
    result = {}
    for name, spec in ENGINES.items():
        marker = CACHE / f'{name}.ready.json'
        result[name] = {key: value for key, value in spec.items() if key != 'repos'}
        result[name]['available'] = marker.exists()
        if not marker.exists():
            result[name]['reason'] = 'Model weights are not installed on this pod.'
    return result


def installed_paths(name):
    marker = CACHE / f'{name}.ready.json'
    if not marker.exists():
        raise RuntimeError(f'{ENGINES[name]["label"]} is not installed. Run server/fetch_advanced.py {name}.')
    return json.loads(marker.read_text())
