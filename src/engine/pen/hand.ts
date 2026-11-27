// The V4 Virtual Hand (spec §6): translates artistic intentions (stroke
// plans from the brain) into continuous pen movement through motor-control
// models — minimum-jerk travel, pure-pursuit path following with a physical
// acceleration-limited pen, sigma-lognormal speed shaping, two-thirds power
// law curvature slowdown, and corrective submovements.
//
// The hand NEVER decides what to draw; it only decides HOW to move. Long
// sweeping strokes and small precise details get different speed regimes,
// sharp turns slow the pen, and corrections are overlapping submovement
// pulses — no arbitrary jitter is added anywhere.

import {
  addSubmovement,
  arcLengths,
  curvatureAt,
  fittsTime,
  pointAtArc,
  powerLawFactor,
  pressureAt,
  resample,
  SpeedShape,
  startMinJerk,
  stepMinJerk,
  stepSubmovements,
  type MinJerk,
  type Submovement,
} from './motor';
import { LIFT_HEIGHT, VirtualPen } from './pen';
import type { Rng } from './rng';
import type { StrokePlan } from './types';

export type HandPhase = 'idle' | 'travel' | 'approach' | 'draw' | 'depart' | 'hover';

export interface StrokeOutcome {
  plan: StrokePlan;
  drawn: number; // px of deposit
  meanPressure: number;
  maxDeviation: number;
  aborted: boolean;
}

export interface HandHooks {
  onStrokeStart?: (plan: StrokePlan) => void;
  onStrokeEnd?: (outcome: StrokeOutcome) => void;
  onTravelDone?: () => void;
}

const dist = (x: number, y: number, tx: number, ty: number) => Math.hypot(tx - x, ty - y);

export class VirtualHand {
  phase: HandPhase = 'idle';
  queue: StrokePlan[] = [];
  current: StrokePlan | null = null;
  hooks: HandHooks = {};

  private mj: MinJerk | null = null;
  private arc: Float64Array = new Float64Array(0);
  private pts: Float32Array = new Float32Array(0);
  private total = 0;
  private s = 0;
  private shape: SpeedShape = new SpeedShape(0, 0);
  private kappa: Float32Array = new Float32Array(0);
  private kappaRef = 0.01;
  private submoves: Submovement[] = [];
  private submoveCooldown = 0;
  private drawn = 0;
  private lastX = 0;
  private lastY = 0;
  private meanP = 0;
  private pN = 0;
  private maxDev = 0;
  private aborted = false;
  private firstContact = false;
  private stallS = 0;
  private stallSteps = 0;
  private probe = new Float32Array(4);
  private hoverQueue: [number, number][] = [];
  private hoverDwell = 0;

  strokesStarted = 0;
  strokesEnded = 0;

  constructor(
    public pen: VirtualPen,
    private rng: Rng,
    private motorWeight: number,
  ) {}

  submit(plan: StrokePlan) {
    this.queue.push(plan);
  }

  submitAll(plans: StrokePlan[]) {
    for (const p of plans) this.queue.push(p);
  }

  clear() {
    this.queue.length = 0;
    if (this.phase === 'draw') this.abort();
  }

  /** Interrupt the active movement: lift the pen at the current position. */
  abort() {
    this.aborted = true;
    if (this.phase === 'draw') {
      this.pen.penUp();
      this.phase = 'depart';
    }
  }

  /** Observation mode: hop between attention points with the pen lifted. */
  observe(points: [number, number][], dwell = 0.4) {
    this.queue.length = 0;
    this.hoverQueue = points.slice();
    this.hoverDwell = dwell;
    this.phase = 'hover';
    this.pen.penUp();
    this.pen.setSpeed(0);
    this.hopNext();
  }

  get busy() {
    return this.phase !== 'idle';
  }

  private hopNext() {
    const p = this.hoverQueue.shift();
    if (!p) {
      this.phase = 'idle';
      return;
    }
    const d = dist(this.pen.x, this.pen.y, p[0], p[1]);
    this.mj = startMinJerk(this.pen.x, this.pen.y, p[0], p[1], Math.max(0.14, fittsTime(d, 8, 0.14, 0.11)));
    this.pen.setSpeed(this.pen.maxSpeed * 0.22);
  }

  private begin(plan: StrokePlan) {
    this.current = plan;
    // Resample for even motor execution; tiny strokes keep their vertices.
    const raw = plan.pts;
    this.pts = raw.length > 6 ? resample(raw, Math.max(1.2, 2.2 - plan.importance * 0.0006)) : raw;
    this.arc = arcLengths(this.pts);
    this.total = this.arc[this.arc.length - 1];
    const n = this.pts.length / 2;
    this.kappa = new Float32Array(n);
    const sorted: number[] = [];
    for (let i = 0; i < n; i++) {
      this.kappa[i] = curvatureAt(this.pts, i);
      sorted.push(this.kappa[i]);
    }
    sorted.sort((a, b) => a - b);
    this.kappaRef = Math.max(0.004, sorted[n >> 1] || 0.01);
    this.shape = new SpeedShape(plan.lognormal * this.motorWeight, this.rng.next() * 6.28);
    this.s = 0;
    this.submoves.length = 0;
    this.submoveCooldown = 0;
    this.drawn = 0;
    this.meanP = 0;
    this.pN = 0;
    this.maxDev = 0;
    this.aborted = false;
    this.firstContact = true;
    this.stallS = 0;
    this.stallSteps = 0;
    // Travel to the stroke start — tool swaps happen while the hand moves.
    this.pen.equip(plan.instrument);
    this.pen.penUp();
    const d = dist(this.pen.x, this.pen.y, this.pts[0], this.pts[1]);
    const T = Math.max(0.1, fittsTime(d, 3.2, 0.16, 0.13) * (1.25 - 0.3 * this.motorWeight));
    this.mj = startMinJerk(this.pen.x, this.pen.y, this.pts[0], this.pts[1], T);
    this.pen.setSpeed(this.pen.maxSpeed * 0.85);
    this.phase = 'travel';
  }

  /** Project the pen onto the path within a window around s. */
  private project(sLo: number, sHi: number): { s: number; dev: number } {
    const pts = this.pts,
      arc = this.arc,
      n = arc.length;
    let lo = 0,
      hi = n - 1;
    // bracket vertices for sLo
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arc[mid] <= sLo) lo = mid;
      else hi = mid;
    }
    let bestS = this.s,
      bestD = Infinity;
    let i = lo;
    while (i < n - 1 && arc[i] <= sHi) {
      const ax = pts[2 * i],
        ay = pts[2 * i + 1],
        bx = pts[2 * i + 2],
        by = pts[2 * i + 3];
      const vx = bx - ax,
        vy = by - ay;
      const len2 = vx * vx + vy * vy || 1e-9;
      let t = ((this.pen.x - ax) * vx + (this.pen.y - ay) * vy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + vx * t,
        py = ay + vy * t;
      const d = Math.hypot(this.pen.x - px, this.pen.y - py);
      if (d < bestD) {
        bestD = d;
        bestS = arc[i] + Math.sqrt(len2) * t;
      }
      i++;
    }
    if (bestD === Infinity) {
      // window degenerated (very short path): clamp to total
      bestS = Math.min(this.total, Math.max(0, this.s));
      bestD = dist(this.pen.x, this.pen.y, pts[2 * n - 2], pts[2 * n - 1]);
    }
    return { s: bestS, dev: bestD };
  }

  private kappaAt(s: number): number {
    const n = this.kappa.length;
    if (!n) return 0;
    // vertex nearest to arc position s
    let lo = 0,
      hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.arc[mid] <= s) lo = mid;
      else hi = mid;
    }
    return this.kappa[lo];
  }

  step(dt: number, deposit: (blot: number) => void) {
    const pen = this.pen;
    switch (this.phase) {
      case 'idle': {
        const plan = this.queue.shift();
        if (plan) this.begin(plan);
        break;
      }
      case 'hover': {
        if (this.mj) {
          const [x, y, done] = stepMinJerk(this.mj, dt);
          pen.moveTo(x, y);
          if (done) {
            this.mj = null;
            this.hoverDwell -= dt;
          }
        } else {
          this.hoverDwell -= dt;
          pen.setSpeed(0);
          if (this.hoverDwell <= 0) {
            this.hoverDwell = 0.4;
            this.hopNext();
          }
        }
        break;
      }
      case 'travel': {
        if (!this.current) {
          this.phase = 'idle';
          break;
        }
        if (this.mj) {
          const [x, y, done] = stepMinJerk(this.mj, dt);
          pen.moveTo(x, y);
          pen.setTilt(0.34);
          if (done) {
            this.mj = null;
            // settle check: a corrective hop when the pen over/undershoots
            const d = dist(pen.x, pen.y, this.pts[0], this.pts[1]);
            if (d > 1.6) {
              this.mj = startMinJerk(pen.x, pen.y, this.pts[0], this.pts[1], Math.max(0.06, d / 260));
            } else {
              this.phase = 'approach';
              pen.setSpeed(30);
            }
          }
        } else {
          this.phase = 'approach';
          pen.setSpeed(30);
        }
        break;
      }
      case 'approach': {
        // Descend onto the start point; contact begins the stroke.
        pen.moveTo(this.pts[0], this.pts[1]);
        pen.setSpeed(26);
        pen.setPressure(this.current!.pressure.entry);
        pen.setTilt(0.2 + 0.06 * this.rng.next());
        if (!pen.down) pen.penDown();
        if (pen.contact) {
          this.phase = 'draw';
          this.strokesStarted++;
          this.lastX = pen.x;
          this.lastY = pen.y;
          this.s = 0;
          this.hooks.onStrokeStart?.(this.current!);
          deposit(this.firstContact ? 1 : 0);
          this.firstContact = false;
        }
        break;
      }
      case 'draw': {
        const plan = this.current!;
        const proj = this.project(Math.max(0, this.s - 5), this.s + Math.max(10, Math.hypot(pen.vx, pen.vy) * dt * 2 + 8));
        this.s = Math.max(this.s, Math.min(this.total, proj.s));
        this.maxDev = Math.max(this.maxDev, proj.dev);
        const s01 = this.total > 0 ? this.s / this.total : 1;
        // --- speed: lognormal shape × two-thirds power law × end taper ----
        let v = plan.baseSpeed * this.shape.at(s01);
        v *= powerLawFactor(this.kappaAt(this.s), this.kappaRef, this.motorWeight * plan.powerLaw);
        const remaining = this.total - this.s;
        if (remaining < 10) v = Math.min(v, 24 + remaining * 7);
        v = Math.max(9, v);
        // --- steering: pure pursuit on a lookahead point -------------------
        const look = Math.max(2.4, Math.min(15, v * 0.11));
        pointAtArc(this.pts, this.arc, Math.min(this.total, this.s + look), this.probe);
        const [sox, soy] = stepSubmovements(this.submoves, dt);
        // corrective submovement when tracking error grows — never for
        // eraser sweeps, whose parallel rows are closer than the tolerance
        this.submoveCooldown -= dt;
        if (proj.dev > 3.1 && plan.layer !== 'erasure' && this.submoveCooldown <= 0 && this.motorWeight > 0.25) {
          pointAtArc(this.pts, this.arc, Math.min(this.total, this.s + 2), this.probe);
          const ex = this.probe[0] - pen.x,
            ey = this.probe[1] - pen.y;
          addSubmovement(this.submoves, ex * 0.6, ey * 0.6, 0.085 + this.rng.next() * 0.045);
          this.submoveCooldown = 0.13;
        }
        pen.moveTo(this.probe[0] + sox, this.probe[1] + soy);
        pen.setSpeed(v * 1.25); // headroom so pursuit tracks the profile
        pen.setPressure(pressureAt(s01, plan.pressure));
        pen.setAzimuth(Math.atan2(this.probe[3], this.probe[2]) + 0.55);
        deposit(0);
        this.meanP += pen.pressure;
        this.pN++;
        this.drawn += Math.hypot(pen.x - this.lastX, pen.y - this.lastY);
        this.lastX = pen.x;
        this.lastY = pen.y;
        // stall watchdog: a hand can hunt a pathological path forever —
        // if the pen stops making progress along the arc, end the stroke.
        if (this.s - this.stallS > 0.4) {
          this.stallS = this.s;
          this.stallSteps = 0;
        } else if (++this.stallSteps > 0.55 / dt) {
          this.aborted = true;
        }
        if (this.aborted || this.s >= this.total - 0.9 || (this.queue.length > 64 && this.s > this.total * 0.5)) {
          pen.penUp();
          this.phase = 'depart';
        }
        break;
      }
      case 'depart': {
        if (!this.current) {
          this.phase = 'idle';
          break;
        }
        // Rise from the paper; the stroke ends once the nib is clear.
        pen.setPressure(0);
        pen.setSpeed(this.pen.maxSpeed * 0.5);
        if (pen.z > LIFT_HEIGHT * 0.55) {
          this.strokesEnded++;
          this.hooks.onStrokeEnd?.({
            plan: this.current,
            drawn: this.drawn,
            meanPressure: this.pN ? this.meanP / this.pN : 0,
            maxDeviation: this.maxDev,
            aborted: this.aborted,
          });
          this.current = null;
          this.phase = 'idle';
        }
        break;
      }
    }
  }
}
