// field.js — scalar fields over the terrain grid.
//
// Pure: no three.js, no DOM, no randomness. The sim leans on these heavily —
// "how far is the nearest road / park / school / factory" is most of what makes
// one plot of a real town more desirable than another.

/**
 * Two-pass chamfer distance transform.
 *
 * `seed(i, j)` returns true for cells that are AT distance zero (on a road, in
 * a park…). Result is metres, bilinearly samplable via sampleField().
 *
 * The 3×3 chamfer is an approximation — worst-case error against true Euclidean
 * distance is about 4%, which is far below the resolution the game reasons at,
 * and it costs two linear passes instead of a full Voronoi.
 */
export function chamfer(cols, rows, cell, seed) {
  const BIG = 1e6;
  const d = new Float32Array(cols * rows).fill(BIG);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) if (seed(i, j)) d[j * cols + i] = 0;
  }
  return chamferFrom(d, cols, rows, cell);
}

/** Run the transform over a pre-seeded array (0 = source, BIG = unknown). */
export function chamferFrom(d, cols, rows, cell) {
  const O = cell, D = cell * Math.SQRT2;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i;
    let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + O);
    if (j > 0) v = Math.min(v, d[k - cols] + O);
    if (i > 0 && j > 0) v = Math.min(v, d[k - cols - 1] + D);
    if (i < cols - 1 && j > 0) v = Math.min(v, d[k - cols + 1] + D);
    d[k] = v;
  }
  for (let j = rows - 1; j >= 0; j--) for (let i = cols - 1; i >= 0; i--) {
    const k = j * cols + i;
    let v = d[k];
    if (i < cols - 1) v = Math.min(v, d[k + 1] + O);
    if (j < rows - 1) v = Math.min(v, d[k + cols] + O);
    if (i < cols - 1 && j < rows - 1) v = Math.min(v, d[k + cols + 1] + D);
    if (i > 0 && j < rows - 1) v = Math.min(v, d[k + cols - 1] + D);
    d[k] = v;
  }
  return d;
}

/** Bilinear sample of a grid field at world coordinates. */
export function sampleField(field, cols, rows, cell, x0, z0, x, z) {
  const fi = (x - x0) / cell, fj = (z - z0) / cell;
  const i = Math.max(0, Math.min(cols - 2, Math.floor(fi)));
  const j = Math.max(0, Math.min(rows - 2, Math.floor(fj)));
  const dx = Math.max(0, Math.min(1, fi - i));
  const dz = Math.max(0, Math.min(1, fj - j));
  return field[j * cols + i] * (1 - dx) * (1 - dz)
       + field[j * cols + i + 1] * dx * (1 - dz)
       + field[(j + 1) * cols + i] * (1 - dx) * dz
       + field[(j + 1) * cols + i + 1] * dx * dz;
}

/**
 * Rasterise a polyline (flat [x,z,…]) into a seed array, stepping at half a
 * cell so diagonals never leave gaps.
 */
export function stampPolyline(d, cols, rows, cell, x0, z0, pts) {
  for (let i = 0; i < pts.length - 2; i += 2) {
    const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (cell * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const gi = Math.round((ax + (bx - ax) * t - x0) / cell);
      const gj = Math.round((az + (bz - az) * t - z0) / cell);
      if (gi >= 0 && gi < cols && gj >= 0 && gj < rows) d[gj * cols + gi] = 0;
    }
  }
}

/** Stamp a single world point into a seed array. */
export function stampPoint(d, cols, rows, cell, x0, z0, x, z) {
  const gi = Math.round((x - x0) / cell), gj = Math.round((z - z0) / cell);
  if (gi >= 0 && gi < cols && gj >= 0 && gj < rows) d[gj * cols + gi] = 0;
}

/**
 * Which cells are under water at `level`, flooding inward FROM THE MAP EDGE.
 *
 * ⚠️ This is a connected flood fill, not a simple `height <= level` test, and
 * the difference is the whole point: a quarry, a sunken plaza or a dry valley
 * floor can sit below sea level and must stay DRY unless the sea can actually
 * reach it. Testing height alone fills inland hollows with ocean and the map
 * immediately looks wrong to anyone who knows the place.
 *
 * Returns a Uint8Array mask, 1 = flooded.
 */
export function floodFromEdges(heights, cols, rows, level) {
  const mask = new Uint8Array(cols * rows);
  if (!(level > -Infinity)) return mask;

  // Ring buffer queue — a plain array with shift() is O(n) per pop and this can
  // touch every cell on a big map.
  const queue = new Int32Array(cols * rows);
  let head = 0, tail = 0;

  // ⚠️ STRICTLY BELOW, not <=. Ground sitting exactly AT the waterline is dry
  // land, not sea. With <=, a town whose terrain is flat at 0 m floods entirely
  // the moment sea level is 0 — which is the default — and the whole map drowns
  // before the player touches anything.
  const push = k => { if (!mask[k] && heights[k] < level) { mask[k] = 1; queue[tail++] = k; } };

  for (let i = 0; i < cols; i++) { push(i); push((rows - 1) * cols + i); }
  for (let j = 0; j < rows; j++) { push(j * cols); push(j * cols + cols - 1); }

  while (head < tail) {
    const k = queue[head++];
    const i = k % cols, j = (k / cols) | 0;
    if (i > 0) push(k - 1);
    if (i < cols - 1) push(k + 1);
    if (j > 0) push(k - cols);
    if (j < rows - 1) push(k + cols);
  }
  return mask;
}

/** Nearest-cell lookup into a mask. */
export function maskAt(mask, cols, rows, cell, x0, z0, x, z) {
  const i = Math.round((x - x0) / cell), j = Math.round((z - z0) / cell);
  if (i < 0 || i >= cols || j < 0 || j >= rows) return 0;
  return mask[j * cols + i];
}
