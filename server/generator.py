"""One-step, structure-guided image generation with fixed-size Core ML models.

SDXS DreamShaper + its sketch ControlNet + tiny VAE decoder, compiled by
server/prepare_models.py (or cloned from an existing compiled copy). The
ControlNet is sketch-trained, so the veil's silhouette and fold edges are
extracted from the captured depth rather than feeding depth directly.

Sources: https://github.com/IDKiro/sdxs · https://huggingface.co/IDKiro/sdxs-512-dreamshaper-sketch
"""
import gc
import json
import time
from pathlib import Path

import coremltools as ct
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / '.models' / 'coreml-sketch'

# Materials the prompt slowly wanders through. Each is blended with the base
# prompt's embedding, so the base description is always present.
DRIFT_STYLES = [
    ('ochre limestone', 'weathered oolitic limestone with red ochre traces, porous prehistoric carved stone'),
    ('mammoth ivory', 'polished mammoth ivory, warm cream tones, fine carved relief'),
    ('mother of pearl', 'iridescent mother of pearl, luminous shell, delicate carved relief'),
    ('smoky glass', 'translucent smoky glass, silver veins, ethereal inner light'),
]


class SketchGenerator:
    def __init__(self, size=256, compute_units='ALL', directory=MODELS):
        self.directory = Path(directory)
        if not (self.directory / 'metadata.json').exists():
            raise FileNotFoundError(f'No compiled models in {self.directory}. Run: npm run projector:setup')
        self.metadata = json.loads((self.directory / 'metadata.json').read_text())
        self.compute_units = getattr(ct.ComputeUnit, compute_units)
        self.size = None
        self.prompt = None
        self.seed = None
        self.drift_label = 'base prompt'
        scheduler = json.loads((self.directory / 'scheduler' / 'scheduler_config.json').read_text())
        betas = np.linspace(scheduler['beta_start'] ** .5, scheduler['beta_end'] ** .5,
                            scheduler['num_train_timesteps'], dtype=np.float32) ** 2
        self.alphas = np.cumprod(1 - betas)
        self.load_size(size)

    @property
    def sizes(self):
        return sorted(int(p.stem.split('-')[1]) for p in self.directory.glob('unet-*.mlpackage') if p.stem.split('-')[1].isdigit())

    def load_size(self, size):
        if size == self.size:
            return
        paths = {part: self.directory / f'{part}-{size}.mlpackage' for part in ('unet', 'decoder')}
        missing = [str(p.name) for p in paths.values() if not p.exists()]
        if missing:
            raise ValueError(f'Missing compiled models for {size}px: {", ".join(missing)}')
        self.models = {}
        gc.collect()
        self.models = {part: ct.models.MLModel(str(path), compute_units=self.compute_units) for part, path in paths.items()}
        self.size = size
        self.seed = None

    def encode_prompt(self, prompt):
        if prompt == self.prompt:
            return
        import torch
        from transformers import CLIPTokenizer, CLIPTextModel
        torch.set_num_threads(4)
        tokenizer = CLIPTokenizer.from_pretrained(self.directory / 'tokenizer', local_files_only=True)
        encoder = CLIPTextModel.from_pretrained(self.directory / 'text_encoder', local_files_only=True).eval()
        texts = [prompt] + [f'{style}. {prompt}' for _, style in DRIFT_STYLES]
        tokens = tokenizer(texts, padding='max_length', max_length=77, truncation=True, return_tensors='pt')
        with torch.inference_mode():
            self.bank = encoder(tokens.input_ids)[0].numpy().astype(np.float16)
        self.prompt = prompt
        # Shared memory is tight: keep only the embeddings while streaming.
        del encoder, tokenizer
        gc.collect()

    def warmup(self, prompt):
        self.encode_prompt(prompt)
        blank = np.zeros((self.size, self.size), dtype=np.uint8)
        blank[self.size // 4: -self.size // 4, self.size // 4: -self.size // 4] = 160
        self.generate(blank, prompt)

    def generate(self, depth, prompt, seed=42, guidance=.85, drift=0., drift_phase=0.):
        """depth: uint8 array (size×size), 0 = empty, brighter = nearer. Returns (RGB uint8 array, stages)."""
        started = time.perf_counter()
        if depth.shape != (self.size, self.size):
            self.load_size(depth.shape[0])
        self.encode_prompt(prompt)
        encoded = time.perf_counter()

        phase = drift_phase % len(DRIFT_STYLES)
        index = int(phase)
        blend = phase - index
        blend = blend * blend * (3 - 2 * blend)
        target = self.bank[index + 1] * (1 - blend) + self.bank[(index + 1) % len(DRIFT_STYLES) + 1] * blend
        embeddings = (self.bank[:1] * (1 - drift) + target[None] * drift).astype(np.float16)
        self.drift_label = DRIFT_STYLES[index][0] if blend < .5 else DRIFT_STYLES[(index + 1) % len(DRIFT_STYLES)][0]
        if drift == 0:
            self.drift_label = 'base prompt'

        if seed != self.seed:
            self.noise = np.random.default_rng(seed).standard_normal((1, 4, self.size // 8, self.size // 8), dtype=np.float32)
            self.seed = seed

        # Sketch guidance: silhouette + fold edges from depth (the released
        # ControlNet is sketch-trained). The model is distilled at t = 999.
        gray = depth.astype(np.float32) / 255
        padded = np.pad(gray, 1)
        gx = np.abs(padded[1:-1, 2:] - padded[1:-1, :-2])
        gy = np.abs(padded[2:, 1:-1] - padded[:-2, 1:-1])
        edges = np.clip((gx + gy) * 7 * (guidance / .85), 0, 1)
        timestep = 999
        sqrt_a = np.sqrt(self.alphas[timestep])
        sqrt_b = np.sqrt(1 - self.alphas[timestep])
        noisy = self.noise
        model_input = {
            'sample': noisy.astype(np.float16),
            'timestep': np.array([timestep], dtype=np.float16),
            'text': embeddings,
            'structure': np.repeat(edges[None, None], 3, axis=1).astype(np.float16),
        }
        prepared = time.perf_counter()
        prediction = self.models['unet'].predict(model_input)['noise']
        unet_done = time.perf_counter()
        denoised = (noisy - sqrt_b * np.asarray(prediction, dtype=np.float32)) / sqrt_a
        decoded = self.models['decoder'].predict({'latent': denoised.astype(np.float16)})['image']
        decoded_done = time.perf_counter()
        output = np.asarray(decoded, dtype=np.float32)[0].transpose(1, 2, 0)
        if not np.isfinite(output).all():
            raise RuntimeError('The model produced non-finite pixels')
        output = np.clip((output + 1) * 127.5, 0, 255).astype(np.uint8)
        # Projector aperture: no light outside the captured silhouette.
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


def encode_png(rgb):
    import io
    buffer = io.BytesIO()
    Image.fromarray(rgb).save(buffer, format='PNG', compress_level=1)
    return buffer.getvalue()
