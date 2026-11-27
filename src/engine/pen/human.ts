// NTH Stroke V5 — the human motor layer. HumanHand wraps the V4 hand and
// perturbs the commanded pen target AFTER the V4 motor models run, so the
// pen still obeys its physics and the canvas still changes only through
// contact. Added: ~9 Hz physiological tremor, slow speed-dependent drift
// (the hand wandering off the ideal line), and tilt wander. All noise is
// drawn from the seeded hand RNG, so a seed still reproduces a drawing.
import { VirtualHand } from './hand';
import type { VirtualPen } from './pen';
import type { Rng } from './rng';
import { Simulation } from './sim';
import { humanAmount } from './v5options';
import type { Source } from '../structural/source';
import type { SimOptions } from './types';

const TAU = Math.PI * 2;

export class HumanHand extends VirtualHand {
  private clock = 0;
  private inStroke = false;
  private ph = [0, 0, 0, 0];

  constructor(
    pen: VirtualPen,
    rng: Rng,
    motor: number,
    private readonly amount: number,
    private readonly noise: Rng,
  ) {
    super(pen, rng, motor);
  }

  step(dt: number, deposit: (blot: number) => void) {
    super.step(dt, deposit);
    this.clock += dt;
    if (this.phase === 'draw' && this.current) {
      if (!this.inStroke) {
        this.inStroke = true;
        for (let i = 0; i < 4; i++) this.ph[i] = this.noise.next() * TAU;
      }
      const pen = this.pen;
      const a = this.amount * pen.nibScale;
      const speed = Math.hypot(pen.vx, pen.vy);
      const tremor = 0.18 * a;
      const drift = 0.5 * a * Math.min(1, speed / 200);
      const c = this.clock;
      const t = pen.target();
      pen.moveTo(
        t.x + tremor * Math.sin(TAU * 9.3 * c + this.ph[0]) + drift * Math.sin(TAU * 2.9 * c + this.ph[1]),
        t.y + tremor * Math.sin(TAU * 10.1 * c + this.ph[2]) + drift * Math.sin(TAU * 3.3 * c + this.ph[3]),
      );
      pen.setTilt(0.24 + 0.07 * this.amount * Math.sin(TAU * 0.35 * c + this.ph[0]));
    } else {
      this.inStroke = false;
    }
  }
}

export class HumanSimulation extends Simulation {
  constructor(source: Source, options: SimOptions) {
    super(source, options);
    const old = this.hand;
    const handRng = (this as unknown as { handRng: Rng }).handRng;
    const plannerRng = (this as unknown as { plannerRng: Rng }).plannerRng;
    const h = new HumanHand(this.pen, handRng, options.motor, humanAmount(options), plannerRng.fork());
    h.hooks = old.hooks;
    (this as unknown as { hand: VirtualHand }).hand = h;
  }
}

export function createSimulation(source: Source, options: SimOptions): Simulation {
  return humanAmount(options) > 0 ? new HumanSimulation(source, options) : new Simulation(source, options);
}
