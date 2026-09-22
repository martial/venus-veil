"""Replay the one-step tensor pipeline without hundreds of Python launches.

Each resolution owns a CUDA graph and reusable inputs. Text, image references,
strength, noise and depth remain inputs, so changing the photo or seed never
replays stale conditioning. Called under the service's inference lock.
"""
import torch


class LiveGraph:
    def __init__(self, engine):
        self.engine = engine
        self.graphs = {}
        self.hooks = []
        self.scale = torch.ones((), device=engine.device, dtype=engine.dtype)
        if engine.referencing:
            import reference
            reference.set_scale(engine.unet, 1.)
            # Attention is linear in V: scaling V has the same effect as scaling
            # the adapter output. Keeping that scalar on-device makes it a graph
            # input instead of a Python branch that would require recapturing.
            for processor in engine.unet.attn_processors.values():
                if hasattr(processor, 'to_v_ip'):
                    for layer in processor.to_v_ip:
                        self.hooks.append(layer.register_forward_hook(self._scale_value))

    def _scale_value(self, module, args, output):
        return output * self.scale

    def _capture(self, size):
        from fast_torch import sketch_edges, CONDITIONING
        g = self.engine
        inputs = {
            'depth': torch.full((size, size), 160, device=g.device, dtype=torch.uint8),
            'text': torch.zeros((1, 77, 768), device=g.device, dtype=g.dtype),
            'noise': torch.zeros((1, 4, size // 8, size // 8), device=g.device),
            'photo': torch.zeros((1, 1, 1024), device=g.device, dtype=g.dtype),
            'guidance': torch.tensor(.85, device=g.device),
        }

        def core():
            gray = inputs['depth'].float() / 255
            structure = sketch_edges(gray, inputs['guidance'])[None, None].expand(1, 3, -1, -1).to(g.dtype)
            sample = inputs['noise'].to(g.dtype)
            down, mid = g.control(sample, g.timestep, encoder_hidden_states=inputs['text'],
                                  controlnet_cond=structure, conditioning_scale=CONDITIONING, return_dict=False)
            extra = {'added_cond_kwargs': {'image_embeds': [inputs['photo']]}} if g.referencing else {}
            prediction = g.unet(sample, g.timestep, encoder_hidden_states=inputs['text'],
                                down_block_additional_residuals=down, mid_block_additional_residual=mid,
                                return_dict=False, **extra)[0]
            denoised = (inputs['noise'] - g.sqrt_b * prediction.float()) / g.sqrt_a
            image = g.decoder(denoised.to(g.dtype))[0].float()
            valid = torch.isfinite(image).all()
            rgb = ((image + 1) * 127.5).clamp(0, 255).to(torch.uint8).permute(1, 2, 0).contiguous()
            rgb.masked_fill_((inputs['depth'] == 0)[..., None], 0)
            return rgb, valid

        stream = torch.cuda.Stream()
        stream.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(stream):
            for _ in range(3):
                core()
        torch.cuda.current_stream().wait_stream(stream)
        graph = torch.cuda.CUDAGraph()
        with torch.cuda.graph(graph):
            output, valid = core()
        result = (graph, inputs, output, valid)
        self.graphs[size] = result
        return result

    @torch.inference_mode()
    def run(self, depth, text, noise, photo, strength, guidance):
        size = int(depth.shape[0])
        graph, inputs, output, valid = self.graphs.get(size) or self._capture(size)
        inputs['depth'].copy_(torch.from_numpy(depth.copy()))
        inputs['text'].copy_(text)
        inputs['noise'].copy_(noise)
        inputs['guidance'].fill_(guidance)
        if photo is None:
            inputs['photo'].zero_()
        else:
            inputs['photo'].copy_(photo)
        self.scale.fill_(strength if photo is not None else 0.)
        graph.replay()
        rgb = output.cpu().numpy()
        if not valid.item():
            raise RuntimeError('The model produced non-finite pixels')
        return rgb

    def close(self):
        for hook in self.hooks:
            hook.remove()
        self.hooks.clear()
        self.graphs.clear()
