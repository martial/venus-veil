"""Multi-step, depth-conditioned generation for recordings.

Stable Diffusion 1.5 (DreamShaper 8) with a depth-trained ControlNet, run on
Metal through diffusers. Slower than the one-step Core ML engine in
generator.py — seconds rather than milliseconds — and much better: real
sampling, classifier-free guidance with a negative prompt, and the veil's depth
used directly instead of edges traced from it.

Two presets:
    fine   LCM-LoRA, 6-8 steps, low guidance
    best   DPM++ 2M Karras, ~25 steps, full guidance

Frames carry: each one starts from the previous generated image, so the
material and the light persist while the folds change.
"""
import gc
import math
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.models' / 'hf-cache'
BASE = 'Lykon/dreamshaper-8'
CONTROLNET = 'lllyasviel/control_v11f1p_sd15_depth'
LCM_LORA = 'latent-consistency/lcm-lora-sdv1-5'

NEGATIVE = ('blurry, low quality, jpeg artifacts, text, watermark, signature, frame, border, '
            'flat, washed out, duplicated limbs, deformed hands, cartoon')

# cfg exactly 1.0 means no classifier-free guidance, so the batch stays at one
# and the frame costs half as much. Lower guidance also flickers less.
PRESETS = {
    'fine': {'steps': 8, 'cfg': 1.0, 'scheduler': 'lcm', 'carry': 0.45, 'cn_scale': 0.7, 'cn_end': 0.8},
    'best': {'steps': 18, 'cfg': 4.0, 'scheduler': 'dpm', 'carry': 0.45, 'cn_scale': 0.65, 'cn_end': 0.75},
}


def pick_device():
    if torch.cuda.is_available():
        return 'cuda'
    if torch.backends.mps.is_available():
        return 'mps'
    return 'cpu'


def available():
    """True when the weights are on disk (no download at request time)."""
    if not CACHE.exists():
        return False
    names = {p.name for p in CACHE.glob('models--*')}
    needed = {f'models--{m.replace("/", "--")}' for m in (BASE, CONTROLNET)}
    return needed <= names


class TorchDepthGenerator:
    """Same shape as SketchGenerator: load_size(), generate() -> (rgb, stages)."""

    def __init__(self, preset='best', size=512, device=None):
        self.device = device or pick_device()
        self.dtype = torch.float16 if self.device in ('cuda', 'mps') else torch.float32
        self.preset = None
        self.size = size
        self.prompt = None
        self.previous = None        # last generated image, for carry
        self.drift_label = 'base prompt'
        self._build()
        self.set_preset(preset)

    def _build(self):
        from diffusers import ControlNetModel, StableDiffusionControlNetImg2ImgPipeline
        load = dict(cache_dir=CACHE, torch_dtype=self.dtype, use_safetensors=True, variant='fp16')
        controlnet = ControlNetModel.from_pretrained(CONTROLNET, **load)
        self.pipe = StableDiffusionControlNetImg2ImgPipeline.from_pretrained(
            BASE, controlnet=controlnet, safety_checker=None, feature_extractor=None,
            requires_safety_checker=False, **load)
        self.pipe.to(self.device)
        self.pipe.set_progress_bar_config(disable=True)
        # Attention slicing produces NaN on the torch 2.5.1 / MPS / fp16 stack —
        # measured, every pixel comes back black — so only the VAE is sliced there.
        # On CUDA there is memory to spare and slicing only costs speed.
        if self.device != 'cuda':
            self.pipe.enable_vae_slicing()
        self.lcm_loaded = False

    def set_preset(self, preset):
        if preset == self.preset:
            return
        config = PRESETS.get(preset) or PRESETS['best']
        from diffusers import DPMSolverMultistepScheduler, LCMScheduler
        if config['scheduler'] == 'lcm':
            if not self.lcm_loaded:
                self.pipe.load_lora_weights(LCM_LORA, cache_dir=CACHE, adapter_name='lcm')
                self.lcm_loaded = True
            self.pipe.set_adapters(['lcm'], adapter_weights=[1.0])
            self.pipe.scheduler = LCMScheduler.from_config(self.pipe.scheduler.config)
        else:
            if self.lcm_loaded:
                self.pipe.disable_lora()
            self.pipe.scheduler = DPMSolverMultistepScheduler.from_config(
                self.pipe.scheduler.config, use_karras_sigmas=True, algorithm_type='dpmsolver++')
        self.preset = preset
        self.defaults = config

    def load_size(self, size):
        # the pipeline takes any multiple of 8; nothing to reload
        self.size = size

    @property
    def sizes(self):
        # 768 needs about 6 GB of activations on top of the weights: fine on a
        # server card, not on a laptop sharing memory with a browser
        return [384, 512, 768] if self.device == 'cuda' else [384, 512]

    def reset_carry(self):
        self.previous = None

    def warmup(self, prompt):
        blank = np.zeros((self.size, self.size), dtype=np.uint8)
        blank[self.size // 4: -self.size // 4, self.size // 4: -self.size // 4] = 180
        self.generate(blank, prompt, steps=4, carry=0)
        self.reset_carry()

    def generate(self, depth, prompt, seed=42, guidance=None, drift=0., drift_phase=0.,
                 steps=None, cfg=None, carry=None, negative=None, cn_scale=None, cn_end=None):
        """depth: uint8 (size, size), 0 = empty, brighter = nearer."""
        started = time.perf_counter()
        size = int(depth.shape[0])
        if size % 8:
            raise ValueError('size must be a multiple of 8')
        self.load_size(size)
        steps = int(steps or self.defaults['steps'])
        cfg = float(self.defaults['cfg'] if cfg is None else cfg)
        carry = float(self.defaults['carry'] if carry is None else carry)
        # how tightly the depth holds the image, and when it lets go so the model
        # can invent material of its own
        conditioning = max(0.2, min(1.6, float(self.defaults['cn_scale'] if cn_scale is None else cn_scale)))
        end = max(0.2, min(1.0, float(self.defaults['cn_end'] if cn_end is None else cn_end)))

        control = Image.fromarray(np.repeat(depth[:, :, None], 3, axis=2), mode='RGB')
        if self.previous is not None and carry > 0 and self.previous.size == control.size:
            init, strength = self.previous, max(0.05, min(1.0, 1.0 - carry))
        else:
            # first frame: start from the depth itself, fully renoised
            init, strength = control, 1.0
        # img2img runs int(steps * strength) of them, so ask for enough that every
        # frame really takes the number of steps requested
        requested = max(1, math.ceil(steps / strength))
        prepared = time.perf_counter()

        generator = torch.Generator(device='cpu').manual_seed(int(seed))
        with torch.inference_mode():
            result = self.pipe(
                prompt=prompt,
                negative_prompt=negative or NEGATIVE,
                image=init,
                control_image=control,
                strength=strength,
                num_inference_steps=requested,
                guidance_scale=cfg,
                controlnet_conditioning_scale=conditioning,
                control_guidance_end=end,
                generator=generator,
                output_type='np',
            ).images[0]
        sampled = time.perf_counter()

        # check the floats: once they are bytes, a NaN looks exactly like black
        if not np.isfinite(result).all():
            raise RuntimeError('the model produced non-finite pixels (fp16 overflow)')
        output = np.clip(result * 255, 0, 255).astype(np.uint8)
        if output.max() == 0:
            raise RuntimeError('the model produced an empty frame')
        # carry the unmasked image: masking first would feed black into the next
        # frame wherever the silhouette moved, dragging a dark trail behind it
        self.previous = Image.fromarray(output.copy())
        # projector aperture: no light outside the captured silhouette
        output[depth == 0] = 0
        done = time.perf_counter()
        if self.device == 'cuda':
            torch.cuda.synchronize()
        stages = {
            'prepare_ms': round((prepared - started) * 1000, 1),
            'sample_ms': round((sampled - prepared) * 1000, 1),
            'post_ms': round((done - sampled) * 1000, 1),
            'total_ms': round((done - started) * 1000, 1),
            'steps': steps,
            'ran': int(requested * strength),
            'strength': round(strength, 3),
            'cfg': cfg,
        }
        self.drift_label = f'{self.preset} · {steps} steps'
        return output, stages

    def unload(self):
        self.pipe = None
        gc.collect()
        if self.device == 'mps':
            torch.mps.empty_cache()
        elif self.device == 'cuda':
            torch.cuda.empty_cache()
