// geom.js — polygon maths for turning OSM footprints into meshes.
// Pure: no three.js, no DOM. Everything works on flat [x,z,x,z,…] rings.

/** Signed area of a flat ring. Positive = counter-clockwise in our (x,z) frame. */
export function signedArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    a += (r[j] * r[i + 1]) - (r[i] * r[j + 1]);
  }
  return a / 2;
}

function area2(ax, az, bx, bz, cx, cz) {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

function pointInTri(px, pz, ax, az, bx, bz, cx, cz) {
  const d1 = area2(px, pz, ax, az, bx, bz);
  const d2 = area2(px, pz, bx, bz, cx, cz);
  const d3 = area2(px, pz, cx, cz, ax, az);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * Ear-clipping triangulation of a simple polygon.
 * Returns a flat array of vertex INDICES (into the ring's point list, i.e. ring
 * index i corresponds to points at r[2i], r[2i+1]).
 *
 * Building footprints are simple polygons, so ear clipping is the right tool —
 * cheap, dependency-free, and robust enough. Self-intersecting rings (rare, and
 * an OSM data error when they occur) degrade to a partial fan rather than
 * hanging: the `guard` counter is what makes that true.
 *
 * ⚠️⚠️ WINDING: triangles are emitted so the face normal points UP (+y) in our
 * x-east / y-up / z-south frame. This is NOT the same as "counter-clockwise in
 * xz" — treating z as if it were a maths y-axis flips the handedness, so the
 * intuitive winding produces DOWNWARD normals and every surface silently
 * disappears to backface culling. That shipped once: roads, parks and every
 * building roof were being culled, which reads as a colour or depth bug and is
 * neither. The clipper still works in its own orientation internally; only the
 * emission order is flipped (ia, ic, ib).
 */
export function triangulate(ring) {
  const n = ring.length / 2;
  if (n < 3) return [];

  // Work counter-clockwise so the ear test has a consistent sign.
  let idx = [...Array(n).keys()];
  if (signedArea(ring) < 0) idx.reverse();

  const out = [];
  let guard = n * n + 16;

  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length];
      const ib = idx[i];
      const ic = idx[(i + 1) % idx.length];
      const ax = ring[ia * 2], az = ring[ia * 2 + 1];
      const bx = ring[ib * 2], bz = ring[ib * 2 + 1];
      const cx = ring[ic * 2], cz = ring[ic * 2 + 1];

      if (area2(ax, az, bx, bz, cx, cz) <= 0) continue;   // reflex, not an ear

      let contains = false;
      for (const ip of idx) {
        if (ip === ia || ip === ib || ip === ic) continue;
        if (pointInTri(ring[ip * 2], ring[ip * 2 + 1], ax, az, bx, bz, cx, cz)) { contains = true; break; }
      }
      if (contains) continue;

      out.push(ia, ic, ib);          // flipped so the normal points UP — see above
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;    // degenerate ring — keep what we have
  }
  if (idx.length === 3) out.push(idx[0], idx[2], idx[1]);
  return out;
}

/** A flat ring with its vertex order reversed (flips its winding). */
export function reverseRing(r) {
  const out = new Array(r.length);
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    out[i * 2] = r[(n - 1 - i) * 2];
    out[i * 2 + 1] = r[(n - 1 - i) * 2 + 1];
  }
  return out;
}

/**
 * Offset a polyline into a ribbon of the given width, returning
 * { left: [x,z,…], right: [x,z,…] } aligned to the input points.
 * Joints use the averaged segment normal — a good-enough miter for roads at
 * city scale, and it never blows up on a hairpin the way a true miter does.
 */
export function ribbon(pts, width) {
  const n = pts.length / 2;
  const half = width / 2;
  const left = new Array(n * 2), right = new Array(n * 2);

  for (let i = 0; i < n; i++) {
    const px = pts[i * 2], pz = pts[i * 2 + 1];
    let nx = 0, nz = 0;

    if (i > 0) {
      const dx = px - pts[(i - 1) * 2], dz = pz - pts[(i - 1) * 2 + 1];
      const l = Math.hypot(dx, dz) || 1;
      nx += -dz / l; nz += dx / l;
    }
    if (i < n - 1) {
      const dx = pts[(i + 1) * 2] - px, dz = pts[(i + 1) * 2 + 1] - pz;
      const l = Math.hypot(dx, dz) || 1;
      nx += -dz / l; nz += dx / l;
    }
    const l = Math.hypot(nx, nz) || 1;
    nx /= l; nz /= l;

    left[i * 2] = px + nx * half;  left[i * 2 + 1] = pz + nz * half;
    right[i * 2] = px - nx * half; right[i * 2 + 1] = pz - nz * half;
  }
  return { left, right };
}

/** Total planar length of a flat polyline. */
export function polylineLength(pts) {
  let d = 0;
  for (let i = 0; i < pts.length - 2; i += 2) d += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
  return d;
}

/**
 * Douglas–Peucker simplification of a flat polyline, tolerance in metres.
 * Used on draped geometry where a vertex every 30 cm is pure waste.
 */
export function simplify(pts, tol = 0.5) {
  const n = pts.length / 2;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;

  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a * 2], az = pts[a * 2 + 1];
    const bx = pts[b * 2], bz = pts[b * 2 + 1];
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    let far = -1, fd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i * 2] - ax) * dz - (pts[i * 2 + 1] - az) * dx) / len;
      if (d > fd) { fd = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }

  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}
