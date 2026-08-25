// Shared geography math. Imported by BOTH the bake tool (node) and the runtime
// (browser) — keep it dependency-free and side-effect-free.
//
// ⚠️⚠️ THE AXIS CONVENTION, stated once so nothing has to guess:
//        +x = EAST   (metres)
//        +y = UP     (metres)
//        +z = SOUTH  (metres)   <-- so NORTH is -z
// This matches three.js's default camera (looking down -z = looking north) and
// every sign error in this project traces back to forgetting the z flip.

/**
 * Metres per degree of latitude / longitude at a given latitude.
 * WGS84 series expansion — accurate to well under a metre at city scale.
 */
export function metresPerDegree(lat) {
  const p = lat * Math.PI / 180;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p),
    lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p),
  };
}

/**
 * A local tangent-plane projection anchored at the centre of `bbox`.
 * Equirectangular about the origin — error is negligible below ~50 km, and a
 * city build is 1–5 km, so this is exact enough to be considered exact.
 *
 * bbox = { s, w, n, e } in degrees.
 */
export function makeProjection(bbox) {
  const lat0 = (bbox.s + bbox.n) / 2;
  const lon0 = (bbox.w + bbox.e) / 2;
  const m = metresPerDegree(lat0);

  const halfW = (bbox.e - bbox.w) / 2 * m.lon;
  const halfH = (bbox.n - bbox.s) / 2 * m.lat;

  return {
    lat0, lon0,
    mPerDegLat: m.lat,
    mPerDegLon: m.lon,
    /** Full extent of the world in metres. */
    width: halfW * 2,
    depth: halfH * 2,
    /** Local metres from the world centre. North is -z. */
    toLocal(lat, lon) {
      return { x: (lon - lon0) * m.lon, z: -(lat - lat0) * m.lat };
    },
    toGeo(x, z) {
      return { lat: lat0 - z / m.lat, lon: lon0 + x / m.lon };
    },
  };
}

/** Slippy-map tile coordinates (fractional) for a lat/lon at zoom z. */
export function lonLatToTile(lat, lon, z) {
  const n = 2 ** z;
  const r = lat * Math.PI / 180;
  return {
    x: (lon + 180) / 360 * n,
    y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n,
  };
}

/** Inverse of lonLatToTile — north-west corner of tile (x, y). */
export function tileToLonLat(x, y, z) {
  const n = 2 ** z;
  const r = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
  return { lat: r * 180 / Math.PI, lon: x / n * 360 - 180 };
}

/** Ground resolution in metres per pixel for a 256px tile at zoom z, latitude lat. */
export function tileResolution(lat, z) {
  return 156543.03392804097 * Math.cos(lat * Math.PI / 180) / 2 ** z;
}

/** Shoelace area (m²) of a closed ring of {x, z} points. Sign-independent. */
export function ringArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p.x * q.z - q.x * p.z;
  }
  return Math.abs(a) / 2;
}

/** Centroid of a closed ring of {x, z}. Falls back to the mean for degenerate rings. */
export function ringCentroid(pts) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const f = p.x * q.z - q.x * p.z;
    a += f;
    cx += (p.x + q.x) * f;
    cz += (p.z + q.z) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let mx = 0, mz = 0;
    for (const p of pts) { mx += p.x; mz += p.z; }
    return { x: mx / pts.length, z: mz / pts.length };
  }
  a *= 0.5;
  return { x: cx / (6 * a), z: cz / (6 * a) };
}
