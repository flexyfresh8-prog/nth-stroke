# NTH Stroke

A live drawing studio — watch images become drawings, stroke by stroke, through a deterministic Canvas 2D drawing engine. Runs entirely in the browser: local processing, no AI, no uploads.

**Live site:** https://flexyfresh8-prog.github.io/nth-stroke/

## Development

```bash
pnpm install
pnpm dev        # dev server on http://localhost:3000
pnpm build      # type-check + production build to dist/
pnpm preview    # preview the production build
```

Requires Node 20+ and pnpm 10 (enabled automatically via `packageManager`).

## Deployment

GitHub Pages is deployed automatically by GitHub Actions (`.github/workflows/deploy.yml`) on every push to `main`. The build sets Vite's `base` to `/nth-stroke/` so assets resolve correctly from the Pages subpath.

## Tech

- Vite 6 + TypeScript, zero runtime dependencies
- Canvas 2D rendering with a 7-stage drawing pipeline (construction, rough sketch, linework, base colors, shading, fine details, refinement)
- PNG / JPEG / WebP / SVG export, plus a native `.nthstroke` project format that records strokes and the reference image
