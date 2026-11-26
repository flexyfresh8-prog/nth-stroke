# NTH Stroke implementation checklist

## Deterministic local analysis and live brushwork
- [ ] An uploaded image can be analyzed successfully in the browser without a paid AI API.
- [ ] Analysis produces a deterministic seed and leaves the canvas blank. The live engine records each stroke as it completes.
- [ ] Identical images and configurations produce the same stroke history within the same browser.
- [ ] The imported image is used as an analysis reference and is never secretly rendered underneath the drawing canvas.
- [ ] The analysis view exposes edge strength, quantized colors, and measured drawing error.

## Visible animated drawing
- [ ] Drawing starts from a completely blank canvas.
- [ ] Individual strokes are animated along their calculated paths with requestAnimationFrame.
- [ ] The virtual pen travels to a start, touches, draws, lifts, and travels to the next stroke.
- [ ] Pressure, thickness, opacity, curves, and stage changes are visible.
- [ ] Stages report completed marks and may be skipped when the reference does not need them.
- [ ] Pausing freezes the drawing at its current position.
- [ ] Changing playback speed does not change the final artwork or stroke order.

## Playback and workspace controls
- [ ] Start, pause, resume, restart, stop, next-stroke, previous-stroke, timeline scrubbing, and speed controls work.
- [ ] Zoom, pan, rotation, grid, reference preview, before/after comparison, fullscreen, layers, manual brush mode, undo/redo, and iPad/touch-friendly pointer interactions work or are clearly labeled as functional fallbacks.
- [ ] Style selection changes stroke generation parameters and brush behavior.
- [ ] Quality controls change the generated stroke budget/detail.
- [ ] Live statistics show stage, completed/total strokes, strokes per second, brush, similarity, timing, resolution, ETA, and progress.

## Project and export
- [ ] `.nthstroke` projects contain the reference, recorded strokes, configuration, seed, playback position, and metadata. An unfinished project can continue drawing from its saved position.
- [ ] PNG, JPEG, WebP, SVG brush shapes, and native project export work. Exact PNG output matches the RGBA target at the working resolution.
- [ ] Unsupported advanced formats are disclosed with a functional fallback rather than fabricated metadata or encoding.
- [ ] The app works responsively on desktop, tablet, and iPad-sized layouts.

## Delivery evidence
- [ ] TypeScript diagnostics are registered and actionable issues are resolved.
- [ ] The dev runtime listens on the configured port and `manus-routes.json` returns valid route metadata.
- [ ] A production build completes successfully.
- [ ] Final implementation is saved to the canonical Git remote as a Webdev checkpoint.
