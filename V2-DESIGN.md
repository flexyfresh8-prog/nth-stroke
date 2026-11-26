# NTH Stroke V2 design

## V1 investigation

- The failure screenshot and original portrait show that the glasses, eyes, eyebrows and nose did not survive as a connected structure. The original is square, so an aspect-ratio error alone cannot account for its failure.
- `worker/engine.worker.ts` separately imposed minimum widths and heights and `analysis/scene.ts` assumed one scale factor. This can move marks off their reference on narrow inputs. V2 preserves the raster aspect and uses its analysis grid as the artwork coordinate system.
- `analysis/contours.ts` marks the seed visited in the first walk, so the nominal reverse walk exits immediately. Thresholds, one-way growth, simplification and a 220-chain cap can discard thin glasses and eyelashes. The legacy classical tracker remains available to V1. V2 uses connected multilevel tonal contours for construction and structure-tensor-guided residual tracing for line detail.
- `planning/planner.ts` falls back to region ellipses and main axes without semantic landmarks. It uses regional brightness and broad-tip spots to block tone. A region average cannot predict a whole stroke crossing a thin highlight or a boundary. Fixed planner termination can also leave substantial residuals before the nominal budget.
- The media engine accumulates overlapping stamps physically; the V1 planner does not simulate their combined footprint before accepting a mark. Evaluation is periodic rather than part of candidate selection. These choices allow locally saturated marks even when the surrounding tone is too light.
- Reopening formerly stored a downsampled reference but recalculated canvas dimensions from the downsample. Older checkpoints record their original canvas size independently.

## Research applied

- Hertzmann, [Painterly Rendering with Curved Brush Strokes of Multiple Sizes](https://mrl.cs.nyu.edu/publications/painterly98/). V2 compares the painting with progressively finer targets and follows gradient tangents where the field is coherent.
- Hertzmann, [Paint By Relaxation](https://wwwisg.cs.uni-magdeburg.de/~stefans/npr/entry-Hertzmann-2001-PBR.html). V2 uses local candidate optimization. It evaluates deposits, lifts and redistributions against current artwork and applies only improving marks.
- Canny, [A Computational Approach to Edge Detection](https://pubmed.ncbi.nlm.nih.gov/21869365/). The shared classical analysis supplies smoothed gradients, hysteresis edges and tensor orientation. V2 keeps fine and coarse gradient fields and separately flood-fills comparable multiscale tone into connected regions.
- Kang, Lee and Chui, [Coherent Line Drawing](https://www.umsl.edu/~kangh/Papers/kang_npar07_hi.pdf). Doubled-angle tensor orientation keeps nearby line directions sign-invariant. Fine-scale residuals steer the nib locally back toward poorly represented features.
- [Hatched! Creating Form with Line](https://www.getty.edu/art/exhibitions/hatched/index.html). Construction uses light marks along measured boundaries. Longer related strokes block values and cross-hatching is a selectable alternative to following form.
- [MediaPipe Face Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker). Optional detected points softly weight optimization. Deterministic ridge, contrast, and saliency fields work independently of detection on stylized imagery.
- Wang et al., [SSIM](https://eceweb.uwaterloo.ca/~z70wang/publications/ssim.html) and [MS-SSIM](https://www.cns.nyu.edu/~lcv/pubs/makeAbs.php?loc=Wang03b). Windowed luminance and covariance metrics complement luminance MAE, symmetric edge matching, and feature-weighted residual. Benchmark runs independently resample both rendered outputs to a common reference grid.

## Data flow

Reference luminance is white-composited once, with Gaussian levels, tangent/coherence, relative contrast, tone-connected segmentation, focal weights and highlight/shadow flags in artwork coordinates. Stroke candidates come from connected contours or the highest-priority dirty regions. An instrument rasterizes a local tapered contact patch. A weighted objective fits the pressure and compares both darkness and neighboring contrast. Committing that patch changes pigment and only invalidates affected regions. The canvas compositor reads the pigment field exclusively.

The worker holds one engine and one reference at a time. The controller contract exposes lifecycle, stepping, dirty compositing, project checkpoints and diagnostics. V1 retains its controller, planner, virtual hand and media implementation. V2 uses its own optimizer, surface, clock and checkpoint. Both execute through the same worker transport. A Canvas 2D patch transport covers browsers without transferable canvas when OffscreenCanvas is available to the worker.

## Feedback and convergence

The optimizer maintains an index of residuals over 12-pixel cells. For a selected cell, it proposes several lengths, widths, directions and instruments. Candidate patches use the same pressure taper, paper grain and pigment capacity as committed marks. It fits one signed pressure scalar against the weighted squared luminance residual and local contrast. Deposits on already-dark areas and deposits leaking into highlights receive extra penalties. An eraser reduces local pigment, and the blending stump relaxes a region toward its footprint-weighted density while approximately preserving mass.

The optimizer changes brush scales as it moves from composition to line detail. Within any stage it can lift pigment or blend before making a new mark. Correction tries multiple tools and can restart at the user's request. Automatic runs terminate on a measured plateau, a lack of improving candidates or the stroke ceiling. The optional compute limit depends on machine speed. Absent that time limit, seed and identical settings determine the drawing independently of playback speed.

The live compositor streams only touched rectangles. The browser uses an OffscreenCanvas when it can transfer the canvas. A fallback sends dirty rectangles to a visible Canvas 2D context. The adaptive working grid is 384 pixels on its long edge, or 300 on compact mode and low-resource devices. The source preview and original project reference retain their original resolution.

## Limits and interpretation

- V2 produces grayscale graphite. Colored reference images retain their original colors in the reference pane and are compared using white-composited luminance. PNG encodes the actual visible artwork. SVG reproduces vector paths approximately because paper tooth and blending have no simple SVG equivalent.
- The optimizer is greedy and the candidate family is limited. Dense portrait textures, hair highlights and large dark fields can retain visible pencil grain or softening. SSIM over 0.90 is a measured result on some fixtures, with no guarantee for arbitrary images.
- Optional face landmarks improve focal weighting when detected. The fallback uses contrast, ridge orientation, saliency and real connected boundaries. It does not assign anatomical labels to the fallback.
- Timeline replay in V2 replays recorded brush geometry. A scrub to a very early position rebuilds the corresponding pigment from the recorded marks. Older 1.x projects open through V1. Pre-overhaul project schemas are outside the native 1.x and 2.x readers.
- Heap readings appear only when the browser exposes the relevant value. Static deployment uses JavaScript, Canvas 2D and a worker. GPU extensions are optional and unused by the reference solver. Chromium tests at tablet widths do not constitute physical iPad Safari verification.
