# NTH Stroke — implementation plan

## Run the studio

Run `npm install` and `npm run dev`, then open the local address printed by Vite. Run `npm run build` to create the production site in `dist/`.

Import a reference and press **Start drawing**. **Analyze reference** extracts reference colors and edges while leaving the canvas blank. The transport controls pause, replay, and scrub recorded marks.

## Live drawing

The engine follows connected contours to sketch the large shapes, then shades local areas with groups of strokes. It samples its current painting to choose the next mark. The pen approaches, makes contact, changes pressure along the path, and lifts. The stage controls report strokes as the engine commits them. Saving a project records completed strokes so a partial drawing can resume.

**Exact pixels** resolves remaining differences with a round, pressure-shaped brush that follows the local contour. PNG exports preserve the resulting RGBA values. Common unscaled 8-bit sRGB PNG inputs retain RGB under transparent pixels. Other images use browser-decoded sRGB pixels. Images above 4,096 pixels on either axis or 8,388,608 pixels total are scaled, and the canvas displays the working dimensions.

**Visible brushwork** finishes with vector brush marks. SVG exports the vector marks from either finish. JPEG and WebP use the browser's encoders.

## Design direction
### Alternative styles
- **Graphite Observatory** (0.06): forensic, monochrome, instrument-panel drawing lab.
- **Nocturne Atelier** (0.07): cinematic charcoal-black studio with warm paper accents and quiet craft cues.
- **Signal Loom** (0.08): technical dark canvas with electric blue telemetry and modular controls.

### Chosen style: Nocturne Atelier
- **Design movement:** a cinematic digital atelier: quiet dark space, paper-like canvas, tactile control surfaces, and restrained motion.
- **Core principles:** the canvas owns attention; controls feel like physical tools; telemetry is legible but secondary; every action reveals process rather than hiding it.
- **Color philosophy:** graphite backgrounds reduce glare, warm ivory denotes the working surface, muted amber marks the active craft state, and cool blue is reserved for analysis/debug signals.
- **Layout paradigm:** asymmetric studio rails frame a large open canvas rather than a centered dashboard. The composition deliberately leaves visual breathing room around the artwork.
- **Signature elements:** a copper/amber “live” pulse, stage chips that read like process stamps, and slim ruler-like stat rows.
- **Interaction philosophy:** immediate, reversible, and observable. Importing, playing, pausing, scrubbing, and changing settings update visible state without modal friction.
- **Animation:** 160–260ms panel transitions, subtle cursor glow, progress motion only while drawing, and visible travel/draw/lift phases for every stroke.
- **Typography system:** Inter/system sans for UI; a restrained serif/monospace pairing for stage labels and numeric telemetry.
- **Brand essence:** a deterministic digital atelier for watching images become drawings; precise, tactile, cinematic.
- **Brand voice:** concise and craft-oriented. Example: “Build from a blank canvas.” / “Trace the signal, stroke by stroke.”
- **Wordmark & logo:** NTH rendered as a compact monogram made from three offset stroke bars, paired with a small “stroke” label.
- **Signature brand color:** oxidized amber `#d49a58`.

## Project structure
- `index.html` — app shell and semantic regions.
- `src/main.ts` — UI state, controls, file handling, canvas orchestration, and event wiring.
- `src/engine.ts` — gesture timing, live drawing, and recorded-stroke transport.
- `src/drawing.ts` — reference analysis and adaptive stroke selection.
- `src/brush.ts` — pressure-sensitive brush geometry and vector output.
- `src/pixels.ts` and `src/png.ts` — local pixel correction and lossless PNG handling.
- `src/styles.css` — responsive Nocturne Atelier visual system.
- `public/manus-routes.json` — route manifest for the single studio route.
- `app.config.ts` — project logo metadata.

## Format support

The studio processes references in the browser. Native projects store the reference, settings, seed, completed stroke history, and playback position. Version 1 projects can be reopened for replay. TIFF, OpenRaster, video, and rich EXIF/XMP export remain outside the available formats.
