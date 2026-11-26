# Deployment

## Requirements

- Node.js 20+ (22 recommended) and npm.
- No environment variables, no database, no server-side runtime: the engine,
  the vision models and the drawing physics run entirely in the browser.

## Development

```bash
npm install
npm run dev          # http://localhost:3000
```

## Tests

```bash
npm test             # 43-test engine verification suite (headless Node)
```

## Static export (self-hosting)

```bash
npm run build:export       # → ./out  (basePath /nth-stroke)
```

To host at a domain root or a different sub-path, set `BASE_PATH`:

```bash
EXPORT=1 BASE_PATH= npm run build:export   # hosted at /
EXPORT=1 BASE_PATH=/draw npm run build:export
```

`./out` is a fully static site — serve it from any static host (nginx,
Netlify, Vercel static, S3+CloudFront…). It contains:

- the app shell and JS chunks,
- `models/` — the three bundled MediaPipe task models (~12 MB),
- `mediapipe/wasm/` — the MediaPipe WASM runtime (~29 MB).

## GitHub Pages (this repository's default)

`.github/workflows/deploy.yml` runs on every push to `main`:

1. `npm ci`
2. type-check the engine
3. `npm test` (the full verification suite must pass)
4. `EXPORT=1 BASE_PATH=/nth-stroke npm run build:export`
5. upload `out/` to GitHub Pages

In the repository settings, **Settings → Pages → Source: GitHub Actions**
must be selected once.

## Bundle sizes

| Item | Size |
|---|---|
| App shell + JS chunks | ~1 MB |
| Vision models (`public/models`) | ~12 MB |
| MediaPipe WASM (`public/mediapipe/wasm`) | ~29 MB |

If you want a lighter deployment without semantic models, delete those two
folders and leave "Use local vision models" off — the engine falls back to
classical analysis automatically.

## Browser support

- Web Workers + `OffscreenCanvas` (Safari 16.4+, Chrome 69+, Edge, Firefox 105+)
- `createImageBitmap`, `CompressionStream` (project files fall back to plain JSON)
- Optional: `MediaRecorder` + `canvas.captureStream` for timelapses
