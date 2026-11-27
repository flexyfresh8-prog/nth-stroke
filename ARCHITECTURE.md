# Architecture

NTH Stroke 1.0 is a **closed-loop autonomous drawing engine**: it does not know what the finished artwork looks like. Each drawing operation is chosen from the *current state of the canvas*, executed by a simulated hand through a physical media engine, and then re-evaluated. Pausing, editing or erasing parts of the canvas simply changes what the engine observes next.

```
            ┌────────────────────────────────────────────────┐
            │                     UI (React)                 │
            │  reference · instruments · transport · metrics  │
            └───────────────▲────────────────────┬───────────┘
                    snapshots │            commands │ (user strokes too)
            ┌───────────────┴────────────────────▼───────────┐
            │              Engine Worker                     │
            │  OffscreenCanvas · Web Workers · dirty tiles   │
            │  ┌──────────────────────────────────────────┐  │
            │  │           DrawingController              │  │
            │  │   OBSERVE → PLAN → DRAW → EVALUATE →     │  │
            │  │                CORRECT → REPEAT          │  │
            │  └──┬─────────────┬──────────────┬─────────┘  │
            │     │       ┌─────┴─────┐  ┌─────┴──────┐      │
            │  SceneGraph  │  Planner │  │ Evaluator  │      │
            │  (analysis)  └─────┬─────┘  └─────┬──────┘      │
            │  ┌────────────┐ ┌──┴──────────┐ ┌─┴─────────┐  │
            │  │HandController│ │MediaEngine │ │GraphiteMap│ │
            │  │ (motor sim) │ │ (physics)  │ │ (artwork) │ │
            │  └─────────────┘ └────────────┘ └───────────┘  │
            └────────────────────────────────────────────────┘
```

## Source layout

```
src/engine/
├── core/         types, deterministic RNG (xoshiro128**), math, tile grid
├── analysis/     classical CV → SceneGraph (saliency, regions, contours,
│                 orientation field, tonal percentiles, light direction)
├── ml/           MediaPipe providers (face/pose/segmentation) + Loomis &
│                 Reilly landmark mapping; NullMlProvider fallback
├── planning/     stage planners (B–G), hatch generation, artistic decisions
├── motor/        minimum-jerk + two-thirds power-law trajectories,
│                 pressure dynamics, signal-dependent motor noise
├── media/        paper grain, 10 instruments, graphite deposition physics,
│                 blending/erasing, Beer–Lambert compositing
├── perception/   multiscale evaluator: SSIM, tone/edge/contrast/structure,
│                 ranked problem detection, harsh-edge + uncovered-edge maps
├── control/      the closed-loop controller, sim clock, checkpoints
├── session/      event recorder (ops, telemetry, corrections) + exports
└── worker/       protocol + engine worker (owns the OffscreenCanvas)

src/components/studio/   the React workspace (thin shell over the worker)
tests/engine/            vitest suites: unit physics + spec §15 verification
scripts/                 dev/verification tooling (render fixtures, reports)
public/models/           bundled .task models (face, pose, segmentation)
public/mediapipe/wasm/   bundled MediaPipe WASM runtime
```

The entire `src/engine` tree is **framework-agnostic and DOM-free** — it runs unchanged in the browser worker and in Node (that is how the verification suite exercises the real engine headlessly).

## The loop in detail

1. **OBSERVE** — `Evaluator.evaluate(scene, map)` composites the current graphite map to tone, compares it against the reference at three scales (SSIM, tone error), aligns edge maps via chamfer distance, measures local contrast and structure, and clusters mismatches into a ranked **problem list** (`signedError` says which way each area is wrong).

2. **PLAN** — the stage planner for the current stage turns the SceneGraph + problem list into one concrete `DrawOp` (waypoints, instrument, pressure intent, speed). Every planner re-queries the canvas (coverage checks, local densities), so decisions always reflect the drawing as it exists *now*.

3. **DRAW** — `HandController.execute` turns the op into a 240 Hz stylus trajectory: pen-up travel (Fitts-timed minimum-jerk hop), touch-down, power-law draw with signal-dependent motor noise and continuous pressure (attack/sustain/release with velocity coupling), lift-off. `MediaEngine.applyTrace` deposits graphite per stamp with mass-conserving physics; dirty tiles flow to the compositor.

4. **EVALUATE / CORRECT** — every 6 ops (fixed cadence, independent of playback speed) the evaluator refreshes the metrics. The correction stage acts on the worst problems with *localized* operations — kneaded-eraser lifts for overshoot, stump softening for edges harder than the reference, precision-erase + redraw for misplaced contours — each recorded with a human-readable reason. The engine deliberately stops after its correction budget rather than destroying good work.

## Stage machine (spec §4)

| Stage | What it does |
|---|---|
| A · Observation | analysis pipeline builds the SceneGraph |
| B · Construction | Loomis head ball + feature lines, Reilly gesture, bounding envelopes, perspective guides, proportion marks (2H, light, fast) |
| C · Refinement | contour chains traced and committed in priority order; exploratory searching strokes for important edges; obsolete construction marks erased |
| D · Tonal blocking | shadow masses filled patch-by-patch with local target values (broad side-of-tip strokes, charcoal/4B) |
| E · Shading | form-following hatching (traced along the orientation field, clipped at boundaries), cross-hatch layers, graphite layering, stump blending on smooth forms |
| F · Detailing | focal-priority accents: eyelashes, iris, brows, lips, nostrils, hair strands (streamline tracing), fine contours, texture accents |
| G · Correction | localized, reasoned fixes; then the drawing is accepted |

## Determinism

A single seeded xoshiro128\*\* stream drives the planner, hand and media engine. User strokes draw from a separate stream so interjections never perturb engine decisions. Checkpoints serialize RNG state, planner state, in-flight stroke, tip state and the (losslessly base64-encoded) density map — restoring resumes bit-exactly. Evaluation cadence is constant regardless of playback speed, so 0.25× and MAX produce the identical drawing.

## Performance

- Engine runs in a Web Worker; the canvas is a transferred OffscreenCanvas — the UI thread only renders snapshots.
- Dirty-region compositing: only tiles touched by recent strokes re-render (coalesced `putImageData` calls).
- Spatial index (tile → op ids) powers "which stroke is this?" queries for corrections.
- Analysis caps at 512 px long edge; the evaluator reuses pyramids; evaluation every 6 ops keeps MAX-speed drawing at interactive frame budgets.

## Known limitations (honest list)

- Semantic understanding is heuristic outside model coverage: without face/pose detection, portraits are drawn structurally (contours + values) rather than with feature-specific construction.
- Values on very smooth gradients can band; the darkest masses can read heavy relative to a photo reference — a graphite rendering, not a halftone copy.
- Safari/iPadOS is a design target (workers, OffscreenCanvas, MediaPipe CPU delegate, pointer pressure) but the current maintainers verified primarily on desktop Chrome; see VERIFICATION.md.
- Cross-browser determinism is expected but only formally verified within a single engine (V8/Node); MediaPipe inference may vary across browser WASM implementations.

## V4 · Autonomous Virtual Pen Artist

V4 (`src/engine/pen/`) is a separate architecture: not a vectorizer but a simulation. A Virtual Eye (classical CV: segmentation, contours, skeleton, structure tensor, tonal zones, saliency) feeds a Virtual Brain (stage machine A–H, closed-loop shading, correction planning) whose stroke plans a Virtual Hand executes through motor-control models (minimum-jerk, sigma-lognormal, two-thirds power law, submovements). The Virtual Pen is the only object that can mark the Virtual Canvas; every mark comes from simulated contact, pressure, speed and medium physics across seven instruments. A Visual Feedback System measures per-cell deficits and drives adaptation, interrupts and erasure. The simulation runs at a fixed 120–240 Hz in a worker, streams dirty tiles and telemetry to the UI, records the complete pen-event stream (replayable bit-exactly) and saves resumable `.nth4` projects. See [V4-DESIGN.md](V4-DESIGN.md) and [V4-VERIFICATION.md](V4-VERIFICATION.md).
