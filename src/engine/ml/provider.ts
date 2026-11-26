/**
 * ML provider layer (spec §3 — "lightweight local computer vision models").
 *
 * The engine consumes semantic evidence through this interface only. The
 * browser implementation lazy-loads bundled MediaPipe Tasks models (face
 * landmarker, pose landmarker, DeepLab segmentation) that run fully locally
 * in the worker; Node tests inject synthetic fixtures instead. If models
 * fail to load, the engine degrades gracefully to classical-only analysis.
 */

import type { Vec2 } from '../core/types';

/** 478-point MediaPipe face landmarks (normalized 0..1 image space). */
export interface FaceObservation {
  landmarks: Vec2[];
  score: number;
}

/** 33-point MediaPipe pose landmarks (normalized, 0 = nose). */
export interface PoseObservation {
  landmarks: Vec2[];
  score: number;
}

export interface SegmentationObservation {
  /** cols × rows class map, analysis resolution. */
  width: number;
  height: number;
  /** 0 = background, 1..15 = DeepLab classes (person=15, animal=8…). */
  classes: Uint8Array;
  /** Fraction of pixels that belong to a non-background class. */
  foregroundRatio: number;
}

export interface MlProvider {
  face(input: ImageLike): Promise<FaceObservation | null>;
  pose(input: ImageLike): Promise<PoseObservation | null>;
  segment(input: ImageLike, width: number, height: number): Promise<SegmentationObservation | null>;
  /** Load models ahead of first use (browser provider only). */
  ensureLoaded?(): Promise<void>;
}

/** Image source accepted by the browser models. */
export type ImageLike = ImageBitmap | OffscreenCanvas | HTMLCanvasElement | HTMLImageElement;

/** Provider used when models are unavailable — classical-only mode. */
export class NullMlProvider implements MlProvider {
  async ensureLoaded(): Promise<void> {}

  async face(): Promise<FaceObservation | null> {
    return null;
  }

  async pose(): Promise<PoseObservation | null> {
    return null;
  }

  async segment(): Promise<SegmentationObservation | null> {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Face landmark → Loomis / Reilly construction mapping (spec §2).     */
/* ------------------------------------------------------------------ */

export interface LoomisHead {
  /** Cranial ball. */
  center: Vec2;
  radius: number;
  /** Vertical centerline through the face (top → chin). */
  centerline: [Vec2, Vec2];
  browLine: { y: number; left: Vec2; right: Vec2 };
  eyeLine: { y: number; left: Vec2; right: Vec2 };
  noseLine: { y: number; left: Vec2; right: Vec2 };
  mouthLine: { y: number; left: Vec2; right: Vec2 };
  chin: Vec2;
  foreheadTop: Vec2;
  jawline: Vec2[];
  earLeft: Vec2;
  earRight: Vec2;
  eyes: { left: { inner: Vec2; outer: Vec2; top: Vec2; bottom: Vec2 }; right: { inner: Vec2; outer: Vec2; top: Vec2; bottom: Vec2 } };
  noseTip: Vec2;
  nostrils: { left: Vec2; right: Vec2 };
  mouthCorners: { left: Vec2; right: Vec2 };
  lips: { top: Vec2; bottom: Vec2 };
  hairline: Vec2;
}

/** MediaPipe FaceMesh indices (canonical topology). */
const IDX = {
  foreheadTop: 10,
  chin: 152,
  cheekOuterL: 234,
  cheekOuterR: 454,
  jawL: 172,
  jawR: 397,
  eyeLOuter: 33, eyeLInner: 133, eyeLTop: 159, eyeLBottom: 145,
  eyeRInner: 362, eyeROuter: 263, eyeRTop: 386, eyeRBottom: 374,
  noseTip: 1,
  nostrilL: 129, nostrilR: 358,
  mouthL: 61, mouthR: 291,
  lipTop: 13, lipBottom: 14,
  browL: 105, browR: 334,
  betweenEyes: 168,
  templeL: 127, templeR: 356,
};

export function mapLoomisHead(face: FaceObservation): LoomisHead {
  const lm = face.landmarks;
  const p = (i: number): Vec2 => lm[i] ?? lm[0] ?? { x: 0.5, y: 0.5 };
  const top = p(IDX.foreheadTop);
  const chin = p(IDX.chin);
  const cheekL = p(IDX.cheekOuterL);
  const cheekR = p(IDX.cheekOuterR);
  const headAxis = { x: chin.x - top.x, y: chin.y - top.y };
  const headHeight = Math.hypot(headAxis.x, headAxis.y) || 1;
  // Cranial ball: Loomis places the ball over the skull with the face
  // dropping below; centre sits ~1/3 down the top→chin axis.
  const center = { x: top.x + headAxis.x * 0.34, y: top.y + headAxis.y * 0.34 };
  const radius = Math.max(headHeight * 0.42, Math.hypot(cheekR.x - cheekL.x, cheekR.y - cheekL.y) * 0.62);
  const perp = { x: -headAxis.y / headHeight, y: headAxis.x / headHeight };
  const wide = (c: Vec2, k: number): [Vec2, Vec2] => [
    { x: c.x - perp.x * radius * k, y: c.y - perp.y * radius * k },
    { x: c.x + perp.x * radius * k, y: c.y + perp.y * radius * k },
  ];
  const eyeL = p(IDX.eyeLInner);
  const eyeR = p(IDX.eyeRInner);
  const browL = p(IDX.browL);
  const browR = p(IDX.browR);
  const noseTip = p(IDX.noseTip);
  const mouthL = p(IDX.mouthL);
  const mouthR = p(IDX.mouthR);
  const lineAt = (y: number, k = 1.1): { y: number; left: Vec2; right: Vec2 } => {
    const [l, r] = wide({ x: center.x, y }, k);
    return { y, left: l, right: r };
  };
  // Ear anchors: Loomis hangs the ear between brow line and nose line.
  const earOffset = radius * 0.98;
  return {
    center,
    radius,
    centerline: [top, chin],
    browLine: lineAt((browL.y + browR.y) / 2),
    eyeLine: lineAt((eyeL.y + eyeR.y) / 2),
    noseLine: lineAt(noseTip.y),
    mouthLine: lineAt((mouthL.y + mouthR.y) / 2),
    chin,
    foreheadTop: top,
    jawline: [cheekL, p(IDX.jawL), chin, p(IDX.jawR), cheekR],
    earLeft: { x: center.x - perp.x * earOffset, y: center.y + headAxis.y * 0.12 },
    earRight: { x: center.x + perp.x * earOffset, y: center.y + headAxis.y * 0.12 },
    eyes: {
      left: { inner: p(IDX.eyeLInner), outer: p(IDX.eyeLOuter), top: p(IDX.eyeLTop), bottom: p(IDX.eyeLBottom) },
      right: { inner: p(IDX.eyeRInner), outer: p(IDX.eyeROuter), top: p(IDX.eyeRTop), bottom: p(IDX.eyeRBottom) },
    },
    noseTip,
    nostrils: { left: p(IDX.nostrilL), right: p(IDX.nostrilR) },
    mouthCorners: { left: p(IDX.mouthL), right: p(IDX.mouthR) },
    lips: { top: p(IDX.lipTop), bottom: p(IDX.lipBottom) },
    hairline: top,
  };
}

/* ------------------------------------------------------------------ */
/* Pose landmarks → gesture abstraction.                               */
/* ------------------------------------------------------------------ */

export interface GestureFigure {
  /** Line of action: nose → chest → pelvis (the figure's flow). */
  spine: Vec2[];
  shoulders: [Vec2, Vec2];
  hips: [Vec2, Vec2];
  limbs: Array<{ from: Vec2; to: Vec2; label: string }>;
  headCenter: Vec2;
  headRadius: number;
}

const POSE = { nose: 0, shoulderL: 11, shoulderR: 12, elbowL: 13, elbowR: 14, wristL: 15, wristR: 16, hipL: 23, hipR: 24, kneeL: 25, kneeR: 26, ankleL: 27, ankleR: 28 };

export function mapGesture(pose: PoseObservation): GestureFigure {
  const lm = pose.landmarks;
  const p = (i: number): Vec2 => lm[i] ?? { x: 0.5, y: 0.5 };
  const shoulderMid = { x: (p(POSE.shoulderL).x + p(POSE.shoulderR).x) / 2, y: (p(POSE.shoulderL).y + p(POSE.shoulderR).y) / 2 };
  const hipMid = { x: (p(POSE.hipL).x + p(POSE.hipR).x) / 2, y: (p(POSE.hipL).y + p(POSE.hipR).y) / 2 };
  const nose = p(POSE.nose);
  const shoulderSpan = Math.hypot(p(POSE.shoulderR).x - p(POSE.shoulderL).x, p(POSE.shoulderR).y - p(POSE.shoulderL).y) || 0.12;
  return {
    spine: [nose, shoulderMid, hipMid],
    shoulders: [p(POSE.shoulderL), p(POSE.shoulderR)],
    hips: [p(POSE.hipL), p(POSE.hipR)],
    limbs: [
      { from: p(POSE.shoulderL), to: p(POSE.elbowL), label: 'upper arm L' },
      { from: p(POSE.elbowL), to: p(POSE.wristL), label: 'forearm L' },
      { from: p(POSE.shoulderR), to: p(POSE.elbowR), label: 'upper arm R' },
      { from: p(POSE.elbowR), to: p(POSE.wristR), label: 'forearm R' },
      { from: p(POSE.hipL), to: p(POSE.kneeL), label: 'thigh L' },
      { from: p(POSE.kneeL), to: p(POSE.ankleL), label: 'shin L' },
      { from: p(POSE.hipR), to: p(POSE.kneeR), label: 'thigh R' },
      { from: p(POSE.kneeR), to: p(POSE.ankleR), label: 'shin R' },
    ],
    headCenter: nose,
    headRadius: shoulderSpan * 0.62,
  };
}
