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

## Controls

Drag to orbit, scroll to zoom, move the pointer through the veil to push it.
`Space` pause · `R` reset cloth · `S` save PNG · `H` hide UI. Drop or paste any PNG/JPEG/WebP.

Tuning tips: **Wind › turbulence / eddy size** make folds; **Cloth › softness / shear give**
make the sheet crumple more; **Surface › edge glow / back-light** are the organza look;
**Light › key / beam / exposure** set the mood; **Sculpture › relief / shape retention**
control how strongly the body holds its form against the wind.
