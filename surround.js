// surround.js — everything beyond the edge of the baked map.
//
// ⚠️ VIEW-ONLY. The sim knows nothing about any of this and must not: the
// surround is scenery, not city. Nothing here is simulated, picked, zoned or
// counted. `Math.random` is still banned — placement uses the same stable
// hash the rest of the view uses, so two screenshots of the same world match.
//
// WHY IT EXISTS: a baked world is a finite square. Rendered honestly it is a
// slab floating in a void — hard edges on four sides, the sky dome's ground
// colour beyond, and the underside visible from a low angle. The map has to
// read as ENDLESS, so three things continue past the boundary:
//
//   1. THE SEA      an ocean plane at sea level, out to the horizon
//   2. THE LAND     an apron continuing the edge terrain, flattening with distance
//   3. THE CITY     ghost blocks suggesting the streets carry on
//
// Together with fog matched to the sky, there is no boundary to find.

import * as THREE from './lib/three.module.js';
import { hash01, GROUND, SKY } from './palette.js';

/**
 * ⚠️ ONE HORIZON, SHARED. These four distances have to be ordered or the
 * illusion breaks in a way that is hard to diagnose:
 *
 *     apron  <  sea  <  sky dome  <  camera far
 *
 * The first attempt had a 72 km sea plane inside a 6 km sky dome inside a 16 km
 * far plane, so the sea ran out past the "sky" and was then cut flat by the far
 * plane — a hard straight edge across the horizon, which is exactly the artifact
 * this whole file exists to remove. view.js imports HORIZON and derives the dome
 * and the far plane from it, so they can never drift apart again.
 */
export const HORIZON = 6;      // multiples of world width — the reference distance
const APRON_REACH = HORIZON;
const SEA_REACH = HORIZON * 2.3;   // full width of the plane, so half is HORIZON*1.15
/** Rings of apron geometry. Spacing grows geometrically, so detail sits at the seam. */
// ⚠️ Resolution is set by the COASTLINE, not by the flat ground. Where the
// apron crosses sea level the ring geometry becomes the shape of the shore, and
// at 160 samples that shore was a visible staircase. These numbers cost ~23k
// triangles, which against a 2M-triangle city is nothing.
const APRON_RINGS = 34;
/** Samples around each ring's perimeter. */
const APRON_SAMPLES = 420;
/** Distance over which apron height decays toward a distant plain. */
const FLATTEN_OVER = 2.2;      // multiples of world width
/** What fraction of the edge height survives far away. Sea stays sea, hills flatten. */
const DISTANT_KEEP = 0.32;

/** The ghost city reaches this far out before it has thinned to nothing. */
const GHOST_REACH = 1.5;
const GHOST_MAX = 7000;
/** Ghosts need this much height above the sea before the ground reads as dry. */
const SHORE_CLEARANCE = 5;

export class Surround {
  constructor(world, scene) {
    this.world = world;
    this.scene = scene;
    this.group = new THREE.Group();
    // ⚠️ NO forced renderOrder. It was -10/-9/-8, which pushed the 25 km sea
    // plane to draw FIRST and made it overdraw the entire screen before the
    // terrain and apron covered it again. three.js already sorts opaque meshes
    // front-to-back, which is what lets the depth test reject hidden pixels —
    // forcing an order threw that away. Depth alone decides what wins here.
    scene.add(this.group);
    this.seaLevel = 0;
    this._built = false;
  }

  build(seaLevel = 0) {
    this.dispose();
    this.seaLevel = seaLevel;
    this._buildSea();
    this._buildApron();
    this._buildGhosts();
    this._built = true;
    return this;
  }

  /** The sea follows the slider, so raising it floods the horizon too. */
  setSeaLevel(level) {
    this.seaLevel = level;
    if (this.sea) this.sea.position.y = level;
  }

  // ── the sea ───────────────────────────────────────────────────────────────

  /**
   * One enormous horizontal plane at sea level.
   *
   * ⚠️ It spans the WHOLE world, not just the outside, and that is deliberate:
   * a baked map's below-sea-level ground (San Francisco's bay is 2.6% of the
   * tile) is otherwise painted as flat grey "wet ground" with no water surface
   * on it at all — which is most of what reads as dead grey space. The plane
   * simply covers anything lower than the sea, everywhere, which is what a sea
   * does. Terrain above sea level pokes through it and is unaffected.
   */
  _buildSea() {
    const w = this.world;
    const size = Math.max(w.width, w.depth) * SEA_REACH;
    const geo = new THREE.PlaneGeometry(size, size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({
      color: 0x2d5f83,
      // Opaque: there is nothing worth seeing under a sea, and an enormous
      // transparent plane is pure overdraw.
      transparent: false,
      depthWrite: true,
    });
    this.sea = new THREE.Mesh(geo, mat);
    this.sea.position.set(0, this.seaLevel, 0);
    this.sea.receiveShadow = false;
    this.group.add(this.sea);
  }

  // ── the land ──────────────────────────────────────────────────────────────

  /**
   * Height of the apron at a point outside the map.
   *
   * ⚠️ Leans on world.heightAt CLAMPING outside the grid: for any point beyond
   * the boundary it returns the height of the nearest edge cell, which is
   * exactly the seam-free continuation we want. Ring 0 of the apron sits on the
   * map boundary itself, so the first quad shares the terrain's own edge height
   * and there is no crack to find.
   */
  _apronHeight(x, z) {
    const w = this.world;
    const edge = this._edgeSample(x, z);
    const outX = Math.max(0, Math.abs(x) - w.width / 2);
    const outZ = Math.max(0, Math.abs(z) - w.depth / 2);
    const out = Math.hypot(outX, outZ);
    const span = w.width * FLATTEN_OVER;
    const t = Math.min(1, out / span);
    const smooth = t * t * (3 - 2 * t);     // smoothstep, so no crease at the seam
    // Decay toward a fraction of the edge height: hills flatten into a plain,
    // and ground already below the sea stays below it and reads as open water.
    let h = edge * (1 - smooth) + edge * DISTANT_KEEP * smooth;

    // The sea gets DEEPER offshore. Without this, apron that starts within a
    // metre of sea level hovers either side of the waterline from one ring to
    // the next and paints long pale sandbars parallel to the coast. Deepening
    // is both what a real seabed does and what makes the shoreline decisive.
    if (h < this.seaLevel) h -= Math.min(40, out * 0.03);
    return h;
  }

  /**
   * The edge height under an outside point, BLURRED along the boundary by an
   * amount that grows with distance.
   *
   * ⚠️ A plain clamped sample is what produces staircase coastlines. heightAt
   * clamps to the nearest edge CELL, so ten metres of edge detail gets extruded
   * outward for kilometres as a long thin strip, and every strip crosses sea
   * level at a different place — a sawtooth shore made of parallel steps.
   * Widening the sample window with distance means fine edge detail washes out
   * within a few hundred metres and only the broad shape of the coast survives,
   * which is also what a real coastline does as you pull away from it.
   */
  _edgeSample(x, z) {
    const w = this.world;
    const halfX = w.width / 2, halfZ = w.depth / 2;
    const outX = Math.max(0, Math.abs(x) - halfX);
    const outZ = Math.max(0, Math.abs(z) - halfZ);
    const out = Math.hypot(outX, outZ);
    if (out <= 0) return w.heightAt(x, z);      // inside: the terrain's own value

    // Blur ALONG the boundary, never across it: sampling across would drag the
    // interior of the map outward and break the seam.
    const alongZ = outX > outZ;                 // clamped in X -> the edge runs in Z
    // ⚠️ MUST BE ZERO AT THE BOUNDARY. A constant term here (it was 25 m)
    // blurs the sample even where out === 0, so the apron no longer equals the
    // terrain it joins and a 2.6 m step appears all along the seam — measured,
    // not guessed. Blur has to grow FROM nothing.
    const blur = Math.min(w.width * 0.22, out * 0.62);

    let sum = 0, n = 0;
    for (let k = -2; k <= 2; k++) {
      const d = (k / 2) * blur;
      const sx = alongZ ? x : x + d;
      const sz = alongZ ? z + d : z;
      const weight = k === 0 ? 2 : 1;           // keep the centre honest
      sum += w.heightAt(sx, sz) * weight;
      n += weight;
    }
    return sum / n;
  }

  _buildApron() {
    const w = this.world;
    const halfX = w.width / 2, halfZ = w.depth / 2;
    const far = Math.max(w.width, w.depth) * APRON_REACH;

    // Ring offsets grow geometrically: dense at the seam where a crack would
    // show, enormous far away where fog has taken over anyway.
    const offs = [0];
    for (let r = 1; r <= APRON_RINGS; r++) {
      // Steeper exponent = more rings crowded near the seam, where the coast
      // and the height variation are, and enormous quads far out under the fog.
      offs.push(far * (Math.pow(r / APRON_RINGS, 3.0)));
    }

    const S = APRON_SAMPLES;
    const ringPts = offs.map(d => {
      const pts = new Float32Array(S * 2);
      for (let k = 0; k < S; k++) {
        const p = perimeterPoint(k / S, halfX + d, halfZ + d);
        pts[k * 2] = p.x; pts[k * 2 + 1] = p.z;
      }
      return pts;
    });

    const pos = [], col = [];
    const c = new THREE.Color();
    const span = Math.max(1, w.maxH - w.minH);

    const push = (x, z) => {
      const h = this._apronHeight(x, z);
      pos.push(x, h, z);
      // Same palette as buildTerrain so the seam is invisible, minus the slope
      // and per-cell noise terms which mean nothing out here.
      const t = Math.max(0, Math.min(1, (h - w.minH) / span));
      let r = GROUND.lowGreen[0] + (GROUND.highGreen[0] - GROUND.lowGreen[0]) * t;
      let g = GROUND.lowGreen[1] + (GROUND.highGreen[1] - GROUND.lowGreen[1]) * t;
      let b = GROUND.lowGreen[2] + (GROUND.highGreen[2] - GROUND.lowGreen[2]) * t;
      // ⚠️ The apron is NEVER painted as water. It was, and the result was two
      // different blues meeting along the coast — the apron's wet tint against
      // the sea plane's own colour — which drew exactly the visible boundary
      // this file exists to remove. The sea plane is the only water there is;
      // apron below sea level simply goes under it, which is what a coast is.
      // A damp band just above the waterline is fine and reads as beach.
      const damp = Math.max(0, Math.min(1, (this.seaLevel + 2.5 - h) / 5));
      if (damp > 0) {
        r += (0.62 - r) * damp * 0.55;
        g += (0.58 - g) * damp * 0.55;
        b += (0.48 - b) * damp * 0.55;
      }
      c.setRGB(r, g, b);
      col.push(c.r, c.g, c.b);
    };

    for (let r = 0; r < offs.length - 1; r++) {
      const inner = ringPts[r], outer = ringPts[r + 1];
      for (let k = 0; k < S; k++) {
        const k2 = (k + 1) % S;
        const ix = inner[k * 2], iz = inner[k * 2 + 1];
        const jx = inner[k2 * 2], jz = inner[k2 * 2 + 1];
        const ox = outer[k * 2], oz = outer[k * 2 + 1];
        const px = outer[k2 * 2], pz = outer[k2 * 2 + 1];
        // ⚠️⚠️ INNER, NEXT-INNER, OUTER — and it took a measurement to get right.
        // The first version here was inner, outer, next-inner, which reads as the
        // obvious order and produces DOWNWARD normals: all 24,960 apron vertices
        // faced down, the whole apron was backface-culled to nothing, and the sea
        // plane behind it showed through. It looked exactly like "the ghosts are
        // floating on water" rather than "the ground is missing", which is why it
        // survived a visual check. This is the same handedness trap documented on
        // geom.triangulate, and the guard for it is in test.mjs.
        push(ix, iz); push(jx, jz); push(ox, oz);
        push(jx, jz); push(px, pz); push(ox, oz);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    // Assert the apron faces the sky. A downward apron is invisible and the
    // symptom (sea showing through) looks nothing like the cause.
    const nrm = geo.getAttribute('normal');
    let meanY = 0;
    for (let i = 0; i < nrm.count; i++) meanY += nrm.getY(i);
    meanY /= Math.max(1, nrm.count);
    if (meanY < 0.5) {
      console.error(`[surround] apron normals face DOWN (mean y ${meanY.toFixed(3)}) — ` +
        'it will be backface-culled and the sea will show through. Check the winding.');
    }
    this.apronMeanNormalY = meanY;

    this.apron = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.apron.receiveShadow = false;    // outside every shadow frustum anyway
    this.group.add(this.apron);
    this.apronTris = pos.length / 9;
  }

  // ── the city ──────────────────────────────────────────────────────────────

  /**
   * Ghost blocks past the edge.
   *
   * A bare apron reads as "the city sits alone on a plain", which is its own
   * kind of edge. The strongest cue that a world continues is that the URBAN
   * FABRIC continues, so a band of blocks carries on beyond the boundary,
   * thinning and shrinking with distance until fog finishes the job.
   *
   * Heights are sampled from the REAL buildings nearest that direction, so the
   * ghost of downtown is tall and the ghost of the suburbs is low.
   */
  _buildGhosts() {
    const w = this.world;
    if (!w.buildings.length) return;

    // What does the real city look like near each edge? Bucket the outermost
    // real buildings by angle so the ghost inherits the right silhouette.
    const BUCKETS = 32;
    const hSum = new Float64Array(BUCKETS), hCount = new Int32Array(BUCKETS);
    for (const b of w.buildings) {
      const [x, z] = b.c;
      // only buildings in the outer third contribute
      if (Math.abs(x) < w.width * 0.28 && Math.abs(z) < w.depth * 0.28) continue;
      const a = (Math.atan2(z, x) + Math.PI) / (Math.PI * 2);
      const k = Math.min(BUCKETS - 1, Math.floor(a * BUCKETS));
      hSum[k] += b.h; hCount[k]++;
    }
    const bucketH = k => (hCount[k] ? hSum[k] / hCount[k] : 8);

    const halfX = w.width / 2, halfZ = w.depth / 2;
    const reach = Math.max(w.width, w.depth) * GHOST_REACH;

    const mtx = new THREE.Matrix4();
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const colour = new THREE.Color();
    const items = [];

    // Walk outward in rings; density falls off so the fabric frays rather than
    // stopping at a line.
    const RINGS = 26;
    for (let r = 1; r <= RINGS; r++) {
      const t = r / RINGS;
      const d = reach * t * t;                 // sparse far out
      const keep = Math.pow(1 - t, 1.5);       // thinning with distance
      const perRing = Math.floor(420 * keep);
      if (perRing < 2) continue;

      for (let k = 0; k < perRing; k++) {
        const seed = r * 7919 + k;
        const u = (k + hash01(seed, 3) * 0.9) / perRing;
        const pt = perimeterPoint(u, halfX + d, halfZ + d);

        // jitter off the ring so it never reads as concentric rectangles
        const jx = (hash01(seed, 5) - 0.5) * d * 0.22;
        const jz = (hash01(seed, 7) - 0.5) * d * 0.22;
        const x = pt.x + jx, z = pt.z + jz;

        const ground = this._apronHeight(x, z);
        // ⚠️ Not "above the sea" — above the WET BAND. The apron paints
        // anything within 0.2 m of sea level as wet blue, so a ghost standing
        // at +1 m read exactly like a block floating on open water. Clear the
        // shoreline properly before building anything on it.
        if (ground <= this.seaLevel + SHORE_CLEARANCE) continue;

        const a = (Math.atan2(z, x) + Math.PI) / (Math.PI * 2);
        const bh = bucketH(Math.min(BUCKETS - 1, Math.floor(a * BUCKETS)));
        const h = Math.max(4, bh * (0.55 + hash01(seed, 11) * 0.9) * (1 - t * 0.45));
        // Smaller footprints read as a grain of buildings; the first pass used
        // 14-40 m blocks that looked like scattered slabs rather than a city.
        const fw = 9 + hash01(seed, 13) * 17;
        const fd = 9 + hash01(seed, 17) * 17;

        items.push({ x, z, y: ground, h, fw, fd, rot: hash01(seed, 19) * Math.PI, seed });
        if (items.length >= GHOST_MAX) break;
      }
      if (items.length >= GHOST_MAX) break;
    }

    if (!items.length) return;

    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);      // sit on the ground rather than straddle it
    const mesh = new THREE.InstancedMesh(
      geo, new THREE.MeshLambertMaterial({ vertexColors: false }), items.length);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(items.length * 3), 3);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      p.set(it.x, it.y, it.z);
      q.setFromAxisAngle(up, it.rot);
      s.set(it.fw, it.h, it.fd);
      mesh.setMatrixAt(i, mtx.compose(p, q, s));
      // ⚠️ MUCH darker than instinct suggests. At 0.52-0.68 these lit up almost
      // white and out-read the real buildings they are supposed to sit behind —
      // the eye went straight to the fake city. Dim and slightly cool, so they
      // recede and the real city stays the subject.
      const v = 0.30 + hash01(it.seed, 23) * 0.13;
      colour.setRGB(v * 0.98, v * 0.99, v);
      mesh.setColorAt(i, colour);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    this.ghosts = mesh;
    this.ghostCount = items.length;
    this.group.add(mesh);
  }

  setGhostsVisible(on) { if (this.ghosts) this.ghosts.visible = on; }

  stats() {
    return {
      apronTriangles: this.apronTris || 0,
      apronMeanNormalY: this.apronMeanNormalY ?? null,
      ghosts: this.ghostCount || 0,
      seaSize: this.sea ? this.sea.geometry.parameters.width : 0,
    };
  }

  dispose() {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
    this.sea = this.apron = this.ghosts = null;
    this.apronTris = this.ghostCount = 0;
  }
}

/**
 * A point at parameter u in [0,1) around the perimeter of an axis-aligned
 * rectangle of half-extents (hx, hz). Used so consecutive rings share the same
 * parameterisation and their quads join without a seam.
 */
function perimeterPoint(u, hx, hz) {
  const w = 2 * hx, d = 2 * hz;
  const total = 2 * (w + d);
  let s = ((u % 1) + 1) % 1 * total;
  if (s < w) return { x: -hx + s, z: -hz };
  s -= w;
  if (s < d) return { x: hx, z: -hz + s };
  s -= d;
  if (s < w) return { x: hx - s, z: hz };
  s -= w;
  return { x: -hx, z: hz - s };
}
