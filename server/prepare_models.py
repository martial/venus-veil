"""Compile SDXS DreamShaper + sketch ControlNet + tiny VAE decoder to Core ML.

    .venv-projector/bin/python server/prepare_models.py --sizes 256

Downloads weights only (no remote code). Output: .models/coreml-sketch/.
Approach: https://github.com/IDKiro/sdxs and https://github.com/ochyai/streamdiffusion-mac
"""
import argparse
import gc
import json
import time
from pathlib import Path

import coremltools as ct
import numpy as np
import torch
from diffusers import AutoencoderTiny, ControlNetModel, EulerDiscreteScheduler, UNet2DConditionModel
from transformers import CLIPTextModel, CLIPTokenizer

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.models' / 'hf-cache'
DEST = ROOT / '.models' / 'coreml-sketch'
MODEL = 'IDKiro/sdxs-512-dreamshaper'
CONTROL = 'IDKiro/sdxs-512-dreamshaper-sketch'
torch.set_num_threads(4)


class GuidedDenoise(torch.nn.Module):
    def __init__(self, unet, control):
        super().__init__()
        self.unet, self.control = unet, control

    def forward(self, sample, timestep, text, structure):
        down, mid = self.control(sample, timestep, encoder_hidden_states=text, controlnet_cond=structure,
                                 conditioning_scale=1.15, return_dict=False)
        return self.unet(sample, timestep, encoder_hidden_states=text, down_block_additional_residuals=down,
                         mid_block_additional_residual=mid, return_dict=False)[0]


def convert(module, examples, names, output, path):
    if path.exists():
        print(f'already prepared: {path.name}', flush=True)
        return
    started = time.perf_counter()
    with torch.inference_mode():
        traced = torch.jit.trace(module.eval(), examples, check_trace=False)
    model = ct.convert(traced,
                       inputs=[ct.TensorType(name=n, shape=v.shape, dtype=np.float16) for n, v in zip(names, examples)],
                       outputs=[ct.TensorType(name=output, dtype=np.float16)],
                       compute_units=ct.ComputeUnit.CPU_AND_GPU, convert_to='mlprogram',
                       minimum_deployment_target=ct.target.macOS14, skip_model_load=True)
    model.save(str(path))
    print(f'prepared {path.name} in {time.perf_counter() - started:.1f} s', flush=True)
    del model, traced
    gc.collect()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--sizes', nargs='+', type=int, default=[256])
    args = parser.parse_args()
    DEST.mkdir(parents=True, exist_ok=True)
    load = dict(cache_dir=CACHE, use_safetensors=True)
    unet = UNet2DConditionModel.from_pretrained(MODEL, subfolder='unet', **load).eval().float()
    control = ControlNetModel.from_pretrained(CONTROL, cache_dir=CACHE, use_safetensors=False).eval().float()
    hidden = unet.config.cross_attention_dim
    guided = GuidedDenoise(unet, control)
    for size in args.sizes:
        examples = (torch.randn(1, 4, size // 8, size // 8), torch.tensor([999.]), torch.randn(1, 77, hidden),
                    torch.zeros(1, 3, size, size))
        convert(guided, examples, ['sample', 'timestep', 'text', 'structure'], 'noise', DEST / f'unet-{size}.mlpackage')
    del unet, control, guided
    gc.collect()
    vae = AutoencoderTiny.from_pretrained(MODEL, subfolder='vae', **load).eval().float()
    for size in args.sizes:
        convert(vae.decoder, (torch.zeros(1, 4, size // 8, size // 8),), ['latent'], 'image', DEST / f'decoder-{size}.mlpackage')
    del vae
    gc.collect()
    if not (DEST / 'text_encoder' / 'model.safetensors').exists():
        CLIPTokenizer.from_pretrained(MODEL, subfolder='tokenizer', cache_dir=CACHE).save_pretrained(DEST / 'tokenizer')
        CLIPTextModel.from_pretrained(MODEL, subfolder='text_encoder', **load).save_pretrained(DEST / 'text_encoder')
        EulerDiscreteScheduler.from_pretrained(MODEL, subfolder='scheduler', cache_dir=CACHE).save_pretrained(DEST / 'scheduler')
    (DEST / 'metadata.json').write_text(json.dumps({'model': MODEL, 'control': CONTROL, 'hidden': hidden}, indent=2))
    print(f'complete: {DEST}', flush=True)


if __name__ == '__main__':
    main()
