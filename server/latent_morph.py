"""Deterministic, eased travel through diffusion noise, independent of request order."""
import math

import torch


def slerp(a, b, fraction):
    if fraction <= 0:
        return a
    if fraction >= 1:
        return b
    # Interpolate directions in float32 so small frame-to-frame changes survive
    # bf16 sampling. Linear noise mixing alone reduces variance at the midpoint.
    a, b = a.float(), b.float()
    norm_a, norm_b = a.norm(), b.norm()
    cosine = torch.sum(a * b) / (norm_a * norm_b).clamp_min(1e-12)
    cosine = float(cosine.clamp(-1, 1))
    if cosine > 0.9995:
        return a.lerp(b, fraction)
    angle = math.acos(cosine)
    sine = max(1e-8, math.sin(angle))
    return (math.sin((1 - fraction) * angle) * a + math.sin(fraction * angle) * b) / sine


def morph_noise(base, seed, phase, amount):
    """Stay near the original seed; amount=1 explores the full seeded path.

    No mutable RNG or previous frame is shared between browsers. Quintic easing
    has zero first and second derivatives at each waypoint, avoiding jumps when
    a new pair of seeds takes over. The base is a CPU noise tensor.
    """
    if not math.isfinite(phase) or not math.isfinite(amount):
        raise ValueError('Morph phase and amount must be finite')
    phase, amount = max(0., phase), max(0., min(1., amount))
    if amount == 0 or phase == 0:
        return base
    segment = math.floor(phase)
    fraction = phase - segment
    eased = fraction ** 3 * (fraction * (6 * fraction - 15) + 10)

    def anchor(index):
        if index == 0:
            return base
        generator = torch.Generator(device='cpu').manual_seed((int(seed) + index * 0x9E3779B1) & 0xFFFFFFFF)
        return torch.randn(base.shape, generator=generator, dtype=base.dtype)

    path = slerp(anchor(segment), anchor(segment + 1), eased)
    return slerp(base, path, amount).to(dtype=base.dtype)


def flux_morph_latents(pipe, engine, size, generator, phase, amount):
    """Match the pinned Diffusers pipelines' different latent input layouts."""
    channels = pipe.transformer.config.in_channels // (4 if engine == 'klein' else 8)
    side = 2 * (size // (pipe.vae_scale_factor * 2))
    if engine == 'klein':
        # Klein accepts BCHW and packs it inside prepare_latents. Consuming the
        # normal noise here keeps reference-VAE sampling on the same RNG stream.
        shape = (1, channels * 4, side // 2, side // 2)
        noise_generator = generator
    else:
        shape = (1, channels, side, side)
        # Depth encodes its control image before preparing noise. Leave that
        # generator untouched so changing morph phase never changes the control.
        noise_generator = torch.Generator(device='cpu').manual_seed(generator.initial_seed())
    base = torch.randn(shape, generator=noise_generator, dtype=pipe.transformer.dtype)
    noise = morph_noise(base, generator.initial_seed(), phase, amount)
    if engine == 'flux':
        # Flux.1 Depth accepts already-packed BNC noise.
        noise = pipe._pack_latents(noise, 1, channels, side, side)
    return noise.to(device=pipe._execution_device, dtype=pipe.transformer.dtype)
