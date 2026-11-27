# NTH Stroke

NTH Stroke is a browser graphite studio with three independent drawing engines. **V3 Structural** is the default: a hierarchical engine that isolates the subject, constructs a geometric foundation, then develops contours, linework, shading and correction passes. V2 Adaptive and V1 Legacy remain selectable for existing projects.

## Use the studio

1. Import a reference, choose a preset and press **Start**. In V3, tap the reference with **Foreground** or **Background** marking to guide segmentation and watch the subject mask update live before drawing.
2. Set a maximum stroke budget, resolution ceiling, seed and optimization passes. V3 draws through eight visible stages: subject isolation, structural construction, primary outlines, secondary linework, shading, fine details, error correction and final optimization.
3. Pause, resume or cancel at any time. **Cancel** keeps the decoded reference so a new session with different options starts instantly. The V2 timeline replays recorded marks; V3 replays its whole action log.
4. Compare with the reference overlay, per-layer visibility, zoom, and live quality metrics (SSIM, edge accuracy, missing ink, ink excess).
5. Use **Export** to save PNG artwork, layered SVG, a stroke-sequence JSON or a resumable NTH project. Saved 1.x projects open in Legacy. Saved 2.x projects restore V2 pigment and history. Saved 3.x projects resume V3 deterministically.

The theme starts in Dark. Choose Light or System from the top bar. The controls store the theme, engine and each engine’s settings locally.

## Build and verify

```sh
npm ci
npm run dev
npm test
npm run build:export
```

The GitHub Pages build is emitted to `out/` at `/nth-stroke/`. The repository workflow publishes it from `main`. See [deployment](DEPLOYMENT.md), [V3 architecture and research](V3-DESIGN.md), [V3 verification](V3-VERIFICATION.md), [V2 architecture and research](V2-DESIGN.md), [V2 verification](V2-VERIFICATION.md), and [V1 architecture](ARCHITECTURE.md).
