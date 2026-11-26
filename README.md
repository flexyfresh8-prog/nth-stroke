# NTH Stroke

NTH Stroke is a browser graphite studio with two independent drawing engines. V2 Adaptive is the default. V1 Legacy remains selectable for existing projects.

## Use the studio

1. Import a reference, choose a preset and press **Start**.
2. Set a maximum stroke budget or switch off convergence stopping for a manual cap. **Apply and clear drawing** rebuilds the analysis with updated settings.
3. Pause, resume, cancel or continue refining. The V2 timeline replays recorded marks.
4. Open **Diagnostics** for residual maps, pressure tools and accuracy. Use **Compare** to measure both engines on the same input.
5. Use **Export** to save PNG artwork, SVG paths, a session log or an NTH project. Saved 1.x projects open in Legacy. Saved 2.x projects restore V2 pigment and history.

The theme starts in Dark. Choose Light or System from the top bar. The controls store the theme, engine and each engine’s settings locally.

## Build and verify

```sh
npm ci
npm run dev
npm test
npm run build:export
```

The GitHub Pages build is emitted to `out/` at `/nth-stroke/`. The repository workflow publishes it from `main`. See [deployment](DEPLOYMENT.md), [V2 architecture and research](V2-DESIGN.md), [V2 verification](V2-VERIFICATION.md), and [V1 architecture](ARCHITECTURE.md).
