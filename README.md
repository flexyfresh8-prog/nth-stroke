# NTH Stroke

NTH Stroke is a browser graphite studio with four independent drawing engines. **V4 Virtual Pen Artist** is the default: an autonomous artist that observes a reference with classical computer vision, plans like a human (gesture → construction → exploratory sketch → confident linework → shading → detail → correction) and drives a physically simulated pen — the only instrument that ever touches the canvas. **V3 Structural** (hierarchical structural vectorization), **V2 Adaptive** and **V1 Legacy** remain selectable; existing projects keep working.

## Use the studio

1. Import a reference — drawing begins automatically. In V4, watch the virtual pen travel, touch down, press and lift in real time; the panel shows the live pressure graph, current objective, attention region and the artist's decision log (enable **Debug: decision log**). Slow to 0.5× to study a stroke, or use MAX to watch the whole drawing emerge. In V3, tap the reference with **Foreground** or **Background** marking to guide segmentation before starting.
2. Set a maximum stroke budget, resolution ceiling, seed and optimization passes. V3 draws through eight visible stages: subject isolation, structural construction, primary outlines, secondary linework, shading, fine details, error correction and final optimization.
3. Pause, resume or cancel at any time. **Cancel** keeps the decoded reference so a new session with different options starts instantly. The V2 timeline replays recorded marks; V3 replays its whole action log.
4. Compare with the reference overlay, per-layer visibility, zoom, and live quality metrics (SSIM, edge accuracy, missing ink, ink excess).
5. Use **Export** to save PNG artwork, layered SVG, a stroke-sequence JSON or a resumable NTH project. V4 additionally exports the complete pen-event recording (replayable bit-exactly), replay files and transparent PNG, and saves resumable `.nth4` projects that continue the session deterministically. Saved 1.x projects open in Legacy; 2.x restore V2; 3.x resume V3; 4.x resume V4.

The theme starts in Dark. Choose Light or System from the top bar. The controls store the theme, engine and each engine’s settings locally.

## Build and verify

```sh
npm ci
npm run dev
npm test
npm run build:export
```

The GitHub Pages build is emitted to `out/` at `/nth-stroke/`. The repository workflow publishes it from `main`. See [deployment](DEPLOYMENT.md), [V4 architecture](V4-DESIGN.md), [V4 verification](V4-VERIFICATION.md), [V3 architecture and research](V3-DESIGN.md), [V3 verification](V3-VERIFICATION.md), [V2 architecture and research](V2-DESIGN.md), [V2 verification](V2-VERIFICATION.md), and [V1 architecture](ARCHITECTURE.md).
