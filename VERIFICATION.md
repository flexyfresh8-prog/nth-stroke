# Verification — measured results

All results below were produced by the automated suites in this repository
(`npm test`, `scripts/verify-report.ts`) plus manual browser runs. Nothing
here is aspirational: these are the actual numbers the engine produced.

## 1. Automated suites

```
npm test
→ Test Files  3 passed (3)
→ Tests      43 passed (43)
```

- `tests/engine/units.test.ts` — 28 unit tests: RNG determinism/distribution/restore,
  minimum-jerk boundary conditions, Fitts timing, power-law timing monotonicity,
  bounded smooth motor noise, pressure continuity + velocity coupling + taper,
  deposition monotonicity, per-instrument differences, saturation ceilings,
  eraser lift with ghosting, stump mass conservation, paper-grain response,
  Beer–Lambert monotonicity, hatch spacing bounds, SSIM sanity, hand-trace
  determinism.
- `tests/engine/verification.test.ts` — the mandatory spec §15 checks (below).
- `tests/engine/engine-smoke.test.ts` — full headless runs.

## 2. Spec §15 checks — status

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Blank canvas, genuine incremental generation | **PASS** | every inked tile traces to recorded op footprints; session contains every op |
| 2 | Pause halfway, incomplete artwork intact | **PASS** | pause event logged; partial ink 1–55% of canvas; resume continues |
| 3 | User modifies canvas → engine adapts | **PASS** | user erasure re-inked by subsequent engine ops near the edit; `simulated:false` marking verified |
| 4 | Incorrect feature → localized correction | **PASS** | injected wrong 6B scribble triggers corrective ops with recorded reasons |
| 5 | Same seed → same drawing | **PASS** | identical density fingerprints and identical op sequences across runs |
| 6 | Continuous pressure & velocity | **PASS** | 240 Hz physics-level continuity test + rate-based check on recorded telemetry |
| 7 | Construction → refinement → shading → detailing stages | **PASS** | stage order asserted in session; real ops and graphite in every stage |
| 8 | SVG complexity & size | **PASS** | one vector mark per stroke, zero duplicated path data, 29–77 KB for 147–333 strokes |
| 9 | Reference accuracy benchmarks | **PASS** | table below |
| 10 | Portraits, architecture, landscapes, animals, objects | **PASS** | five procedural fixture classes all complete all stages |
| 11 | iPad Safari compatibility | **PARTIAL** | uses only Safari-16.4+ APIs (Workers, OffscreenCanvas, pointer pressure, MediaPipe CPU delegate); not physically tested on iPad hardware by the maintainers — needs a device pass |
| 12 | Reference never embedded in artwork | **PASS** | structural test: artwork pixels only change through executed ops; early-stage tone remains paper |

## 3. Reference-accuracy benchmarks (headless, seed 7, budget 900)

Engine time = wall-clock compute; the *simulated* hand time is what the
playback clock shows at 1×.

| fixture | ops | compute (s) | sim time (min) | SSIM | tone err | edge align | contrast err | structure err | SVG (KB) | session (KB) |
|---|---|---|---|---|---|---|---|---|---|---|
| sphere | 330 | 1.7 | 12.7 | 0.499 | 0.120 | 0.955 | 0.194 | 0.107 | 68 | 1299 |
| portrait | 333 | 2.1 | 16.2 | 0.442 | 0.137 | 0.934 | 0.210 | 0.194 | 65 | 1448 |
| architecture | 329 | 1.8 | 14.5 | 0.303 | 0.217 | 0.963 | 0.168 | 0.288 | 77 | 1511 |
| landscape | 147 | 1.0 | 8.4 | 0.598 | 0.147 | 0.948 | 0.132 | 0.165 | 29 | 724 |
| animal | 231 | 1.6 | 13.7 | 0.414 | 0.115 | 0.858 | 0.208 | 0.328 | 40 | 1164 |

All five classes progress through every stage:
`construction → refinement → tonal → shading → detail → correction → complete`.

Determinism spot check (sphere, seed 99, two independent full runs):
**IDENTICAL** density fingerprints (`c84e664e`).

Metrics improve over a run (sphere, 30 ops vs 400 ops): tone error falls,
edge alignment rises.

## 4. Browser verification (desktop Chrome, headless)

- Import → analysis (models load: face/pose/segmentation WASM, CPU delegate) →
  **Start → 311–333 strokes → Done** on the portrait fixture; identical
  stage pipeline; live metrics update; no console errors.
- MAX speed completes the drawing in ~6 s wall time at ~330 ops.
- Canvas export (`toDataURL`) verified non-trivial (~124 KB PNG).
- Session JSON export triggered from the Export menu.
- The compositor had a tile-offset bug caught and fixed during verification
  (putImageData placement); the browser output now matches the headless
  engine output for the same seed.

## 5. Qualitative assessment (vision-model review of renders)

- **Sphere**: circle recognized, concentric curved strokes wrap the lit side
  (form-following confirmed numerically: ~63–66% of interior stroke samples
  tangential to the form vs ~40% for random directions), full tonal range,
  hard-edged highlight and heavy dark side remain as noise.
- **Portrait**: oval head, hair mass, eyes with pupils, nose line, mouth,
  neck and shoulders all recognized; hair/shoulder masses read dark (they
  are dark in the reference); some scratchiness in background transitions.
- Known quality gaps are listed in ARCHITECTURE.md → Known limitations.

## 6. Remaining limitations

1. iPad/Safari: engineered for it (APIs, touch targets, pointer pressure,
   CPU delegate for determinism) but not device-tested here.
2. Classical-only mode (models blocked) draws portraits structurally but
   without feature-specific construction — faces rely on contour fidelity.
3. Architecture fixtures score lower SSIM (0.30) — large flat value fields
   are where graphite hatching differs most from a photo; edge alignment is
   still 0.96.
4. Cross-browser bit-exactness is expected (typed-array math, no GPU in the
   engine path) but formally verified only on V8.
5. Timelapse recording depends on `MediaRecorder`/`captureStream` availability
   (WebM on Chrome/Firefox; MP4 where the browser provides it; disabled with
   a message otherwise).
