# V4 · Autonomous Virtual Pen Artist

V4 is not another vectorization engine. It is an **autonomous artist physically controlling a virtual pen**: a Virtual Eye observes the reference, a Virtual Brain decides what to do next, a Virtual Hand plans biomechanical movements, and a Virtual Pen — the only drawing instrument — deposits material through simulated contact. The canvas is nothing but the consequence of those decisions. V1, V2 and V3 remain available in the engine selector; V4 is the default.

```
 Virtual Eye ──observations──▶ Virtual Brain ──stroke plans──▶ Virtual Hand
      ▲                        (stages A–H, memory,       (motor control, pursuit)
      │                         travel optimisation)             │ pen commands
      │                                  ▲                        ▼
 Visual Feedback ◀──canvas state── Virtual Canvas ◀──deposits─── Virtual Pen
 (SSIM, edges, tone               (graphite density +      (position, z-height,
  deficits, problems)              ink coverage, tiles)     pressure, velocity)
```

## Six components

| Component | File | Responsibility |
| --- | --- | --- |
| Virtual Eye | `src/engine/pen/eye.ts` | Classical multiscale analysis: subject isolation (region-graph segmentation shared with V3), PCA axes, symmetry sweep, saliency/attention, level-set contours + hysteresis edge chains, distance transform, medial skeleton with radii, structure-tensor orientation field, light-direction estimate, eight cumulative tonal zones with connected components. |
| Virtual Brain | `src/engine/pen/brain.ts` | Hierarchical planner: stage machine A–H, per-stage task queues, closed-loop shading (measure → hatch → re-measure), correction planning from ranked problems, pressure adaptation, scaffold erasure, decision log with mathematical justification. |
| Virtual Hand | `src/engine/pen/hand.ts` | Motor execution: minimum-jerk travel with Fitts timing, settle-and-correct hops, pure-pursuit path following with lookahead, sigma-lognormal speed shaping, two-thirds power-law curvature slowdown, corrective submovements, stall watchdog. |
| Virtual Pen | `src/engine/pen/pen.ts` | The physical object: x/y position, z height, contact, pressure, velocity, acceleration, direction, tilt, azimuth, nib, instrument. Acceleration- and speed-limited integration; finite nib lift/touch speed; first-order pressure lag. Contains no drawing intelligence. |
| Virtual Canvas | `src/engine/pen/paper.ts` | Material only: graphite density (Beer–Lambert, layered passes), ink coverage (saturating), eraser removal, deterministic paper grain, 64-px dirty tiles, stroke registry of deposited trajectories. |
| Visual Feedback | `src/engine/pen/feedback.ts` | 26×26 cell error grid (refreshed per stroke box), shared multiscale SSIM/MAE/edge metric, missing/excess classification with textured-media deadbands, ranked problem rectangles. |

## The simulation loop (spec §4)

`Simulation.step()` runs at a fixed 120/180/240 Hz (configurable, deterministic) — decoupled from display. Each step:

1. **Brain** pumps work when the hand and its queue are free.
2. **Hand** issues commands (`moveTo`, `penDown`, `setPressure`, `setSpeed`, `setTilt`, `setAzimuth`, tool swaps while travelling).
3. **Pen** integrates physics (accel-limited steering toward the commanded point, finite z-speed, pressure lag).
4. **Deposition** happens *only* on contact: segment stamps with instrument-specific width/alpha/speed/grain; a touch-down blot for dip and brush pens. All inputs are float32-quantised so recorded events replay bit-exactly.
5. **Recorder** appends the event stream (pose, contact, pressure, velocity, tilt, azimuth, direction, instrument, blot flag).
6. **Feedback** cells refresh around the stroke; every 8 strokes a full SSIM/edge pass updates quality. Mid-stroke, every 96 samples the brain may **interrupt** a drifting contour.

The pen never teleports: pen-up travel is physical minimum-jerk motion that leaves no marks; speed multipliers (0.5×–MAX) only change how many deterministic steps run per wall tick.

## Motor control (spec §6)

- **Minimum-jerk** (Flash & Hogan): `x(τ) = x₀ + Δ(10τ³ − 15τ⁴ + 6τ⁵)` — travel and approach moves; corrective hops when settling overshoots 1.6 px.
- **Sigma-lognormal** (Plamondon): per-stroke speed shape tables (μ ≈ −2, σ ≈ 0.32 ± variation), normalised to mean 1, applied by arc position.
- **Two-thirds power law** (Lacquaniti et al.): `v = k·κ^(−1/3)` around the median curvature of each path, clamped ×0.22–1.5.
- **Submovements** (Meyer): overlapping minimum-jerk offset pulses when cross-track error exceeds 3.1 px (never for eraser sweeps).
- **Pressure envelopes**: raised-cosine attack/release between entry → level → exit; level chosen by artistic intent (gesture 0.13, construction 0.11–0.16, exploratory 0.15–0.3, linework 0.34 + 0.4·importance, shading 0.15–0.68 deficit-driven, eraser 0.35–0.65).

No jitter is added anywhere; natural irregularity emerges from the pursuit dynamics, power-law slowdowns and the medium.

## Instruments (spec §12)

Seven instruments with distinct deposition physics (`instruments.ts`): graphite pencil, mechanical pencil, fine liner, manga dip pen (G-pen with touch-down blot), brush pen, charcoal (tilt-widened, wide soft kernel), and a physical eraser. Pressure drives width (per-instrument γ), density, edge softness and speed coupling (graphite darkens when slow; ink thins when fast). Tools swap while the hand travels between strokes.

## The workflow (spec §9)

| Stage | What the artist does |
| --- | --- |
| A · Observation | Pen lifted; the eye scans attention foci; composition, symmetry and light direction are logged. |
| B · Gesture | Long light over-shooting strokes along PCA axes, medial flow and silhouettes. |
| C · Construction | Envelope ellipses, medial ellipses at skeleton nodes, proportion ticks, symmetry axis — mechanical pencil scaffold. |
| D · Exploratory | Contours segmented where confidence is low; searching second passes offset 1.1 px; variable light pressure. |
| E · Linework | Importance-ranked contour commitment with the chosen linework tool; pressure scales with importance; power-law speed. |
| F · Shading | Form-following offsets inside major contours, then **closed-loop hatching per tonal component**: the deficit over the component's own zone pixels is measured, ~55% is hatched away (spacing from a calibrated deposit model), and the region is re-measured — up to 4 passes (7 for flat tones). Flat regions use uniform 45°/135° manga hatching; formed regions follow the structure tensor or run across the light gradient. |
| G · Detail | High-scale edge chains plus edge-deficit problems; light hatch patches for small missing tones (deficit-driven, capped repeats). |
| H · Correction | Physical erasure of the gesture + construction scaffold along the stored paths; excess areas get gentle eraser sweeps; missing areas get conservative hatch patches; stagnation guard accepts the drawing when a round stops improving. |

## Performance (spec §14)

- Everything runs in a Web Worker (`pen.worker.ts`) with a 16 ms tick; the main thread only paints dirty tiles (64 px, transferred buffers) at display rate and renders the overlay/pressure graph via rAF.
- Typed arrays everywhere; no DOM in the engine (it also runs headless in Node for the test suite).
- Analysis caps at ≤384 px planes (≤512 for tone); evaluation at 160 px; per-stroke box updates keep feedback cheap.
- 16K-class references decode through the shared streaming PNG path; the working canvas is capped by the resolution option (512–2048), and all analysis happens on reductions.
- Speed presets 0.5×–8× and MAX (budget-limited catch-up). A full 400-stroke drawing runs in about one second at MAX; 1 million strokes is a configurable ceiling.

## Interface (spec §13)

The V4 studio shows the live pen (nib with pressure arc, leaning body from tilt/azimuth), stage/objective/instrument/phase readouts, stroke and lift counts, pen travel (total vs in-contact), SSIM/edge/missing/excess, a live pressure graph, optional pen-up travel paths, the attention rectangle, and a debug decision log with each decision's mathematical justification. Pause/resume/cancel, speed control, zoom/pan, and all exports are available.

## Exports (spec §15)

- **SVG** — variable-width ribbon outlines derived from the deposited trajectory samples (x, y, half-width, alpha), layered, with truthful `NTH Stroke V4` metadata. Eraser passes are documented in metadata (they live in the event log; raster exports remain ground truth).
- **PNG / transparent PNG** — composited from the material planes.
- **Stroke-sequence JSON** — the full registry.
- **Pen-event recording / replay files** — every sample: `t, x, y, z, pressure, vx, vy, tilt, azimuth, direction, meta, instrument` with documented bit flags (contact, pen-down/up events, instrument change, blot).
- **Projects (`.nth4`)** — reference + options + RNG states + brain memory + pending plans + canvas material + registry + recorder. Resumable: restore re-runs the deterministic analysis, overlays the saved state and continues exactly where the session stopped.

## Determinism

One seed drives everything: planner/hand RNG streams (xoshiro128\*\*), paper grain (integer hash), and the fixed timestep. Two runs with the same seed are bit-identical (verified); the pen-event replay reproduces the canvas bit-exactly (verified); projects resume deterministically (verified).

## V4 vs V3 — honest comparison

V3 is a loss-minimizing vector optimizer: it generates marks and keeps them only if they reduce reference error, which produces very high SSIM on flat-tone references. V4 is a physical pen artist: every mark comes from a simulated nib with pressure, speed and medium physics, so its tone is inherently textured (hatched graphite rather than flat fills).

Run `node --import tsx scripts/verify-v4.ts out-dir` for the current numbers on the synthetic fixture set. Characteristics at a 600-mark budget:

- **Reconstruction (SSIM)**: V3 0.92–0.99; V4 0.11–0.57 depending on subject. V4 is strongest on formed subjects (sphere, portrait, animal) and weakest on flat graphic tones (architecture bands, landscape skies), where hatching texture cannot match flat fills.
- **Edge structure**: V4 reaches 0.57–0.72 edge F1 through committed contour linework.
- **Stroke continuity**: V4 strokes are hand-scale (58–85 px mean) with real lift-off/touch-down dynamics; pen travel is measured and reported (43k–89k px per drawing).
- **Pressure**: continuously varying inside every stroke (mean within-stroke spread ≈ 0.11–0.13 of full range plus width variation), driven by envelopes, deficits and adaptation.
- **Process**: V4's artwork emerges live, stroke by stroke, with interruptions, erasures and re-measurement; V3 renders from a generated action stream.

## Verification

`npm test` runs `tests/engine/pen.test.ts` (31 tests): pen physics (no teleporting, pen-up leaves no marks, continuous pressure, contact semantics), motor models, deposition physics (pressure monotonicity, speed coupling, instrument signatures, eraser, determinism), the closed-loop stage machine, decision logging, tapered pressure, physical scaffold erasure, seed determinism, bit-exact event replay, recorder contents, SVG/strokes/events exports, project round-trip and resume, portrait and 2048-px pyramid runs, and telemetry shape. See `V4-VERIFICATION.md` for the recorded results.

## Known limitations

- SSIM on flat-tone graphic references trails V3 substantially (textured medium; see above).
- Smooth gradients band slightly at zone boundaries; the deadbanded feedback deliberately tolerates ±22/255 for textured media.
- Semantic understanding is classical-only: portraits get structural construction, not anatomy-aware drawing (no ML by design).
- Safari/iPadOS is a design target (workers, typed arrays, transferred buffers, no OffscreenCanvas requirement in the worker); physical iPad performance is unverified — the Balanced preset (1024 px working canvas, 240 Hz) is the recommended starting point.
- SVG export excludes eraser passes (SVG has no erasure); PNG/project exports carry the full truth.
