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
