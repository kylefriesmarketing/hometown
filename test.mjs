// test.mjs — headless checks for the pure layers. `node test.mjs`
//
// Everything here runs without a browser: geom.js, geo.js, world.js and the
// bake-time classifiers are all dependency-free by design, and that is exactly
// what makes them testable. view.js is NOT tested here (it needs a GL context);
// its invariants are enforced by the winding tests below, which cover the code
// that actually generates its geometry.

import { triangulate, ribbon, simplify, signedArea, reverseRing, polylineLength } from './geom.js';
import { makeProjection, metresPerDegree, lonLatToTile, tileToLonLat, ringArea, ringCentroid } from './geo.js';
import { World, pointInRing } from './world.js';
import { parseLength, buildingKind, buildingHeight, roadInfo, areaKind } from './tools/osm.js';

let pass = 0, fail = 0;
const fails = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; }
  else { fail++; fails.push(`${name}${detail ? ' — ' + detail : ''}`); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── geom: winding ───────────────────────────────────────────────────────────
// ⚠️ THE REGRESSION GUARD. Faces wound the wrong way are backface-culled and
// vanish, which looks like a colour/lighting bug and cost a full debug round.
// Any change to triangulate() must keep these green.

/**
 * y-component of the face normal for a flat triangle, in our x-east / y-up /
 * z-south frame. n = (b-a) × (c-a); with all three points at the same height
 * only the y term survives, and it is -(ux*vz - uz*vx).
 * Positive = the face is visible from above.
 */
function faceNormalY(ax, az, bx, bz, cx, cz) {
  const ux = bx - ax, uz = bz - az, vx = cx - ax, vz = cz - az;
  return -(ux * vz - uz * vx);
}

const SQUARE_CW = [0, 0, 10, 0, 10, 10, 0, 10];
const SQUARE_CCW = reverseRing(SQUARE_CW);
const L_SHAPE = [0, 0, 20, 0, 20, 8, 8, 8, 8, 20, 0, 20];
const CONCAVE = [0, 0, 30, 0, 30, 10, 18, 10, 18, 4, 12, 4, 12, 10, 0, 10];

for (const [name, ring] of [['square-cw', SQUARE_CW], ['square-ccw', SQUARE_CCW],
                            ['L-shape', L_SHAPE], ['concave', CONCAVE]]) {
  const tris = triangulate(ring);
  ok(`triangulate(${name}) returns whole triangles`, tris.length > 0 && tris.length % 3 === 0,
     `got ${tris.length} indices`);

  let allUp = true, area = 0;
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i] * 2, b = tris[i + 1] * 2, c = tris[i + 2] * 2;
    const ny = faceNormalY(ring[a], ring[a + 1], ring[b], ring[b + 1], ring[c], ring[c + 1]);
    if (ny <= 0) allUp = false;
    area += Math.abs(ny) / 2;
  }
  ok(`triangulate(${name}) every face points UP`, allUp,
     'a downward face is backface-culled and disappears');
  ok(`triangulate(${name}) covers the polygon`, near(area, ringArea(pairs(ring)), 1e-6),
     `tri area ${area} vs ring area ${ringArea(pairs(ring))}`);
}

function pairs(flat) {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ x: flat[i], z: flat[i + 1] });
  return out;
}

// road ribbon winding, mirroring what view.buildRoads emits
{
  const line = [0, 0, 10, 0, 20, 0];       // heading east
  const { left, right } = ribbon(line, 8);
  ok('ribbon offsets by half width', near(Math.abs(left[1] - right[1]), 8, 1e-9),
     `separation ${Math.abs(left[1] - right[1])}`);

  let allUp = true;
  for (let i = 0; i < line.length / 2 - 1; i++) {
    const L0 = [left[i * 2], left[i * 2 + 1]], R0 = [right[i * 2], right[i * 2 + 1]];
    const L1 = [left[(i + 1) * 2], left[(i + 1) * 2 + 1]], R1 = [right[(i + 1) * 2], right[(i + 1) * 2 + 1]];
    // the exact order view.js pushes
    if (faceNormalY(L0[0], L0[1], L1[0], L1[1], R0[0], R0[1]) <= 0) allUp = false;
    if (faceNormalY(R0[0], R0[1], L1[0], L1[1], R1[0], R1[1]) <= 0) allUp = false;
  }
  ok('road ribbon faces UP', allUp, 'view.buildRoads winding must match this order');
}

// ── geom: misc ──────────────────────────────────────────────────────────────
ok('signedArea flips with winding', signedArea(SQUARE_CW) === -signedArea(SQUARE_CCW));
ok('reverseRing is an involution', reverseRing(reverseRing(L_SHAPE)).join() === L_SHAPE.join());
ok('polylineLength', near(polylineLength([0, 0, 3, 4]), 5, 1e-9));
{
  const line = [0, 0, 5, 0.1, 10, 0, 15, 0.1, 20, 0];
  const s = simplify(line, 1.0);
  ok('simplify drops near-collinear points', s.length < line.length, `${line.length / 2} -> ${s.length / 2}`);
  ok('simplify keeps endpoints',
     s[0] === 0 && s[1] === 0 && s[s.length - 2] === 20 && s[s.length - 1] === 0);
  ok('simplify with huge tolerance keeps only the ends', simplify(line, 1e6).length === 4);
}
ok('ringCentroid of a square', (() => {
  const c = ringCentroid(pairs(SQUARE_CW));
  return near(c.x, 5, 1e-9) && near(c.z, 5, 1e-9);
})());
ok('pointInRing inside', pointInRing(5, 5, SQUARE_CW));
ok('pointInRing outside', !pointInRing(15, 5, SQUARE_CW));
ok('pointInRing outside (concave notch)', !pointInRing(15, 7, CONCAVE));
ok('pointInRing inside (concave arm)', pointInRing(3, 5, CONCAVE));

// ── geo: projection ─────────────────────────────────────────────────────────
{
  const bbox = { s: 37.79, w: -122.42, n: 37.81, e: -122.40 };
  const p = makeProjection(bbox);
  const c = p.toLocal(p.lat0, p.lon0);
  ok('projection centre maps to origin', near(c.x, 0, 1e-9) && near(c.z, 0, 1e-9));

  const back = p.toLocal(37.805, -122.41);
  const g = p.toGeo(back.x, back.z);
  ok('projection round-trips', near(g.lat, 37.805, 1e-9) && near(g.lon, -122.41, 1e-9),
     `${g.lat}, ${g.lon}`);

  // NORTH must be -z. Getting this backwards mirrors the entire world.
  const north = p.toLocal(bbox.n, p.lon0);
  ok('north is -z', north.z < 0, `north gave z=${north.z}`);
  const east = p.toLocal(p.lat0, bbox.e);
  ok('east is +x', east.x > 0, `east gave x=${east.x}`);

  ok('metresPerDegree at equator ~111km', near(metresPerDegree(0).lat, 110574, 200),
     String(metresPerDegree(0).lat));
  ok('longitude shrinks with latitude', metresPerDegree(60).lon < metresPerDegree(0).lon * 0.55);
}
{
  const t = lonLatToTile(0, 0, 1);
  ok('tile at null island is the 2x2 centre', near(t.x, 1, 1e-9) && near(t.y, 1, 1e-9));
  const g = tileToLonLat(1, 1, 1);
  ok('tileToLonLat inverts', near(g.lat, 0, 1e-9) && near(g.lon, 0, 1e-9));
}

// ── world: terrain sampling ─────────────────────────────────────────────────
// A tiny synthetic world lets us assert the sampler's exact contract.
function fakeWorld(heights, cols, rows, cell = 10) {
  return new World({
    name: 'test', label: 'test',
    origin: { lat: 0, lon: 0 },
    size: { width: (cols - 1) * cell, depth: (rows - 1) * cell },
    terrain: { cols, rows, cell, minH: Math.min(...heights), maxH: Math.max(...heights), heights },
    buildings: [], roads: [], areas: [], waterways: [], rails: [], pois: [], meta: {},
  });
}
{
  // 2x2 cell with a strong twist — the case where bilinear and the rendered
  // triangle pair disagree, which is what buried every road.
  const w = fakeWorld([0, 0, 0, 10], 2, 2, 10);
  ok('heightAt hits grid corners exactly',
     near(w.heightAt(-5, -5), 0) && near(w.heightAt(5, 5), 10));

  // centre of the cell: dx=dz=0.5 lies on the split (dx+dz===1), triangle a,d,b
  // h00=0 h10=0 h01=0 h11=10 -> 0 + .5*(0-0) + .5*(0-0) = 0, NOT the bilinear 2.5
  ok('heightAt is piecewise-linear, not bilinear', near(w.heightAt(0, 0), 0),
     `got ${w.heightAt(0, 0)} (bilinear would give 2.5)`);

  // and just past the split it must follow the OTHER triangle
  ok('heightAt uses the far triangle past the split', w.heightAt(1, 1) > 0,
     `got ${w.heightAt(1, 1)}`);

  ok('heightAt clamps outside bounds', Number.isFinite(w.heightAt(-9999, 9999)));
}
{
  // A constant 1:1 ramp rising toward +z.
  // ⚠️ The grid must be WIDER than slopeAt's central-difference stencil (±cell)
  // or the sampler clamps at the edge and reports half the true grade — that is
  // a test-rig artifact, not a bug, and it looked exactly like a real failure.
  const cols = 5, rows = 5, cell = 10;
  const heights = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) heights.push(j * cell);
  const w = fakeWorld(heights, cols, rows, cell);

  ok('slopeAt reads a 1:1 grade', near(w.slopeAt(0, 0), 1, 1e-6), String(w.slopeAt(0, 0)));
  const n = w.normalAt(0, 0);
  ok('normalAt is unit length', near(Math.hypot(n.x, n.y, n.z), 1, 1e-9));
  ok('normalAt tilts away from the rise', n.z < 0 && n.y > 0, JSON.stringify(n));
}
{
  const flat = fakeWorld(new Array(9).fill(5), 3, 3, 10);
  ok('slopeAt is zero on flat ground', near(flat.slopeAt(0, 0), 0, 1e-9));
  ok('heightAt on flat ground', near(flat.heightAt(3, -2), 5, 1e-9));
}

// ── world: road distance field ──────────────────────────────────────────────
{
  const cols = 21, rows = 21, cell = 10;
  const w = new World({
    name: 't', label: 't', origin: { lat: 0, lon: 0 },
    size: { width: (cols - 1) * cell, depth: (rows - 1) * cell },
    terrain: { cols, rows, cell, minH: 0, maxH: 0, heights: new Array(cols * rows).fill(0) },
    buildings: [],
    // one straight road along z = 0 through the middle
    roads: [{ c: 'residential', k: 'street', w: 8, r: 4, pts: [-100, 0, 100, 0] }],
    areas: [], waterways: [], rails: [], pois: [], meta: {},
  });
  ok('roadDist is ~0 on the road', w.roadDistAt(0, 0) < 5, String(w.roadDistAt(0, 0)));
  const d30 = w.roadDistAt(0, 30);
  ok('roadDist grows away from the road', d30 > 20 && d30 < 40, String(d30));
  ok('roadDist is symmetric', near(w.roadDistAt(0, 30), w.roadDistAt(0, -30), 1e-6));

  // footways are deliberately NOT vehicle access
  const wf = new World({
    name: 't', label: 't', origin: { lat: 0, lon: 0 },
    size: { width: (cols - 1) * cell, depth: (rows - 1) * cell },
    terrain: { cols, rows, cell, minH: 0, maxH: 0, heights: new Array(cols * rows).fill(0) },
    buildings: [], roads: [{ c: 'footway', k: 'foot', w: 2, r: 1, pts: [-100, 0, 100, 0] }],
    areas: [], waterways: [], rails: [], pois: [], meta: {},
  });
  ok('footways do not count as road access', wf.roadDistAt(0, 0) > 50, String(wf.roadDistAt(0, 0)));
}

// ── world: building index ───────────────────────────────────────────────────
{
  const cols = 21, rows = 21, cell = 10;
  const b1 = { id: 'a', kind: 'residential', ks: 'tag', h: 8, lv: 2, base: 0, g: 0, gm: 0, gx: 0,
               a: 100, c: [0, 0], ring: [-5, -5, 5, -5, 5, 5, -5, 5] };
  const b2 = { id: 'b', kind: 'commercial', ks: 'tag', h: 8, lv: 2, base: 0, g: 0, gm: 0, gx: 0,
               a: 100, c: [60, 60], ring: [55, 55, 65, 55, 65, 65, 55, 65] };
  const w = new World({
    name: 't', label: 't', origin: { lat: 0, lon: 0 },
    size: { width: (cols - 1) * cell, depth: (rows - 1) * cell },
    terrain: { cols, rows, cell, minH: 0, maxH: 0, heights: new Array(cols * rows).fill(0) },
    buildings: [b1, b2], roads: [], areas: [], waterways: [], rails: [], pois: [], meta: {},
  });
  ok('buildingAt finds the right building', w.buildingAt(0, 0)?.id === 'a');
  ok('buildingAt finds the far building', w.buildingAt(60, 60)?.id === 'b');
  ok('buildingAt returns null in the gap', w.buildingAt(30, 30) === null);
  ok('buildingAt returns null outside', w.buildingAt(-95, -95) === null);
  ok('stats counts by kind', w.stats().byKind.residential === 1 && w.stats().byKind.commercial === 1);
}

// ── osm classifiers ─────────────────────────────────────────────────────────
ok('parseLength plain metres', near(parseLength('12.5'), 12.5));
ok('parseLength with unit', near(parseLength('12 m'), 12));
ok('parseLength feet', near(parseLength("40'"), 12.192, 1e-3));
ok('parseLength ft suffix', near(parseLength('40 ft'), 12.192, 1e-3));
ok('parseLength feet+inches', near(parseLength(`12'6"`), 3.8100, 1e-3));
ok('parseLength rejects junk', parseLength('about yay high') === null);
ok('parseLength null-safe', parseLength(undefined) === null);

ok('buildingKind house -> residential', buildingKind({ building: 'house' }) === 'residential');
ok('buildingKind warehouse -> industrial', buildingKind({ building: 'warehouse' }) === 'industrial');
ok('buildingKind school -> civic', buildingKind({ building: 'school' }) === 'civic');
ok('buildingKind shop tag wins over building=yes',
   buildingKind({ building: 'yes', shop: 'bakery' }) === 'commercial');
ok('buildingKind bare yes -> other', buildingKind({ building: 'yes' }) === 'other');

{
  const h = buildingHeight({ height: '20' }, 'commercial');
  ok('buildingHeight prefers the height tag', near(h.height, 20) && h.guessed === false);
  const l = buildingHeight({ 'building:levels': '4' }, 'residential');
  ok('buildingHeight derives from levels', l.height > 12 && l.height < 16 && l.guessed === false,
     String(l.height));
  const d = buildingHeight({}, 'residential');
  ok('buildingHeight falls back and flags the guess', d.guessed === true && d.height > 0);
}

ok('roadInfo classifies a residential street', roadInfo({ highway: 'residential' })?.kind === 'street');
ok('roadInfo classifies a footway', roadInfo({ highway: 'footway' })?.kind === 'foot');
ok('roadInfo rejects a non-road', roadInfo({ building: 'yes' }) === null);
ok('roadInfo honours an explicit width', near(roadInfo({ highway: 'residential', width: '15' }).width, 15));
ok('roadInfo widens for lane count', roadInfo({ highway: 'residential', lanes: '4' }).width > 8);
ok('roadInfo reads oneway', roadInfo({ highway: 'residential', oneway: 'yes' }).oneway === true);

ok('areaKind water', areaKind({ natural: 'water' }) === 'water');
ok('areaKind park', areaKind({ leisure: 'park' }) === 'park');
ok('areaKind ignores the uninteresting', areaKind({ building: 'yes' }) === null);

// ── report ──────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFAILURES:');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('all green\n');
