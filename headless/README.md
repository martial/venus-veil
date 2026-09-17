# Venus Veil, headless

Render a clip from the command line, with no display: the veil is rendered in
headless Chromium, the light is made by the diffusion service, and the frames
are encoded with ffmpeg. The same command runs on a Mac and on a Linux box with
an NVIDIA card, which is what makes a rented GPU worth using.

```
npm run build                       # the renderer serves the built app
npm run projector                   # the diffusion service (or let the container start it)
node headless/render.mjs --seconds 8 --engine best --out clip.mp4
```

`node headless/render.mjs --help` lists every option. The ones that matter:

| Option | What it does |
|---|---|
| `--seconds` `--fps` | clip length and frame rate of the file (8 s at 60 fps) |
| `--images-per-second` | how often a new image is generated; frames in between crossfade |
| `--engine` | `fast` (one step), `fine` (8 steps), `best` (18 steps) |
| `--width --height` | frame size, rounded to even numbers for H.264 |
| `--generated` | diffusion resolution: 256, 384, 512, or 768 on a server card |
| `--look` `--prompt` | which look, and an override for its prompt |
| `--sculpture <file>` | photo to weave into the veil (default: the bundled Willendorf) |
| `--orbit --hold` | camera travel in degrees, and how long it holds still first |
| `--frames <dir>` `--keep-frames` | keep the PNG sequence for grading |
| `--no-gpu` | software rendering: works anywhere, much slower |

The renderer writes a PNG per frame and then encodes them, rather than relying
on a browser video encoder. That keeps it working in headless Chromium, which
often ships without H.264, and leaves you a lossless sequence.

## On a GPU box (RunPod and similar)

```
docker build -f headless/Dockerfile -t venus-veil .
docker run --gpus all -v $PWD/out:/out venus-veil \
  --seconds 12 --fps 60 --images-per-second 12 --engine best --generated 768 \
  --width 2560 --height 1440 --out /out/clip.mp4
```

The image bakes in the weights (about 2.5 GB), so a container starts rendering
straight away. Point `HF_HOME` at a volume if you would rather cache them
outside the image.

What changes on such a machine: the one-step Core ML engine does not exist
outside macOS, so the service starts with `fine` and `best` only, running on
CUDA in fp16, and `768` becomes a sensible generated resolution. A 4090-class
card runs SD 1.5 at roughly 20 steps per second at 512, so `best` lands near a
second a frame instead of the 30 seconds this laptop needs — a 12 second clip at
12 images per second is about 2.5 minutes of work.

## Using it from your own browser, with the GPU on the pod

The interactive page can run in your laptop's browser while the generation happens on the pod.
Serve the built app and the diffusion service through one port, so there is no CORS and no mixed
content to fight:

```
python3 server/server.py &                                   # stays on the loopback
node headless/serve.mjs --port 5191 --token "$(openssl rand -hex 12)"
```

Expose port 5191 in the pod's settings, open the proxy URL RunPod gives you
(`https://<pod-id>-5191.proxy.runpod.net/?token=...`), and the page will talk to the GPU through
the same origin. It is the ordinary app: drop a photo, pick a look, watch it move, record a clip.

Two things to keep in mind. A proxy URL is public to anyone who has it, so pass `--token` and keep
it out of screenshots; without a token anyone with the link can drive your GPU. And every generated
frame crosses the internet, which adds roughly 50 to 150 ms per frame — fine for recording, and
still interactive at a few images a second.

If you would rather keep using the published page at martial.github.io, point **Projection ›
service** at the pod URL and start the service with
`VENUS_ALLOWED_ORIGINS=https://martial.github.io` so it accepts that origin.

## How it drives the page

`render.mjs` injects `headless/page-api.mjs` into the page and calls it frame by
frame, so the app itself carries no test hooks: everything goes through the
`window.__veil` handles the app already publishes. Each frame advances the cloth
by one frame's worth of time, asks for a generated image when one is due, renders,
and is screenshotted to disk. Nothing is timed by the wall clock, so a frame that
takes a minute is still 1/60 s in the file.
