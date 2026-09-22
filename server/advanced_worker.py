"""Optional CUDA pipelines, isolated from the latency-sensitive SDXS dependencies.

Only one optional pipeline is resident. The main service owns the GPU job lock;
this worker also serializes its private loopback API as a second line of defence.
"""
import base64
import gc
import io
import json
import os
import threading
import time

import numpy as np
import torch
from PIL import Image

from advanced_models import ENGINES, catalog, installed_paths


class AdvancedGenerator:
    def __init__(self):
        torch.set_num_threads(min(8, os.cpu_count() or 1))
        self.name = None
        self.pipe = None

    def load(self, name):
        if self.name == name and self.pipe is not None:
            return
        paths = installed_paths(name)  # fail before releasing the current model
        self.name = None
        self.pipe = None
        gc.collect()
        torch.cuda.empty_cache()
        if name == 'sdxl':
            from diffusers import (AutoencoderKL, ControlNetModel, DDIMScheduler,
                                   StableDiffusionXLControlNetPipeline)
            load = dict(torch_dtype=torch.float16, local_files_only=True, variant='fp16')
            control = ControlNetModel.from_pretrained(paths['diffusers/controlnet-depth-sdxl-1.0'], **load)
            vae = AutoencoderKL.from_pretrained(paths['madebyollin/sdxl-vae-fp16-fix'],
                                                torch_dtype=torch.float16, local_files_only=True)
            pipe = StableDiffusionXLControlNetPipeline.from_pretrained(
                paths['stabilityai/stable-diffusion-xl-base-1.0'], controlnet=control, vae=vae,
                add_watermarker=False, **load)
            pipe.load_lora_weights(paths['ByteDance/Hyper-SD'], weight_name='Hyper-SDXL-4steps-lora.safetensors')
            pipe.fuse_lora()
            pipe.unload_lora_weights()
            pipe.scheduler = DDIMScheduler.from_config(pipe.scheduler.config, timestep_spacing='trailing')
            pipe.load_ip_adapter(paths['h94/IP-Adapter'], subfolder='sdxl_models',
                                 weight_name='ip-adapter_sdxl_vit-h.safetensors', image_encoder_folder=None)
            pipe.to('cuda')
        elif name == 'klein':
            from diffusers import Flux2KleinPipeline
            pipe = Flux2KleinPipeline.from_pretrained(paths['black-forest-labs/FLUX.2-klein-4B'],
                                                     torch_dtype=torch.bfloat16, local_files_only=True)
            pipe.enable_model_cpu_offload()
        elif name == 'flux':
            from diffusers import FluxControlPipeline, FluxTransformer2DModel, BitsAndBytesConfig
            path = paths['black-forest-labs/FLUX.1-Depth-dev']
            transformer = FluxTransformer2DModel.from_pretrained(
                path, subfolder='transformer', torch_dtype=torch.bfloat16, local_files_only=True,
                quantization_config=BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4',
                                                       bnb_4bit_compute_dtype=torch.bfloat16))
            pipe = FluxControlPipeline.from_pretrained(path, transformer=transformer,
                                                       torch_dtype=torch.bfloat16, local_files_only=True)
            pipe.enable_model_cpu_offload()
        else:
            raise ValueError(f'Unknown model: {name}')
        pipe.set_progress_bar_config(disable=True)
        pipe.vae.enable_slicing()
        self.pipe, self.name = pipe, name

    @torch.inference_mode()
    def generate(self, frame, depth, embedding=None, photo=None):
        started = time.perf_counter()
        name = frame['engine']
        self.load(name)
        loaded = time.perf_counter()
        # These models were trained at larger image sizes. Generate detail there,
        # then downsample to the projector's requested texture size.
        size = frame.get('render_size') or 768
        if size not in (512, 768, 1024):
            raise ValueError('Model resolution must be 512, 768 or 1024.')
        control = Image.fromarray(depth).convert('RGB').resize((size, size), Image.Resampling.BICUBIC)
        steps = frame.get('steps') or ENGINES[name]['steps']
        args = dict(prompt=frame['prompt'], height=size, width=size, num_inference_steps=steps,
                    generator=torch.Generator(device='cpu').manual_seed(frame.get('seed', 42)))
        if name == 'sdxl':
            cfg = frame.get('cfg') if frame.get('cfg') is not None else 0.
            scale = frame.get('reference_scale', 1.) if embedding is not None else 0.
            self.pipe.set_ip_adapter_scale(scale)
            embeds = (torch.from_numpy(embedding.copy()).to('cuda', torch.float16) if embedding is not None
                      else torch.zeros(1, 1, 1024, device='cuda', dtype=torch.float16))
            if cfg > 1:
                embeds = torch.cat([torch.zeros_like(embeds), embeds])
            args.update(image=control, guidance_scale=cfg, ip_adapter_image_embeds=[embeds],
                        negative_prompt=frame.get('negative'),
                        controlnet_conditioning_scale=frame.get('cn_scale') or .7,
                        control_guidance_end=.85)
        elif name == 'klein':
            # Klein has native image editing, not a dedicated depth ControlNet.
            # Keep that distinction visible in the model picker.
            args['image'] = [control]
            subject = ''
            if photo is not None and frame.get('reference_scale', 1.) > 0:
                args['image'].append(photo)
                subject = ' Use the subject, appearance and fine details from image 2.'
            args['prompt'] = ('Image 1 is a depth map: preserve its exact silhouette, surface relief and folds. '
                              'Render it as a detailed photograph with directional lighting and deep shadows.'
                              + subject + ' ' + frame['prompt'])
            args['guidance_scale'] = 1.
        else:
            args.update(control_image=control, guidance_scale=frame.get('cfg') if frame.get('cfg') is not None else 10.)
        result = self.pipe(**args).images[0].convert('RGB')
        result = result.resize((depth.shape[1], depth.shape[0]), Image.Resampling.LANCZOS)
        output = np.array(result)
        output[depth == 0] = 0
        torch.cuda.synchronize()
        ended = time.perf_counter()
        return output, {'total_ms': round((ended - started) * 1000, 1),
                        'load_ms': round((loaded - started) * 1000, 1),
                        'sample_ms': round((ended - loaded) * 1000, 1),
                        'steps': steps, 'render_size': size}


def create_app():
    from fastapi import FastAPI, Request
    from fastapi.responses import Response
    from starlette.concurrency import run_in_threadpool
    app = FastAPI()
    generator = AdvancedGenerator()
    lock = threading.Lock()

    @app.get('/health')
    def health():
        return {'status': 'ready', 'models': catalog(), 'loaded': generator.name}

    @app.post('/generate')
    async def generate(request: Request):
        body = await request.json()
        def work():
            with lock:
                frame = body['frame']
                size = int(frame['size'])
                depth = np.frombuffer(base64.b64decode(body['depth']), dtype=np.uint8).reshape(size, size)
                embedding = (np.frombuffer(base64.b64decode(body['embedding']), dtype=np.float16).reshape(1, 1, 1024)
                             if body.get('embedding') else None)
                photo = Image.open(io.BytesIO(base64.b64decode(body['photo']))).convert('RGB') if body.get('photo') else None
                rgb, stages = generator.generate(frame, depth, embedding, photo)
                buffer = io.BytesIO()
                Image.fromarray(rgb).save(buffer, format='PNG')
                return buffer.getvalue(), stages
        try:
            payload, stages = await run_in_threadpool(work)
            return Response(payload, media_type='image/png', headers={'X-Stages': json.dumps(stages)})
        except Exception as error:
            import traceback
            traceback.print_exc()
            return Response(str(error), status_code=503)
    return app


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(create_app(), host='127.0.0.1', port=int(os.environ.get('VENUS_ADVANCED_PORT', '5194')),
                log_level='warning', access_log=False)
