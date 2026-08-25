// world.js — the baked place, and every question the game asks about it.
//
// Pure data + maths. NO three.js, NO DOM, NO randomness. Both the deterministic
// sim and the renderer read from here, so anything that lands in this file must
// give the same answer on every machine.
//
// Axis convention (see geo.js): +x east, +y up, +z south.

const KINDS = ['residential', 'commercial', 'industrial', 'civic', 'minor', 'other'];

export class World {
  constructor(raw) {
    this.raw = raw;
    this.name = raw.name;
    this.label = raw.label || raw.name;
    this.origin = raw.origin;
    this.width = raw.size.width;
    this.depth = raw.size.depth;

    const t = raw.terrain;
    this.cols = t.cols; this.rows = t.rows; this.cell = t.cell;
    this.minH = t.minH; this.maxH = t.maxH;
    this.heights = Float32Array.from(t.heights);

    this.buildings = raw.buildings;
    this.roads = raw.roads;
    this.areas = raw.areas;
    this.waterways = raw.waterways || [];
    this.rails = raw.rails || [];
    this.pois = raw.pois || [];
    this.meta = raw.meta;

    // world-space bounds (centred on the origin)
    this.x0 = -this.width / 2;
    this.z0 = -this.depth / 2;

    this._buildRoadDistance();
    this._buildBuildingIndex();
  }

  static async load(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`world "${url}" -> HTTP ${r.status}`);
    return new World(await r.json());
  }

  // ─── terrain ──────────────────────────────────────────────────────────────

  /** Grid coordinates (fractional) for a world point. */
  _grid(x, z) {
    return { fi: (x - this.x0) / this.cell, fj: (z - this.z0) / this.cell };
  }

  inBounds(x, z) {
    return x >= this.x0 && x <= this.x0 + this.width && z >= this.z0 && z <= this.z0 + this.depth;
  }

  /**
   * Terrain elevation in metres. Clamps at the edges.
   *
   * ⚠️⚠️ THIS IS PIECEWISE-LINEAR OVER THE SAME TRIANGLE SPLIT THE TERRAIN MESH
   * USES — deliberately NOT bilinear, and it must stay that way.
   *
   * A grid cell rendered as two triangles is NOT the same surface as the
   * bilinear patch through its four corners; they differ by the cell's twist
   * term, ((h00+h11) - (h01+h10))/4 at the centre. Measured on real SF terrain
   * with 10 m cells that reached 0.28 m — larger than the offset we drape roads
   * at, so every road sank into the ground and rendered invisible. The symptom
   * looks like a colour or lighting bug and is neither.
   *
   * The mesh in view.buildTerrain() emits triangles (a,d,b) and (b,d,e) where
   * a=(i,j) b=(i+1,j) d=(i,j+1) e=(i+1,j+1), so the shared edge is d–b and the
   * split is dx+dz = 1. Anything that drapes on the ground samples through here,
   * so sampler and mesh agree to the float — and small offsets are then safe.
   */
  heightAt(x, z) {
    const { fi, fj } = this._grid(x, z);
    const i = Math.max(0, Math.min(this.cols - 2, Math.floor(fi)));
    const j = Math.max(0, Math.min(this.rows - 2, Math.floor(fj)));
    const dx = Math.max(0, Math.min(1, fi - i));
    const dz = Math.max(0, Math.min(1, fj - j));
    const h = this.heights, c = this.cols;
    const h00 = h[j * c + i], h10 = h[j * c + i + 1];
    const h01 = h[(j + 1) * c + i], h11 = h[(j + 1) * c + i + 1];

    return dx + dz <= 1
      ? h00 + dx * (h10 - h00) + dz * (h01 - h00)               // triangle a,d,b
      : h11 + (1 - dx) * (h01 - h11) + (1 - dz) * (h10 - h11);  // triangle b,d,e
  }

  /** Upward surface normal, from central differences. */
  normalAt(x, z) {
    const d = this.cell;
    const hx = this.heightAt(x + d, z) - this.heightAt(x - d, z);
    const hz = this.heightAt(x, z + d) - this.heightAt(x, z - d);
    const nx = -hx / (2 * d), nz = -hz / (2 * d);
    const len = Math.hypot(nx, 1, nz);
    return { x: nx / len, y: 1 / len, z: nz / len };
  }

  /** Ground slope as a rise/run fraction — 0.31 is a famously steep SF street. */
  slopeAt(x, z) {
    const d = this.cell;
    const hx = (this.heightAt(x + d, z) - this.heightAt(x - d, z)) / (2 * d);
    const hz = (this.heightAt(x, z + d) - this.heightAt(x, z - d)) / (2 * d);
    return Math.hypot(hx, hz);
  }

  // ─── road access ──────────────────────────────────────────────────────────

  /**
   * Distance (metres) from any point to the nearest road centreline, as a grid.
   * Built once at load with a two-pass chamfer transform — a building with no
   * road access is a real city-builder constraint, and this is how we ask.
   */
  _buildRoadDistance() {
    const c = this.cols, r = this.rows, cell = this.cell;
    const BIG = 1e6;
    const d = new Float32Array(c * r).fill(BIG);

    const mark = (x, z) => {
      const i = Math.round((x - this.x0) / cell);
      const j = Math.round((z - this.z0) / cell);
      if (i >= 0 && i < c && j >= 0 && j < r) d[j * c + i] = 0;
    };

    // Rasterise each road, stepping along segments at ~half a cell so we never
    // leave gaps on a diagonal.
    for (const road of this.roads) {
      if (road.k === 'foot') continue;          // footpaths are not vehicle access
      const p = road.pts;
      for (let i = 0; i < p.length - 2; i += 2) {
        const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3];
        const len = Math.hypot(bx - ax, bz - az);
        const steps = Math.max(1, Math.ceil(len / (cell * 0.5)));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          mark(ax + (bx - ax) * t, az + (bz - az) * t);
        }
      }
    }

    // Chamfer 3×3: orthogonal 1.0, diagonal √2, scaled to metres.
    const O = cell, D = cell * Math.SQRT2;
    for (let j = 0; j < r; j++) for (let i = 0; i < c; i++) {
      const k = j * c + i;
      let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + O);
      if (j > 0) v = Math.min(v, d[k - c] + O);
      if (i > 0 && j > 0) v = Math.min(v, d[k - c - 1] + D);
      if (i < c - 1 && j > 0) v = Math.min(v, d[k - c + 1] + D);
      d[k] = v;
    }
    for (let j = r - 1; j >= 0; j--) for (let i = c - 1; i >= 0; i--) {
      const k = j * c + i;
      let v = d[k];
      if (i < c - 1) v = Math.min(v, d[k + 1] + O);
      if (j < r - 1) v = Math.min(v, d[k + c] + O);
      if (i < c - 1 && j < r - 1) v = Math.min(v, d[k + c + 1] + D);
      if (i > 0 && j < r - 1) v = Math.min(v, d[k + c - 1] + D);
      d[k] = v;
    }
    this.roadDist = d;
  }

  /** Metres to the nearest drivable road. Bilinear over the chamfer grid. */
  roadDistAt(x, z) {
    const { fi, fj } = this._grid(x, z);
    const i = Math.max(0, Math.min(this.cols - 2, Math.floor(fi)));
    const j = Math.max(0, Math.min(this.rows - 2, Math.floor(fj)));
    const dx = Math.max(0, Math.min(1, fi - i));
    const dz = Math.max(0, Math.min(1, fj - j));
    const d = this.roadDist, c = this.cols;
    return d[j * c + i] * (1 - dx) * (1 - dz) + d[j * c + i + 1] * dx * (1 - dz)
         + d[(j + 1) * c + i] * (1 - dx) * dz + d[(j + 1) * c + i + 1] * dx * dz;
  }

  // ─── buildings ────────────────────────────────────────────────────────────

  /** Uniform bucket grid over building bounds, for fast point lookup. */
  _buildBuildingIndex() {
    const BUCKET = 40; // metres
    this._bucket = BUCKET;
    this._bCols = Math.ceil(this.width / BUCKET) + 1;
    this._bRows = Math.ceil(this.depth / BUCKET) + 1;
    const idx = new Map();

    this.buildings.forEach((b, n) => {
      const r = b.ring;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < r.length; i += 2) {
        if (r[i] < x0) x0 = r[i]; if (r[i] > x1) x1 = r[i];
        if (r[i + 1] < z0) z0 = r[i + 1]; if (r[i + 1] > z1) z1 = r[i + 1];
      }
      b._bb = [x0, z0, x1, z1];
      const i0 = Math.max(0, Math.floor((x0 - this.x0) / BUCKET));
      const i1 = Math.min(this._bCols - 1, Math.floor((x1 - this.x0) / BUCKET));
      const j0 = Math.max(0, Math.floor((z0 - this.z0) / BUCKET));
      const j1 = Math.min(this._bRows - 1, Math.floor((z1 - this.z0) / BUCKET));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const k = j * this._bCols + i;
        if (!idx.has(k)) idx.set(k, []);
        idx.get(k).push(n);
      }
    });
    this._bIndex = idx;
  }

  /** The building whose footprint contains (x, z), or null. */
  buildingAt(x, z) {
    const i = Math.floor((x - this.x0) / this._bucket);
    const j = Math.floor((z - this.z0) / this._bucket);
    const list = this._bIndex.get(j * this._bCols + i);
    if (!list) return null;
    for (const n of list) {
      const b = this.buildings[n];
      const bb = b._bb;
      if (x < bb[0] || x > bb[2] || z < bb[1] || z > bb[3]) continue;
      if (pointInRing(x, z, b.ring)) return b;
    }
    return null;
  }

  /** Summary the UI can print without knowing the schema. */
  stats() {
    const byKind = {};
    for (const k of KINDS) byKind[k] = 0;
    for (const b of this.buildings) byKind[b.kind] = (byKind[b.kind] || 0) + 1;
    let roadKm = 0;
    for (const r of this.roads) {
      const p = r.pts;
      for (let i = 0; i < p.length - 2; i += 2) roadKm += Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
    }
    return {
      buildings: this.buildings.length, byKind,
      roadKm: roadKm / 1000,
      relief: this.maxH - this.minH,
      areaKm2: (this.width * this.depth) / 1e6,
    };
  }
}

/** Ray-cast point-in-polygon over a flat [x,z,…] ring. */
export function pointInRing(px, pz, r) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
    if ((zi > pz) !== (zj > pz) && px < (xj - xi) * (pz - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
