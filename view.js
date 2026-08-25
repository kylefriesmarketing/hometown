// view.js — everything you can see. Reads the World, writes pixels.
//
// ⚠️ VIEW-ONLY BY CONTRACT. Nothing in this file may be read by sim.js, and
//    nothing here may write world/sim state. Math.random is allowed HERE and
//    nowhere else.
//
// Draw-call budget is the whole design: a dense world is ~6k buildings and ~4k
// roads, so everything is merged into a handful of BufferGeometries grouped by
// material. One mesh for all buildings, one per road tier, one per area kind.

import * as THREE from './lib/three.module.js';
import { triangulate, ribbon, simplify, signedArea, reverseRing } from './geom.js';

// Vertical layering — small, fixed offsets so draped surfaces never z-fight.
// ⚠️ `foot` sits BELOW `road` on purpose. A well-mapped city tags every
//    sidewalk, so footways outnumber roadway ways several to one; drawn on top
//    they bury the actual street grid under a pale web. Roads win overlaps.
// Safe to keep these small because world.heightAt() samples the SAME surface
// the terrain mesh renders — see the warning on heightAt before shrinking or
// growing them.
const Y = { area: 0.05, water: 0.09, foot: 0.13, rail: 0.18, road: 0.22 };

const BUILDING_COLOR = {
  residential: 0xc9a882,
  commercial:  0x7f9cc4,
  industrial:  0x9a8f83,
  civic:       0xdfd6c6,
  minor:       0xa79e93,
  other:       0xb3aba1,
};
const ROOF_TINT = 0.82;          // roofs a touch darker than walls

const AREA_STYLE = {
  water:      { color: 0x3f6f9e, y: Y.water },
  park:       { color: 0x7fa860, y: Y.area },
  wood:       { color: 0x5d8449, y: Y.area },
  cemetery:   { color: 0x8aa377, y: Y.area },
  sport:      { color: 0x8fb87a, y: Y.area },
  parking:    { color: 0x9c9891, y: Y.area },
  sand:       { color: 0xd9c9a3, y: Y.area },
  rock:       { color: 0xa9a29a, y: Y.area },
  farm:       { color: 0xc2b878, y: Y.area },
  industrial: { color: 0xa8a099, y: Y.area },
  commercial: { color: 0xb2aab8, y: Y.area },
  residential:{ color: 0xb9b3a6, y: Y.area },
};

const ROAD_STYLE = {
  highway:  { color: 0x4a4d54, y: Y.road },
  arterial: { color: 0x55585f, y: Y.road },
  street:   { color: 0x5f6269, y: Y.road },
  service:  { color: 0x6b6e75, y: Y.road },
  foot:     { color: 0x86827b, y: Y.foot },
};

export class View {
  constructor(canvas, world) {
    this.canvas = canvas;
    this.world = world;
    this.showGuessed = true;      // dim buildings whose height we invented
    this.buildings = [];          // {b, startVert, roofStart, endVert} per building

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xbcd3e6);
    // Haze only at the true far edge — fog that starts inside the play area
    // dissolves the town you are trying to look at.
    this.scene.fog = new THREE.Fog(0xbcd3e6, world.width * 1.15, world.width * 2.9);

    this.camera = new THREE.PerspectiveCamera(48, 1, 1, world.width * 3);

    // RTS camera: a focus point on the ground plus orbit/zoom around it.
    this.cam = {
      fx: 0, fz: 0,
      dist: Math.min(900, world.width * 0.5),
      yaw: -0.6, pitch: 0.72,
      minDist: 25, maxDist: world.width * 1.1,
    };
    this.cam.fy = world.heightAt(0, 0);

    this._lights();
    this._raycaster = new THREE.Raycaster();
    this.resize();
  }

  _lights() {
    const w = this.world;
    this.scene.add(new THREE.HemisphereLight(0xdcecff, 0x6b6350, 0.85));

    const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
    sun.position.set(-0.45, 1, 0.62).normalize().multiplyScalar(600);
    sun.castShadow = true;
    sun.shadow.camera.near = 20; sun.shadow.camera.far = 3200;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0012;
    sun.shadow.normalBias = 0.6;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
    this._shadowSpan = 0;
  }

  /**
   * Size the shadow frustum to what the camera can actually see.
   *
   * ⚠️ A fixed box is the trap here: anything OUTSIDE the shadow camera samples
   * beyond the shadow map and comes back fully shadowed, so a zoomed-out view
   * renders every distant building solid black. It reads as a lighting bug but
   * it is a frustum-coverage bug. Span tracks zoom so coverage always holds,
   * and it is quantised so we are not rebuilding the projection every frame.
   */
  _fitShadow(dist) {
    const span = Math.max(180, Math.min(1400, dist * 0.95));
    const q = Math.round(span / 60) * 60;
    if (q === this._shadowSpan) return;
    this._shadowSpan = q;
    const c = this.sun.shadow.camera;
    c.left = -q; c.right = q; c.top = q; c.bottom = -q;
    c.updateProjectionMatrix();
  }

  // ─── build ────────────────────────────────────────────────────────────────

  build() {
    const t0 = performance.now();
    this.buildTerrain();
    this.buildAreas();
    this.buildRoads();
    this.buildBuildings();
    return performance.now() - t0;
  }

  buildTerrain() {
    const w = this.world;
    const { cols, rows, cell } = w;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(cols * rows * 3);
    const col = new Float32Array(cols * rows * 3);

    const c = new THREE.Color();
    const span = Math.max(1, w.maxH - w.minH);

    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const n = j * cols + i;
        const x = w.x0 + i * cell, z = w.z0 + j * cell;
        const h = w.heights[n];
        pos[n * 3] = x; pos[n * 3 + 1] = h; pos[n * 3 + 2] = z;

        // Low ground reads green, high ground dries out to tan; steep faces go
        // rocky. This is the map's only "art" and it carries the terrain read.
        // Ground between buildings should read as GROUND and never compete with
        // the city on top of it — so this stays a muted green that only dries
        // out slightly with height. A strong elevation ramp turned SF's hills
        // into a desert; captured, then dialled right back.
        const t = (h - w.minH) / span;
        const slope = w.slopeAt(x, z);
        const rock = Math.min(1, slope / 0.55);
        c.setRGB(
          0.38 + 0.13 * t + 0.09 * rock,
          0.46 + 0.09 * t + 0.02 * rock,
          0.31 + 0.08 * t + 0.07 * rock
        );
        if (h <= 0.2) c.setRGB(0.24, 0.38, 0.48);   // below sea level: wet
        col[n * 3] = c.r; col[n * 3 + 1] = c.g; col[n * 3 + 2] = c.b;
      }
    }

    const idx = [];
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i, b = a + 1, d = a + cols, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);
  }

  /** Drape a flat ring on the terrain at a fixed offset, as merged triangles. */
  _drapeRing(ring, yOff, pos, out) {
    const tris = triangulate(ring);
    const w = this.world;
    for (let i = 0; i < tris.length; i++) {
      const k = tris[i] * 2;
      const x = ring[k], z = ring[k + 1];
      pos.push(x, w.heightAt(x, z) + yOff, z);
      out.n++;
    }
  }

  buildAreas() {
    const groups = new Map();
    for (const a of this.world.areas) {
      const style = AREA_STYLE[a.k];
      if (!style) continue;
      if (!groups.has(a.k)) groups.set(a.k, { pos: [], n: 0, style });
      const g = groups.get(a.k);
      this._drapeRing(a.ring, style.y, g.pos, g);
    }

    this.areaMeshes = [];
    for (const [kind, g] of groups) {
      if (!g.n) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
      geo.computeVertexNormals();
      const mat = new THREE.MeshLambertMaterial({
        color: g.style.color,
        transparent: kind === 'water',
        opacity: kind === 'water' ? 0.88 : 1,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      mesh.renderOrder = 1;
      this.scene.add(mesh);
      this.areaMeshes.push(mesh);
    }
  }

  buildRoads() {
    const groups = new Map();
    const w = this.world;

    const strip = (pts, width, style, g) => {
      const simple = simplify(pts, 0.6);
      if (simple.length < 4) return;
      const { left, right } = ribbon(simple, width);
      const n = simple.length / 2;
      for (let i = 0; i < n - 1; i++) {
        const lx0 = left[i * 2], lz0 = left[i * 2 + 1];
        const rx0 = right[i * 2], rz0 = right[i * 2 + 1];
        const lx1 = left[(i + 1) * 2], lz1 = left[(i + 1) * 2 + 1];
        const rx1 = right[(i + 1) * 2], rz1 = right[(i + 1) * 2 + 1];
        const y = p => w.heightAt(p[0], p[1]) + style.y;
        const L0 = [lx0, lz0], R0 = [rx0, rz0], L1 = [lx1, lz1], R1 = [rx1, rz1];
        // Wound L,L,R / R,L,R so the ribbon faces UP — see the winding warning
        // in geom.triangulate; the mirrored order is culled from above.
        g.pos.push(
          L0[0], y(L0), L0[1],  L1[0], y(L1), L1[1],  R0[0], y(R0), R0[1],
          R0[0], y(R0), R0[1],  L1[0], y(L1), L1[1],  R1[0], y(R1), R1[1]
        );
        g.n += 6;
      }
    };

    for (const r of this.world.roads) {
      const style = ROAD_STYLE[r.k];
      if (!style) continue;
      if (!groups.has(r.k)) groups.set(r.k, { pos: [], n: 0, style });
      strip(r.pts, r.w, style, groups.get(r.k));
    }
    // Rivers and canals ride the same machinery, in water colour.
    if (this.world.waterways.length) {
      const style = { color: 0x3f6f9e, y: Y.water };
      groups.set('_water', { pos: [], n: 0, style });
      for (const ww of this.world.waterways) strip(ww.pts, ww.w, style, groups.get('_water'));
    }
    if (this.world.rails.length) {
      const style = { color: 0x6d6157, y: Y.rail };
      groups.set('_rail', { pos: [], n: 0, style });
      for (const rl of this.world.rails) strip(rl.pts, 4.2, style, groups.get('_rail'));
    }

    this.roadMeshes = [];
    for (const [kind, g] of groups) {
      if (!g.n) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: g.style.color }));
      mesh.receiveShadow = true;
      mesh.renderOrder = 2;
      this.scene.add(mesh);
      this.roadMeshes.push(mesh);
    }
  }

  buildBuildings() {
    const w = this.world;
    const pos = [], col = [], faceOwner = [];
    const c = new THREE.Color();

    this.buildings.length = 0;

    for (let bi = 0; bi < w.buildings.length; bi++) {
      const b = w.buildings[bi];
      const n = b.ring.length / 2;
      if (n < 3) continue;

      // OSM rings arrive in arbitrary winding. Normalise to negative signed
      // area so the fixed wall-quad order below always faces OUTWARD; a copy,
      // never a mutation, because world.buildingAt() reads the original ring.
      const ring = signedArea(b.ring) > 0 ? reverseRing(b.ring) : b.ring;

      // Floor at the LOWEST ground under the footprint so nothing ever floats;
      // roof measured from the HIGHEST, so a hillside building keeps its full
      // height on the uphill side. On flat ground the two collapse to `h`.
      const floor = b.gm;
      const roof = b.gx + (b.base || 0) + b.h;

      const base = new THREE.Color(BUILDING_COLOR[b.kind] ?? BUILDING_COLOR.other);
      const wallC = base.clone();
      const roofC = base.clone().multiplyScalar(ROOF_TINT);

      const startVert = pos.length / 3;

      // walls
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = ring[i * 2], az = ring[i * 2 + 1];
        const bx = ring[j * 2], bz = ring[j * 2 + 1];
        pos.push(ax, floor, az, bx, floor, bz, ax, roof, az);
        pos.push(bx, floor, bz, bx, roof, bz, ax, roof, az);
        for (let k = 0; k < 6; k++) col.push(wallC.r, wallC.g, wallC.b);
        faceOwner.push(bi, bi);
      }

      // roof cap
      const roofStart = pos.length / 3;
      const tris = triangulate(ring);
      for (let i = 0; i < tris.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const p = tris[i + k] * 2;
          pos.push(ring[p], roof, ring[p + 1]);
          col.push(roofC.r, roofC.g, roofC.b);
        }
        faceOwner.push(bi);
      }

      this.buildings.push({ b, startVert, roofStart, endVert: pos.length / 3 });
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();

    this.buildingGeo = geo;
    this.faceOwner = Int32Array.from(faceOwner);
    this.buildingMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.buildingMesh.castShadow = true;
    this.buildingMesh.receiveShadow = true;
    this.scene.add(this.buildingMesh);

    this.applyGuessedShading();
  }

  /**
   * Dim buildings whose height we invented rather than read from OSM.
   * This is a data-honesty view: at a glance you can see how much of the
   * skyline is surveyed fact and how much is our default.
   */
  applyGuessedShading() {
    if (!this.buildingGeo) return;
    // Colours are always re-derived from the source data rather than mutated in
    // place, so toggling the view on and off is lossless.
    const col = this.buildingGeo.getAttribute('color');
    const arr = col.array;
    const base = new THREE.Color();
    for (const rec of this.buildings) {
      const b = rec.b;
      base.set(BUILDING_COLOR[b.kind] ?? BUILDING_COLOR.other);
      if (this.showGuessed && b.g) {
        // desaturate toward grey and darken slightly
        const l = base.r * 0.3 + base.g * 0.59 + base.b * 0.11;
        base.setRGB(
          base.r + (l - base.r) * 0.72,
          base.g + (l - base.g) * 0.72,
          base.b + (l - base.b) * 0.72
        ).multiplyScalar(0.9);
      }
      const roofStart = rec.roofStart ?? rec.endVert;
      for (let v = rec.startVert; v < rec.endVert; v++) {
        const isRoof = v >= roofStart;
        const m = isRoof ? ROOF_TINT : 1;
        arr[v * 3] = base.r * m;
        arr[v * 3 + 1] = base.g * m;
        arr[v * 3 + 2] = base.b * m;
      }
    }
    col.needsUpdate = true;
  }

  // ─── camera + frame ───────────────────────────────────────────────────────

  applyCamera() {
    const c = this.cam, w = this.world;
    c.fx = Math.max(w.x0, Math.min(w.x0 + w.width, c.fx));
    c.fz = Math.max(w.z0, Math.min(w.z0 + w.depth, c.fz));
    c.fy = w.heightAt(c.fx, c.fz);
    c.dist = Math.max(c.minDist, Math.min(c.maxDist, c.dist));
    c.pitch = Math.max(0.12, Math.min(1.45, c.pitch));

    const h = Math.cos(c.pitch) * c.dist;
    this.camera.position.set(
      c.fx + Math.sin(c.yaw) * h,
      c.fy + Math.sin(c.pitch) * c.dist,
      c.fz + Math.cos(c.yaw) * h
    );
    this.camera.lookAt(c.fx, c.fy + 4, c.fz);

    // Keep the shadow box on the focus point, sized to the current zoom.
    this._fitShadow(c.dist);
    const lift = Math.max(700, c.dist * 1.1);
    this.sun.position.set(c.fx - lift * 0.45, c.fy + lift, c.fz + lift * 0.62);
    this.sun.target.position.set(c.fx, c.fy, c.fz);
    this.sun.target.updateMatrixWorld();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.applyCamera();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Pick at normalised device coords. Returns {x, z, height, building|null}.
   * Buildings are picked from the merged mesh via the face->owner table.
   */
  pick(ndcX, ndcY) {
    this._raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    const hits = this._raycaster.intersectObjects([this.buildingMesh, this.terrain], false);
    if (!hits.length) return null;
    const hit = hits[0];
    const p = hit.point;
    let building = null;
    if (hit.object === this.buildingMesh && hit.faceIndex != null) {
      const bi = this.faceOwner[hit.faceIndex];
      if (bi != null && bi >= 0) building = this.world.buildings[bi];
    } else {
      building = this.world.buildingAt(p.x, p.z);
    }
    return { x: p.x, y: p.y, z: p.z, building };
  }
}


