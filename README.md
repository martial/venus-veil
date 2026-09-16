# Venus Veil

A translucent veil hovering in a dark studio, fluttering in wind. Drop a photo of a
prehistoric Venus figurine and the veil takes its shape: the depth map is estimated
in the browser, turned into a fabric texture, and used as a physics constraint so the
body is *felt* while the wind moves the cloth.

```
npm install
npm run dev        # http://127.0.0.1:5190
npm test           # solver / wind / texture math (node --test, no browser)
npm run build
```

Chrome with WebGPU is recommended (the depth model runs on the GPU in fp16). Without
WebGPU it falls back to WASM (q8), slower but identical results. The first run
downloads the model (~50 MB) once; the browser caches it.

## How it works

- `src/cloth/solver.js` — position-based cloth (XPBD compliance): stretch, shear and
  bending constraints, an implicit aerodynamic model (drag, skin drag, lift), a soft
  "hover" spring toward the rest shape, and, with a sculpture loaded, mask-weighted
  shape retention plus a one-sided relief collider so the cloth never sinks behind the body.
- `src/cloth/wind.js` — base flow × gust envelope + divergence-free curl-noise
  turbulence, evaluated on a lattice once per frame; pointer movement adds a local push.
- `src/render/veilMaterial.js` — `MeshPhysicalMaterial` with sheen and iridescence plus
  injected fresnel-driven opacity, thin-sheet back-light, and fold-density opacity.
- `src/render/studio.js` — low key spotlight with shadows, cool rim, softbox environment,
  raymarched volumetric beam, mirror floor with an additive lit pool.
- `src/pipeline/depth.worker.js` — Depth Anything V2 (small) via `@huggingface/transformers`.
- `src/pipeline/veilTexture.js` — photo → mask (luminance or depth, hole-filled), stone tint,
  density (alpha) map, detail normal map, and the relief grid for the solver.

## Frame rate

The studio measures its own frame time and holds the rate above **Performance › minimum fps**
(24 by default). It lowers resolution first, then steps down the volumetric beam, the floor
reflection, the shadow refresh and multisampling. The readout next to the fps counter shows the
current resolution when it is below 100%. Turn **hold frame rate** off to pin the settings by hand.

## Looks

Five presets set the whole studio at once: wind, cloth, surface, light, post and sculpture.
`?look=storm` opens straight into one.

| Look | What it is |
|---|---|
| Veil | sheer organza turning in quiet air (default) |
| Breath | barely moving air, long slow folds |
| Storm | hard wind, crisp snapping folds |
| Relic | the body holds its form under the cloth |
| Apparition | the diffusion result alone, cloth set free (needs the projector service) |

The panel shows a look, five essentials and the actions. **Expert controls** reveals the full
set: Wind, Cloth, Surface, Light, Sculpture, Projection and Performance.

## Controls

Drag to orbit, scroll to zoom, move the pointer through the veil to push it.
`Space` pause · `R` reset cloth · `S` save PNG · `H` hide UI. Drop or paste any PNG/JPEG/WebP.

Tuning tips: **Wind › turbulence / eddy size** make folds; **Cloth › softness / shear give**
make the sheet crumple more; **Surface › edge glow / back-light** are the organza look;
**Light › key / beam / exposure** set the mood; **Sculpture › relief / shape retention**
control how strongly the body holds its form against the wind.

## Live projection

The veil's depth, seen from a projector at your viewpoint, feeds a local one-step
diffusion model; the generated image comes back as light on the cloth, with fold
occlusion, and also plays on the round screen beside the veil.

```
npm run projector:setup   # once: Python env + Core ML models (Apple Silicon)
npm run projector         # service on 127.0.0.1:5193, ~30 s to load
```

Then open **Projection › live projection** in the panel, or `http://127.0.0.1:5190/?projector`.
The published page can use the same local service (Chrome may ask to allow local network access).

- **Model:** SDXS DreamShaper with its sketch ControlNet and tiny VAE, compiled to Core ML.
  The ControlNet is sketch-trained, so the veil's silhouette and fold edges are extracted
  from depth. With a sculpture loaded, its relief is part of that depth, so the body guides
  the image. Measured here: about 35 ms per frame on an M3 Pro, around 25 generated frames per second.
- **Modes:** *woven into fabric* keeps each image on the fabric points it was generated for,
  so the cloth runs at full frame rate while the light rides the folds. *Physical projector*
  keeps the image fixed in projector space and re-rasterises occlusion every frame.
  *Frame-locked pairs* advances the cloth 1/30 s per generated frame, so every pose is
  exactly the pose its image was made from.
- **Final image:** *diffusion only* (default) shows the generated result alone, floating in the
  studio; *fabric + light* keeps the lit veil and adds the projection on top.
- **What the model sees:** the capture is stretched over the veil's own near/far range and
  mixed with the sculpture's relief (**sculpture emphasis**), so the body — not just the sheet
  outline — guides generation, and it is turned upright first (**figure upright for model**),
  because the model reads a standing figure far better than a reclining one.
- **While projecting, the cloth flies free:** the relief still drives the image but holds the
  sheet only slightly (**sculpture in physics**, 0.25 by default; 0 removes it entirely).
- **Occlusion** is captured at 512 px and filtered over 3×3 taps, so fold shadows have soft
  edges instead of stepping along the projector's pixel grid; the model is fed a
  box-averaged 256 px copy of the same capture.
- **Every image is committed atomically** with its capture pose, projector matrix and depth
  buffer into one of two slots, which crossfade (**frame blend**).
- **Material wandering** blends the prompt through limestone, ivory, mother of pearl and
  smoky glass. **Calibration grid** checks placement and occlusion.
- `src/projection/rasterDepth.js` rasterises the veil's depth on the CPU (about 0.6 ms at
  256 px) to avoid a GPU readback stall; the request is binary (depth bytes in, raw RGBA out).
- Tests: `npm test` covers the rasteriser and protocol; `npm run test:server` covers the
  service's request parsing, CORS and private-network preflight without loading the model.

Adapted from the live projection study in the sibling `veil-ribbon-lab` project.
