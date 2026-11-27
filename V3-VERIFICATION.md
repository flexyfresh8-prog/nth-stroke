# NTH Stroke V3 — Verification Report

Verified on 2026-11-27 with `npm test` (53 tests), `npx tsx scripts/verify-v3.ts v3-verification`, `npx next build`, and a scripted desktop-Chromium walkthrough of the studio. Fixtures are procedural (no user artwork); `manga-panel` and `glasses-portrait` rows appear when reference PNGs are passed to the script.

## 1. Test suite

```
Test Files  5 passed (5)
     Tests  53 passed (53)
```

- `tests/engine/structural.test.ts` (5) — foundation before tone with edits; checkpoint → resume → byte-identical SVG replay; transparent PNG round-trip through the V3 decoder; 16,384-px scanline decode with stage-5 marks beyond x=13000 in original coordinates; **construction guides fully erased during final refinement with imbalance metrics** (missing falls, excess < 5%, SSIM improves); **driver protocol** (probe → mask, start → mask, next → batch, stop → stopped, next-after-stop → stopped without hanging).
- V1/V2 suites (48 tests) unchanged and passing — the upgrade did not regress previous engines.

## 2. Engine benchmark (1,000-mark budget, 512px analysis, Balanced base)

| Reference | Engine | Marks | SSIM | Edges | Missing | Excess | ms | Mean length | Guides left |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Sphere | V1 | 230 | 0.648 | 0.305 | — | — | 1092 | 74.2 | — |
| Sphere | V2 | 1000 | 0.807 | 0.795 | — | — | 264 | 7.2 | — |
| Sphere | **V3** | 26 | **0.931** | **0.948** | 1.6% | 0.5% | 359 | 18.2 | 0 |
| Architecture | V1 | 131 | 0.604 | 0.736 | — | — | 922 | 141.8 | — |
| Architecture | V2 | 1000 | 0.753 | 0.799 | — | — | 206 | 5.1 | — |
| Architecture | **V3** | 228 | **0.943** | **0.999** | 0.7% | 1.9% | 348 | 21.8 | 0 |
| Landscape | V1 | 119 | 0.643 | 0.491 | — | — | 862 | 140.5 | — |
| Landscape | V2 | 1000 | 0.673 | 0.963 | — | — | 277 | 10.3 | — |
| Landscape | **V3** | 34 | **0.973** | 0.911 | 0.5% | 0.0% | 231 | 0 (20 fills) | 0 |
| Portrait | V1 | 168 | 0.427 | 0.417 | — | — | 909 | 104.5 | — |
| Portrait | V2 | 1000 | 0.728 | 0.753 | — | — | 191 | 5.1 | — |
| Portrait | **V3** | 116 | **0.974** | **0.981** | 6.1% | 1.2% | 376 | 16.2 | 1 |
| Hair | V1 | 232 | 0.479 | 0.260 | — | — | 908 | 81.6 | — |
| Hair | V2 | 1000 | **0.876** | **0.973** | — | — | 214 | 2.8 | — |
| Hair | **V3** | 549 | 0.877 | 0.943 | 8.7% | 6.8% | 788 | 10.0 | 0 |
| Ink panel | V1 | 139 | 0.156 | 0.130 | — | — | 1032 | 131.6 | — |
| Ink panel | V2 | 1000 | 0.598 | 0.711 | — | — | 231 | 6.7 | — |
| Ink panel | **V3** | 45 | **0.994** | **1.000** | 2.0% | 0.3% | 267 | 57.5 | 0 |
| Faint pencil | V1 | 124 | 0.827 | 0.000 | — | — | 718 | 104.4 | — |
| Faint pencil | V2 | 1000 | **0.946** | 0.500 | — | — | 251 | 3.6 | — |
| Faint pencil | **V3** | 21 | 0.891 | 0.500 | 1.5% | 0.0% | 160 | 0 (13 fills) | 0 |

Reading the table:

- V3 wins SSIM on six of seven fixtures while using 6–98% of the strokes V2 needs (portrait: 116 marks vs 1000 for +0.25 SSIM). On hair the two engines tie within noise (0.877 vs 0.876) with V3 favouring longer structure-following strokes.
- `Guides left` counts Construction marks still visible after stage 8. Six fixtures erase every guide. The single surviving portrait guide is a contour-aligned construction ellipse kept deliberately by the load-bearing veto (removal would raise local error beyond tolerance); visual inspection confirms it reads as structure, not scaffold.
- `Mean length` counts line strokes only; the landscape and faint fixtures are reproduced almost entirely with graded ink fills (`fills` column), which is the intended shading behavior on smooth gradients.
- Peak process RSS during the V3 runs stayed below 384 MiB including the Node harness; `processPeakKiB` in `results.json` is a cumulative process peak.

Stage renders for every fixture (`<name>-stage-0..7.png`) and per-engine outputs are written to `v3-verification/` by the script.

## 3. Visual inspection

Independent vision-model review of the generated stage strips (reference, then stages 0–7):

- Portrait: light construction lines → firm outlines → tone fills → refinement; final panel matches the reference (cap, face, eyes, mouth, torso). A diagonal construction line visible in early stages is gone in the final panels. No random dots, grid patterns, or duplicated outlines.
- Hair: strokes follow the strand flow (S-curve, vertical direction); density builds progressively; no stippling artifacts.
- Sphere / ink panel: contour and region fills converge to the reference silhouette; ink panel reaches 0.994 SSIM with 45 marks.

## 4. Application walkthrough (desktop Chromium)

Imported a 480×600 portrait PNG and exercised the studio end to end:

| Step | Observed |
| --- | --- |
| Import | Status **Ready**, preview rendered, subject-mask checkbox present (automatic probe fired) |
| Hint marking | Foreground tap placed a `+` marker and switched the preview to **Subject mask** live |
| Start | Stage indicator, mark counter, SSIM, edge accuracy, missing-ink and ink-excess metrics updating each frame |
| Pause / Resume | Marks froze at 423, resumed to 479 |
| Cancel | Status **Canceled**, options unlocked instantly (no re-decode), partial drawing kept and exportable |
| Start again | Canvas cleared, fresh deterministic session, ran to **Complete** |
| Complete | 2,803 marks, SSIM 0.927, edge accuracy 99.9%, missing 0.5%, excess 0.4% — SSIM rose from 0.888 during the correction and final-optimization stages |
| Canvas content | 43.2% alpha-ink coverage from generated vector paths (the reference raster is never composited) |
| Export | Layered SVG, PNG paper, transparent PNG, stroke-sequence JSON, resumable project all dispatch without errors |
| Console | No page errors, no console errors during the full session |

## 5. Scope and limits

- Determinism: same seed ⇒ byte-identical SVG across uninterrupted, checkpointed and resumed runs (covered by the suite).
- Safari/iPad: the engine requires only Web Workers + Canvas 2D with a main-thread fallback; no WebGPU/WebGL dependency. Physical iPad throughput at the 16K/1M-stroke extreme remains unverified on device.
- The geometric mask can still misclassify subjects against closely matching backgrounds; hints and the conservative fallback (hierarchical region analysis) remain the remedy.
- The engine does not infer semantic anatomy; portrait structure is confidence-gated geometry with fallbacks.
