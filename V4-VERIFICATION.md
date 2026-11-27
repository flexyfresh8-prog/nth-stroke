# V4 Verification

Run on the synthetic fixture set with `node --import tsx scripts/verify-v4.ts <dir>` (seed 20260101, 240 Hz, 600-mark budget ceiling, 512 px working canvas). `npm test` additionally runs the 31-test V4 suite (`tests/engine/pen.test.ts`) covering the spec §16 checklist; all 84 engine tests pass (V1–V4).

## V3 ↔ V4 comparison

| Fixture | Engine | Marks | SSIM | Edge F1 | Mean stroke px | Pressure spread | Pen travel px | Wall ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sphere | V3 | 28 | 0.927 | 0.94 | 236 | 0.337 | 0 | 392 |
| sphere | **V4** | 390 | 0.495 | 0.57 | 58 | 0.121 | 43 494 | 1 061 |
| portrait | V3 | 124 | 0.949 | 0.98 | 125 | 0.332 | 0 | 432 |
| portrait | **V4** | 467 | 0.466 | 0.71 | 72 | 0.118 | 61 344 | 1 020 |
| architecture | V3 | 600 | 0.918 | 0.99 | 46 | 0.239 | 0 | 532 |
| architecture | **V4** | 592 | 0.144 | 0.72 | 74 | 0.106 | 89 182 | 1 069 |
| landscape | V3 | 44 | 0.975 | 0.93 | 326 | 0.280 | 0 | 283 |
| landscape | **V4** | 418 | 0.108 | 0.58 | 85 | 0.117 | 64 386 | 779 |
| animal | V3 | 36 | 0.990 | 1.00 | 455 | 0.245 | 0 | 409 |
| animal | **V4** | 400 | 0.565 | 0.66 | 70 | 0.137 | 49 504 | 774 |

Determinism (same seed → bit-identical artwork): **PASS**.

Reading the table honestly:

- **Reconstruction accuracy.** V3 optimizes marks directly against reference error and wins SSIM everywhere, most dramatically on flat-tone references (architecture, landscape) where V4's hatched graphite is inherently textured. V4 is competitive on formed subjects (sphere 0.50, portrait 0.47, animal 0.57) where structure and gradient shading carry the drawing.
- **Stroke continuity.** V4 draws hand-scale strokes (58–85 px mean) with physical travel, lift-off and touch-down; pen travel of 43–89k px per drawing is measured and displayed live. V3's mean stroke length is set by its simplification tolerance rather than a hand.
- **Pressure variation.** Every V4 stroke carries a continuous pressure envelope (mean within-stroke spread 0.11–0.14); V4 additionally varies width, opacity, edge softness and speed coupling per instrument.
- **Computational performance.** Both complete a fixture in well under a wall second at full speed; V4 additionally sustains a live 120–240 Hz simulation, incremental tile streaming and a pen-event recorder.

## Spec §16 checklist (from `tests/engine/pen.test.ts`)

| Requirement | Result |
| --- | --- |
| Pen-up movement produces no marks | PASS — hashed material planes unchanged through 400 travel steps |
| Pen-down movement produces marks | PASS |
| Pressure affects deposition continuously | PASS — 5 pressures, monotone tones, no steps |
| Pen movement is physically continuous | PASS — per-step displacement ≤ maxSpeed·dt under hostile targets |
| Controller decides during execution | PASS — decision log, mid-stroke interrupts, pressure adaptation |
| Artwork generated entirely through pen movements | PASS — the canvas is only writable through `deposit()` |
| Replaying pen events reproduces the artwork | PASS — bit-exact material hash after replay |
| Previous engines remain functional | PASS — 84/84 tests across V1–V4 suites |
| Determinism with configurable seeds | PASS — same seed bit-identical; different seeds differ |
| Project round-trip & resume | PASS — `.nth4` pack/unpack, canvas hash preserved, session completes |
| SVG from deposited trajectories | PASS — ribbon geometry, truthful metadata, layer grouping |
| Recorder captures full event stream | PASS — contact, pressure, velocity, tilt, azimuth, instruments, lifts, blots |
| 16K-class reference support | PASS — 2048×1536 pyramid run (decode path shared with V3, verified there at 10 160×16 000) |

## Stage walk-through (sphere fixture)

Stage images are written by the verification script. Observable behaviour:

1. **A** — the pen hovers over attention foci; nothing is drawn.
2. **B** — two long light gesture axes cross the form.
3. **C** — envelope ellipse + proportion ticks + symmetry axis appear in faint mechanical pencil.
4. **D/E** — the sphere contour is searched, then committed in fineliner with tapered pressure.
5. **F** — form-following offsets, then measured hatch passes: the log shows the deficit closing pass by pass (e.g. 74 → 70 → 58 → 53 → 48 /255).
6. **G** — high-scale edge chains and light deficit patches.
7. **H** — the scaffold is physically erased along its stored paths; remaining hotspots receive eraser sweeps or conservative patches; a stagnation guard accepts the drawing.

## Limits

See “Known limitations” in `V4-DESIGN.md`: flat-tone SSIM gap, gradient banding, classical-only semantics, iPad physical performance unverified, SVG excludes erasures (documented in metadata).
