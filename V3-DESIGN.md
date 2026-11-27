# V3 · Hierarchical Structural Drawing Engine

V3 uses deterministic classical image analysis and Canvas 2D. The V1 and V2 engines remain available in the engine selector. V3 runs in a worker where supported and uses the same CPU pipeline on the main thread as a fallback. Reference images and project contents stay on the device.

## Pipeline

- Subject isolation uses a two-pass weighted adjacency graph with region-dependent merge thresholds. Border contact, luminance, and optional foreground and background seeds classify the resulting regions. Opposing seeds prevent merges. The mask guides construction and layer assignment. Ambiguous compositions still receive full-image contour passes.
- Construction uses connected silhouettes, PCA, a confidence-gated ellipse fit, and medial chord midpoints. It draws a light foundation before outlines and can remove the foundation during optimization.
- Outline passes use marching squares for subpixel level sets and nonmaximum-suppressed edge chains at two scales. Junction traversal prefers tangent continuity. Simplified paths become cubic Bézier curves. Filled ribbon paths preserve tapered pressure profiles in SVG.
- Shading uses graded vector ink regions, directional hatching, and cross-hatching. Region quantization is denser on smooth gradients. Fine detail uses structure-tensor tangents and residual-ranked local candidates.
- Each accepted mark updates the working raster. Candidate trials compare weighted luminance and gradient losses in a bounded rectangle. The final passes test opacity, translation, curve simplification, and aligned joins. Trials that increase the local loss are rolled back. Stage boundaries report SSIM, edge precision and recall, and absolute luminance error.
- The source plane keeps full-resolution 8-bit luminance with a small RGB composition sample. PNG scanlines are streamed, including Adam7 PNGs. Detail stages use bounded overlapping tiles and a spatial mark index. Each core tile owns its seed locations. Vector coordinates and banded PNG export retain the imported dimensions.
- V3 projects store the original file and an ordered vector action log. Partial checkpoints restart the deterministic solver and advance it to the saved action position. Replay, layered SVG and JSON, and opaque or transparent PNG are available from the studio.

## Research decisions

Apple subject lifting inspired the mask and manual hint workflow. Its published implementation uses a deep model. V3 applies region graph segmentation inspired by Felzenszwalb and Huttenlocher. GrabCut and classical alpha matting were evaluated as designs for high-quality interactive extraction. Their seed and optimization requirements informed the manual hints and conservative fallback. V3 uses graph merging for the bounded composition pass.

The construction skeleton approximates medial geometry using PCA-aligned interior chords. This shortcut favors readable construction strokes for simple shapes. Marching squares and Canny-style hysteresis support boundaries and thin lines. V3 applies chord-length cubic tangents and recursive tolerance-based simplification inspired by Graphics Gems. Structure-following strokes and progressive tone buildup adapt ideas from Hertzmann and Praun et al.

- [Apple subject lifting](https://machinelearning.apple.com/research/salient-object-segmentation)
- [Efficient Graph-Based Image Segmentation](https://www.cs.cornell.edu/~dph/papers/seg-ijcv.pdf)
- [GrabCut](https://www.microsoft.com/en-us/research/publication/grabcut-interactive-foreground-extraction-using-iterated-graph-cuts/)
- [Distance Transforms of Sampled Functions](https://www.cs.cornell.edu/~dph/papers/dt.pdf)
- [Graphics Gems curve fitting](https://github.com/erich666/GraphicsGems/blob/master/gems/FitCurves.c)
- [Painterly Rendering with Curved Brush Strokes](https://mrl.cs.nyu.edu/publications/painterly98/)
- [Real-Time Hatching](https://gfx.cs.princeton.edu/proj/hatching/)

## Verification and limits

Run `npm test`, `npm run build:export`, and `node --import tsx scripts/verify-v3.ts output-dir [manga.png] [portrait.png]`. The benchmark script writes stage images, actual engine renders, and JSON metrics. Private reference artwork is excluded from the repository. The table uses a 1,000-mark budget and downscaled references. The memory column in script output is a cumulative process peak, which includes the test harness.

| Reference | V1 SSIM | V2 SSIM | V3 SSIM | V3 marks |
| --- | ---: | ---: | ---: | ---: |
| Manga page | 0.242 | 0.553 | 0.820 | 871 |
| Portrait with glasses | 0.155 | 0.480 | 0.826 | 1,000 |
| Faint linework | 0.827 | 0.946 | 0.891 | 21 |

The geometric mask can misclassify subjects against closely matched or complex backgrounds. The engine does not infer semantic anatomy. Faint parallel lines can merge and tonal contours can remain visible in smooth gradients. The 1,000,000-mark limit is a configurable ceiling. A run reaching that count and holding the resulting marks in mobile memory has not been verified. The manga PNG at 10,160 × 16,000 was exercised in desktop WebKit. Physical iPad performance is unverified.

## V3.1 refinements

**Construction erasure.** Stage 8 now treats Construction-layer marks as scaffold to erase, like an artist cleaning pencil guides. Each guide is repainted away and the removal is accepted unless it would raise the local loss beyond `5% + 48` — a load-bearing construction stroke survives as structure. Guides are processed before other trials and outside the iteration cap, so they are erased even with zero optimization passes. Verified: no construction marks remain visible on the benchmark fixtures except one contour-aligned guide kept by the veto.

**Imbalance metrics.** `quality()` now also reports `missing` (fraction of pixels meaningfully lighter than the reference) and `excess` (fraction meaningfully darker). They drive a stopping rule for correction passes — once `missing < 0.8%`, no further pass runs, so the engine optimizes fidelity rather than stroke count — and they are displayed live in the studio metrics bar.

**Driver protocol.** `open | start | next` gained `probe` and `stop`. `probe {hints, sensitivity}` re-runs the 128px segmentation on the cached source and replies with the mask, so the mask preview updates while the user refines hints before starting (and after a cancellation). `stop` drops the generator, keeps the decoded source, and acknowledges with `stopped`; `next` without an active drawing replies `stopped` instead of hanging. The studio's **Cancel** uses it: options unlock immediately and a new session starts without re-decoding the file. A fresh session always restarts from an empty sheet.

These behaviors are covered by `tests/engine/structural.test.ts` (guide erasure, imbalance tracking, probe/batch/cancel protocol) and by the browser walkthrough in `V3-VERIFICATION.md`.
