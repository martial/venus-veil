"""The one-step engine in PyTorch, for a GPU server where Core ML does not exist.

The same models as generator.py (SDXS DreamShaper, its sketch ControlNet and the
tiny VAE decoder) take the same single step at t = 999 from the same noise, with
the same edges traced from depth. Live projection therefore looks the same on a
pod as on the Mac, and a server card makes a frame in tens of milliseconds.
"""
import gc
import time
from pathlib import Path

import numpy as np
import torch

from drift import DRIFT_STYLES

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.models' / 'hf-cache'
MODEL = 'IDKiro/sdxs-512-dreamshaper'
CONTROL = 'IDKiro/sdxs-512-dreamshaper-sketch'
CONDITIONING = 1.15          # as compiled into the Core ML model (prepare_models.py)
TIMESTEP = 999               # the step the model is distilled at


def available():
    """True when the weights are on disk (no download at request time)."""
    if not CACHE.exists():
        return False
    names = {p.name for p in CACHE.glob('models--*')}
    return {f'models--{m.replace("/", "--")}' for m in (MODEL, CONTROL)} <= names


def sketch_edges(gray, guidance=.85):
    """Silhouette and fold edges from depth in [0, 1], traced exactly as generator.py does."""
    padded = torch.nn.functional.pad(gray[None], (1, 1, 1, 1))[0]
    gx = (padded[1:-1, 2:] - padded[1:-1, :-2]).abs()
    gy = (padded[2:, 1:-1] - padded[:-2, 1:-1]).abs()
    return ((gx + gy) * 7 * (guidance / .85)).clamp(0, 1)


class TorchSketchGenerator:
    """Same shape as SketchGenerator: load_size(), sizes, warmup(), generate() -> (rgb, stages)."""

    def __init__(self, size=256, device='cuda'):
        from diffusers import AutoencoderTiny, ControlNetModel, EulerDiscreteScheduler, UNet2DConditionModel
        from transformers import CLIPTextModel, CLIPTokenizer
        self.device = device
        self.dtype = torch.float16
        load = dict(cache_dir=CACHE, torch_dtype=self.dtype)
        self.unet = UNet2DConditionModel.from_pretrained(MODEL, subfolder='unet', use_safetensors=True, **load)
        # the sketch ControlNet is only published as a .bin
        self.control = ControlNetModel.from_pretrained(CONTROL, use_safetensors=False, **load)
        self.decoder = AutoencoderTiny.from_pretrained(MODEL, subfolder='vae', use_safetensors=True, **load).decoder
        self.encoder = CLIPTextModel.from_pretrained(MODEL, subfolder='text_encoder', use_safetensors=True, **load)
        self.tokenizer = CLIPTokenizer.from_pretrained(MODEL, subfolder='tokenizer', cache_dir=CACHE)
        for module in (self.unet, self.control, self.decoder, self.encoder):
            module.to(device).eval()
        config = EulerDiscreteScheduler.from_pretrained(MODEL, subfolder='scheduler', cache_dir=CACHE).config
        betas = np.linspace(config['beta_start'] ** .5, config['beta_end'] ** .5,
                            config['num_train_timesteps'], dtype=np.float32) ** 2
        alpha = float(np.cumprod(1 - betas)[TIMESTEP])
        self.sqrt_a, self.sqrt_b = alpha ** .5, (1 - alpha) ** .5
        self.timestep = torch.tensor([TIMESTEP], device=device)
        self.loaded = {}             # the server clears this when it releases an engine
        self.size = size
        self.prompt = None
        self.seed = None
        self.drift_label = 'base prompt'

    @property
    def sizes(self):
        return [256, 384, 512]

    def load_size(self, size):
        if size != self.size:
            self.size = size
            self.seed = None         # new noise for the new latent size

    def encode_prompt(self, prompt):
        if prompt == self.prompt:
            return
        texts = [prompt] + [f'{style}. {prompt}' for _, style in DRIFT_STYLES]
        tokens = self.tokenizer(texts, padding='max_length', max_length=77, truncation=True, return_tensors='pt')
        with torch.inference_mode():
            self.bank = self.encoder(tokens.input_ids.to(self.device))[0]
        self.prompt = prompt

    def warmup(self, prompt):
        blank = np.zeros((self.size, self.size), dtype=np.uint8)
        blank[self.size // 4: -self.size // 4, self.size // 4: -self.size // 4] = 160
        self.generate(blank, prompt)

    def generate(self, depth, prompt, seed=42, guidance=.85, drift=0., drift_phase=0.):
        """depth: uint8 (size, size), 0 = empty, brighter = nearer. Returns (RGB uint8, stages)."""
        started = time.perf_counter()
        self.load_size(int(depth.shape[0]))
        self.encode_prompt(prompt)
        encoded = time.perf_counter()

        phase = drift_phase % len(DRIFT_STYLES)
        index = int(phase)
        blend = phase - index
        blend = blend * blend * (3 - 2 * blend)
        target = self.bank[index + 1] * (1 - blend) + self.bank[(index + 1) % len(DRIFT_STYLES) + 1] * blend
        text = self.bank[:1] * (1 - drift) + target[None] * drift
        self.drift_label = DRIFT_STYLES[index][0] if blend < .5 else DRIFT_STYLES[(index + 1) % len(DRIFT_STYLES)][0]
        if drift == 0:
            self.drift_label = 'base prompt'

        if seed != self.seed:
            # numpy's generator, as on the Mac: the same seed gives the same picture
            noise = np.random.default_rng(seed).standard_normal((1, 4, self.size // 8, self.size // 8), dtype=np.float32)
            self.noise = torch.from_numpy(noise).to(self.device)
            self.seed = seed

        with torch.inference_mode():
            gray = torch.from_numpy(depth).to(self.device).float() / 255
            structure = sketch_edges(gray, guidance)[None, None].expand(1, 3, -1, -1).to(self.dtype)
            sample = self.noise.to(self.dtype)
            prepared = time.perf_counter()
            down, mid = self.control(sample, self.timestep, encoder_hidden_states=text, controlnet_cond=structure,
                                     conditioning_scale=CONDITIONING, return_dict=False)
            prediction = self.unet(sample, self.timestep, encoder_hidden_states=text,
                                   down_block_additional_residuals=down, mid_block_additional_residual=mid,
                                   return_dict=False)[0]
            denoised = (self.noise - self.sqrt_b * prediction.float()) / self.sqrt_a
            torch.cuda.synchronize()
            unet_done = time.perf_counter()
            image = self.decoder(denoised.to(self.dtype))[0].float()
            if not torch.isfinite(image).all():
                raise RuntimeError('The model produced non-finite pixels')
            output = ((image + 1) * 127.5).clamp(0, 255).to(torch.uint8).permute(1, 2, 0).cpu().numpy()
        decoded_done = time.perf_counter()
        # projector aperture: no light outside the captured silhouette
        output[depth == 0] = 0
        done = time.perf_counter()
        stages = {
            'prompt_ms': round((encoded - started) * 1000, 1),
            'prepare_ms': round((prepared - encoded) * 1000, 1),
            'unet_ms': round((unet_done - prepared) * 1000, 1),
            'decode_ms': round((decoded_done - unet_done) * 1000, 1),
            'post_ms': round((done - decoded_done) * 1000, 1),
            'total_ms': round((done - started) * 1000, 1),
        }
        return output, stages

    def unload(self):
        self.unet = self.control = self.decoder = self.encoder = None
        gc.collect()
        torch.cuda.empty_cache()
