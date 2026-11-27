# V5 · Human Artist

V5 keeps the whole V4 pipeline (Eye → Brain → Hand → Pen → Canvas → Feedback) and adds two things:

1. **Human motor layer** (`src/engine/pen/human.ts`). `HumanHand` extends the V4 hand and, after the V4 motor models run, perturbs the commanded pen target with ~9 Hz physiological tremor, slow speed-dependent drift and tilt wander. The pen still obeys its physics and the canvas still changes only through nib contact. All noise comes from the seeded RNG streams.
2. **Fidelity tuning** (`src/engine/pen/v5options.ts`). Higher working resolution (1400 px), larger stroke budget, higher contour sensitivity, shading and detail, graphite linework, full motor fidelity. A **Human touch** slider (0–1) sets the motor-noise amount; `0` is exactly V4.

V4 remains selectable and unchanged. V5 is the default engine in the studio.

## Known limits

- The Brain is shared with V4, so V5's accuracy gain comes from tuning, not a new planner. Measure with `node --import tsx scripts/verify-v4.ts <dir>` using `human > 0` options.
- The main-thread fallback (`penFallback.ts`) still builds the plain V4 simulation.
- Resuming a `.nth4` project keeps the saved `human` value in its options, but the tremor phase is not part of the saved state.
