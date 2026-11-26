# NTH Stroke

**An autonomous, human-inspired drawing engine.** NTH Stroke watches a reference image, plans like an artist, and draws it stroke by stroke — constructing, refining, shading, evaluating and correcting its own work — entirely in your browser. No server, no uploads, no precomputed artwork: every mark you see is laid down by a simulated hand through a physically modelled graphite engine.

```
OBSERVE → PLAN → DRAW → EVALUATE → CORRECT → REPEAT
```

- **Live site:** https://flexyfresh8-prog.github.io/nth-stroke/
- Engine version: **1.0.0** (complete architectural rewrite of v0.3.x)

## What makes it an artist, not a converter

| | v0.3 (old) | v1.0 (this) |
|---|---|---|
| Architecture | Replays a generated stroke list; "exact" mode copied reference pixels into the canvas | Closed-loop controller; every next stroke is planned from the **current canvas** |
| Canvas | Starts blank, but final art was precomputed | Starts blank and is never precomputed; ink only appears through executed strokes |
| Stages | Budget-fraction passes | True artistic workflow: construction → refinement → tonal blocking → shading → detailing → correction |
| Construction | Contour stamps | Loomis head scaffolding, Reilly gesture, perspective guides — really drawn, then cleaned up |
| Strokes | Alpha-blended ellipse stamps | Mass-conserving graphite deposition with paper tooth, tip wear, saturation, smudging |
| Motion | Cosmetic envelopes | Minimum-jerk trajectories, two-thirds power law, Fitts's-law travel, signal-dependent motor noise |
| Correction | None | Erase overshoot, soften harsh edges, erase + redraw misplaced contours — every correction logged with its reason |
| Interruption | Not supported | Draw or erase on the canvas mid-run; the engine observes your marks and adapts |
| Instruments | Style presets | 10 physical instruments: 2H/HB/2B/4B/6B pencils, mechanical pencil, charcoal, blending stump, kneaded + precision erasers |
| Evaluation | Pixel difference | Multiscale SSIM, tone error, edge alignment, contrast and structure error, ranked problem detection |

## Quick start

```bash
npm install
npm run dev            # http://localhost:3000
```

Import any image (portrait, anime, landscape, architecture, animal, object), press **Start**, and watch the engine draw. Pause anywhere, scrub nothing — there is nothing to scrub: what you see is being decided now.

Other commands:

```bash
npm test               # 43-test engine verification suite (headless, no browser)
npm run build:export   # static site into ./out (GitHub Pages layout)
```

## The instruments

Ten tools, each a distinct physical model — darkness, hardness, saturation ceiling, grain response, footprint shape, friction, wear, smear:

2H · HB · 2B · 4B · 6B pencils, mechanical pencil, charcoal, blending stump, kneaded eraser, precision eraser.

The engine chooses among them itself (hard pencils for light values and construction, soft graphite for deep shadow, charcoal for broad masses, the stump to blend smooth forms, erasers to correct mistakes). You can also take over at any time: select an instrument and draw on the canvas; the engine will observe and work around (or fix) your marks.

## Semantic analysis

Observation (stage A) combines:

- **Classical CV** (deterministic, always available): luminance, Sobel gradients, structure-tensor orientation field, Canny-style edges, center-surround saliency, tonal percentiles, light-direction estimation, superpixel region segmentation, contour chain extraction, texture energy.
- **Local vision models** (bundled, ~12 MB, run in-browser on your device): MediaPipe Face Landmarker (478 points → Loomis/Reilly construction), Pose Landmarker (gesture lines), DeepLab segmentation (subject/background separation). If models fail to load, the engine degrades gracefully to classical-only analysis.

## Exports

PNG · JPEG · WebP (canvas) · SVG (vector re-render of the recorded strokes, deduplicated) · `.nth` project (checkpoint + reference + full session log — reopen and continue) · session JSON (every stroke with its simulated pressure/velocity telemetry, corrections with reasons) · WebM timelapse.

All stylus trajectories are simulated engine data and are labelled as such — nothing is presented as human input.

## Determinism

Same reference + same seed + same engine version + same settings ⇒ the same drawing operation sequence. Changing the playback speed (0.25× … 50×, MAX) never changes drawing decisions; user interjections use a separate randomness stream so they cannot perturb the engine's own sequence.

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — how the engine works, module by module
- [VERIFICATION.md](./VERIFICATION.md) — measured results of the mandatory verification suite
- [DEPLOYMENT.md](./DEPLOYMENT.md) — building, static export, GitHub Pages

## Browser support

Optimized for Safari / iPadOS and modern desktop browsers (Chrome, Edge, Firefox). Requires Web Workers + OffscreenCanvas (Safari 16.4+, Chrome 69+, Firefox 105+). Touch and stylus input supported, including stylus pressure.
