// The V4 Virtual Pen (spec §3). A physical object with persistent state:
// position, height above the canvas, contact, pressure, velocity,
// acceleration, direction, tilt, azimuth, nib and deposition character.
//
// The pen contains NO image-analysis intelligence. It only responds to
// low-level commands from the hand controller and integrates physics:
//   • horizontal motion steers toward the commanded point under a
//     velocity cap and a hard acceleration limit (no teleporting),
//   • vertical motion moves at a finite nib speed (touch-down / lift-off
//     take real time),
//   • pressure follows a first-order lag — a nib cannot step instantly,
//   • marks can only appear while the nib is in contact, which can only
//     happen while the controller has commanded pen-down.

import { instruments, type Instrument } from './instruments';
import type { InstrumentId } from './types';

export const LIFT_HEIGHT = 3.2; // mm of air between nib and paper while travelling
const CONTACT_Z = 0.05; // mm; below this the nib touches
const PRESSURE_TAU_UP = 0.038; // s
const PRESSURE_TAU_DOWN = 0.055; // s;

export type PenEvent = 'down' | 'up' | 'instrument';

export interface PenTelemetry {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  speed: number;
  accel: number;
  direction: number;
  contact: boolean;
  pressure: number;
  tilt: number;
  azimuth: number;
  nib: number;
  instrument: InstrumentId;
}

export class VirtualPen {
  // --- state (all persistent) -------------------------------------------
  x = 0;
  y = 0;
  z = LIFT_HEIGHT;
  vx = 0;
  vy = 0;
  ax = 0;
  ay = 0;
  direction = 0;
  pressure = 0;
  tilt = 0.18;
  azimuth = Math.PI / 2;
  down = false;
  contact = false;
  instrumentId: InstrumentId = 'graphite';
  nibScale = 1;
  travelTotal = 0;
  travelAir = 0;
  /** Events raised since the last drain, for the recorder. */
  events: PenEvent[] = [];

  // --- commanded targets --------------------------------------------------
  private tx = 0;
  private ty = 0;
  private tz = LIFT_HEIGHT;
  private tpressure = 0;
  private ttilt = 0.18;
  private tazimuth = Math.PI / 2;
  private speedCap = 400;
  maxSpeed: number;
  maxAccel: number;
  zRate = 46; // mm/s vertical nib speed

  constructor(canvasMin: number) {
    // Physical ceilings scale with the working canvas (≈ arm reach).
    this.maxSpeed = 2200 + 2.2 * canvasMin;
    this.maxAccel = 52000 + 62 * canvasMin;
  }

  // --- low-level control interface (spec §3) ------------------------------
  moveTo(x: number, y: number): void {
    this.tx = x;
    this.ty = y;
  }
  setHeight(z: number): void {
    this.tz = Math.max(0, z);
  }
  penDown(): void {
    if (!this.down) {
      this.down = true;
      this.events.push('down');
      this.tz = 0;
    }
  }
  penUp(): void {
    if (this.down) {
      this.down = false;
      this.events.push('up');
      this.tpressure = 0;
      this.tz = LIFT_HEIGHT;
    }
  }
  setPressure(pressure: number): void {
    this.tpressure = Math.max(0, Math.min(1, pressure));
  }
  setTilt(tilt: number): void {
    this.ttilt = Math.max(0, Math.min(1.05, tilt));
  }
  setAzimuth(angle: number): void {
    this.tazimuth = angle;
  }
  setSpeed(speed: number): void {
    this.speedCap = Math.max(0, speed);
  }
  equip(id: InstrumentId): void {
    if (id !== this.instrumentId) {
      this.instrumentId = id;
      this.events.push('instrument');
    }
  }
  get instrument(): Instrument {
    return instruments[this.instrumentId];
  }
  /** Effective nib size in working px (instrument × canvas scale). */
  get nib(): number {
    return this.instrument.nib * this.nibScale;
  }
  target(): { x: number; y: number } {
    return { x: this.tx, y: this.ty };
  }

  drainEvents(): PenEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  // --- physics integration -------------------------------------------------
  update(deltaTime: number): void {
    const dt = Math.min(0.05, Math.max(1e-4, deltaTime));

    // 1. Horizontal: steer toward the commanded point under the speed cap,
    //    with a hard acceleration limit. A critically-damped pursuit law
    //    (v_des = min(cap, dist/τ)) gives smooth, physical convergence.
    const dx = this.tx - this.x,
      dy = this.ty - this.y;
    const dist = Math.hypot(dx, dy);
    const tau = 0.045;
    let vdx = 0,
      vdy = 0;
    if (dist > 1e-6) {
      const v = Math.min(this.speedCap, this.maxSpeed, dist / tau);
      vdx = (dx / dist) * v;
      vdy = (dy / dist) * v;
    }
    const ax = (vdx - this.vx) / dt,
      ay = (vdy - this.vy) / dt;
    const amag = Math.hypot(ax, ay);
    const clampA = this.maxAccel;
    const scale = amag > clampA ? clampA / amag : 1;
    this.ax = ax * scale;
    this.ay = ay * scale;
    this.vx += this.ax * dt;
    this.vy += this.ay * dt;
    const sp = Math.hypot(this.vx, this.vy);
    if (sp > this.maxSpeed) {
      this.vx *= this.maxSpeed / sp;
      this.vy *= this.maxSpeed / sp;
    }
    const px = this.x,
      py = this.y;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // 2. Vertical height: finite nib speed both ways.
    const dz = this.tz - this.z;
    const maxDz = this.zRate * dt;
    this.z += Math.abs(dz) <= maxDz ? dz : Math.sign(dz) * maxDz;

    // 3. Contact state: only while the controller wants the pen down AND the
    //    nib has physically reached the paper.
    this.contact = this.down && this.z <= CONTACT_Z;

    // 4. Pressure: first-order lag (attack slightly faster than release).
    const target = this.contact ? this.tpressure : 0;
    const k = target > this.pressure ? PRESSURE_TAU_UP : PRESSURE_TAU_DOWN;
    this.pressure += (target - this.pressure) * (1 - Math.exp(-dt / k));
    if (this.pressure < 1e-4) this.pressure = 0;

    // 5. Direction of travel.
    if (sp > 2) this.direction = Math.atan2(this.vy, this.vx);

    // 6. Tilt / azimuth relax toward commanded pose.
    this.tilt += (this.ttilt - this.tilt) * (1 - Math.exp(-dt / 0.09));
    let da = this.tazimuth - this.azimuth;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    this.azimuth += da * (1 - Math.exp(-dt / 0.09));

    // 7. Travel bookkeeping (air vs contact).
    const moved = Math.hypot(this.x - px, this.y - py);
    this.travelTotal += moved;
    if (!this.contact) this.travelAir += moved;
  }

  telemetry(): PenTelemetry {
    return {
      x: this.x,
      y: this.y,
      z: this.z,
      vx: this.vx,
      vy: this.vy,
      speed: Math.hypot(this.vx, this.vy),
      accel: Math.hypot(this.ax, this.ay),
      direction: this.direction,
      contact: this.contact,
      pressure: this.pressure,
      tilt: this.tilt,
      azimuth: this.azimuth,
      nib: this.nib,
      instrument: this.instrumentId,
    };
  }
}
