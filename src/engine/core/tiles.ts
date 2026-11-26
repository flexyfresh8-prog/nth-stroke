/**
 * Tile grid: dirty-region tracker + spatial index.
 * The canvas is divided into tiles (32px). The media engine marks tiles it
 * touches; compositing re-renders only dirty tiles (spec §14).
 * The stroke index maps tiles → op ids touching them for localized queries.
 */

export const TILE = 32;

export class TileGrid {
  readonly cols: number;
  readonly rows: number;
  private dirty: Uint8Array;
  /** tile index → op ids that touched it (spatial index, spec §14). */
  private index: Map<number, Set<number>> = new Map();

  constructor(readonly width: number, readonly height: number) {
    this.cols = Math.max(1, Math.ceil(width / TILE));
    this.rows = Math.max(1, Math.ceil(height / TILE));
    this.dirty = new Uint8Array(this.cols * this.rows);
  }

  private tileAt(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / TILE)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / TILE)));
    return cy * this.cols + cx;
  }

  markPoint(x: number, y: number, radius: number, opId?: number) {
    const x0 = Math.max(0, Math.floor((x - radius) / TILE));
    const x1 = Math.min(this.cols - 1, Math.floor((x + radius) / TILE));
    const y0 = Math.max(0, Math.floor((y - radius) / TILE));
    const y1 = Math.min(this.rows - 1, Math.floor((y + radius) / TILE));
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const t = ty * this.cols + tx;
        this.dirty[t] = 1;
        if (opId !== undefined) {
          let set = this.index.get(t);
          if (!set) {
            set = new Set();
            this.index.set(t, set);
          }
          set.add(opId);
        }
      }
    }
  }

  markPath(points: Array<{ x: number; y: number }>, radius: number, opId?: number) {
    for (const p of points) this.markPoint(p.x, p.y, radius, opId);
  }

  /** All tiles currently dirty; clears the flags. */
  takeDirtyTiles(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.dirty.length; i++) {
      if (this.dirty[i]) {
        out.push(i);
        this.dirty[i] = 0;
      }
    }
    return out;
  }

  peekDirtyCount(): number {
    let n = 0;
    for (let i = 0; i < this.dirty.length; i++) n += this.dirty[i];
    return n;
  }

  /** Bounding box of currently dirty tiles (or null). */
  dirtyBounds(): { x: number; y: number; w: number; h: number } | null {
    let minX = this.cols, minY = this.rows, maxX = -1, maxY = -1;
    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        if (!this.dirty[ty * this.cols + tx]) continue;
        if (tx < minX) minX = tx;
        if (tx > maxX) maxX = tx;
        if (ty < minY) minY = ty;
        if (ty > maxY) maxY = ty;
      }
    }
    if (maxX < 0) return null;
    return {
      x: minX * TILE,
      y: minY * TILE,
      w: (maxX - minX + 1) * TILE,
      h: (maxY - minY + 1) * TILE,
    };
  }

  /** Op ids whose footprint intersects a disc (spatial query). */
  opsNear(x: number, y: number, radius: number): Set<number> {
    const result = new Set<number>();
    const x0 = Math.max(0, Math.floor((x - radius) / TILE));
    const x1 = Math.min(this.cols - 1, Math.floor((x + radius) / TILE));
    const y0 = Math.max(0, Math.floor((y - radius) / TILE));
    const y1 = Math.min(this.rows - 1, Math.floor((y + radius) / TILE));
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const set = this.index.get(ty * this.cols + tx);
        if (set) for (const id of set) result.add(id);
      }
    }
    return result;
  }

  /** Forget an op (after erasure) so stale entries don't accumulate. */
  forget(opId: number) {
    for (const set of this.index.values()) set.delete(opId);
  }
}
