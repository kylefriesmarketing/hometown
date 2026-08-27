// view.js — everything you can see. Reads the World, writes pixels.
//
// ⚠️ VIEW-ONLY BY CONTRACT. Nothing in this file may be read by sim.js, and
//    nothing here may write world or sim state.
//
// Draw-call budget is the whole design: a dense world is ~6k buildings and ~4k
// roads, so everything is merged into a handful of BufferGeometries grouped by
// material. One mesh for all buildings, one per road tier, one per area kind,
// and a single InstancedMesh for every tree.

import * as THREE from './lib/three.module.js';
import { triangulate, ribbon, simplify, signedArea, reverseRing } from './geom.js';
import {
  hash01, wallColour, roofColour, GROUND, SKY, SUN, AMBIENT, FILL,
  FOLIAGE, TRUNK, TREE_DENSITY,
} from './palette.js';
import { TRANSIT } from './data.js';
import { Traffic } from './traffic.js';

// Vertical layering — small, fixed offsets so draped surfaces never z-fight.
// ⚠️ `foot` sits BELOW `road` on purpose. A well-mapped city tags every
//    sidewalk, so footways outnumber roadway ways several to one; drawn on top
//    they bury the actual street grid under a pale web. Roads win overlaps.
// Safe to keep these small because world.heightAt() samples the SAME surface
// the terrain mesh renders — see the warning on heightAt before changing them.
const Y = { area: 0.05, water: 0.09, foot: 0.13, rail: 0.18, road: 0.22 };

const AREA_STYLE = {
  water:      { color: 0x35617f, y: Y.water },
  park:       { color: 0x5f8f4a, y: Y.area },
  wood:       { color: 0x46733a, y: Y.area },
  cemetery:   { color: 0x6f8f5e, y: Y.area },
  sport:      { color: 0x74a05c, y: Y.area },
  parking:    { color: 0x8f8b85, y: Y.area },
  sand:       { color: 0xd9c7a0, y: Y.area },
  rock:       { color: 0x9c958c, y: Y.area },
  farm:       { color: 0xbdb173, y: Y.area },
  industrial: { color: 0x9c968f, y: Y.area },
  commercial: { color: 0xa39ea8, y: Y.area },
  residential:{ color: 0xa8a396, y: Y.area },
};

const ROAD_STYLE = {
  highway:  { color: 0x3e4147, y: Y.road },
  arterial: { color: 0x474a51, y: Y.road },
  street:   { color: 0x515459, y: Y.road },
  service:  { color: 0x5c5f64, y: Y.road },
  foot:     { color: 0x8a857c, y: Y.foot },
};

/** Wall shading: how dark the base of a wall is, and over what height. */
const WALL_AO = { floor: 0.70, riseM: 7 };

export class View {
  constructor(canvas, world) {
    this.canvas = canvas;
    this.world = world;
    this.showGuessed = false;     // dim buildings whose height we invented
    this.overlay = 'none';
    this.buildings = [];          // {b, i, startVert, roofStart, endVert}

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // ⚠️ The shadow map re-renders the WHOLE scene. On a 17,000-building city
    // that is 435k triangles redrawn every frame for a sun that has not moved —
    // measured at 4.1 ms of a 5.1 ms frame. Refresh it only when the camera has
    // actually moved enough to matter, or when geometry changes.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(SKY.fog, world.width * 0.9, world.width * 2.6);

    this.camera = new THREE.PerspectiveCamera(46, 1, 1, world.width * 4);

    this.cam = {
      fx: 0, fz: 0,
      dist: Math.min(900, world.width * 0.5),
      yaw: -0.6, pitch: 0.62,
      minDist: 25, maxDist: world.width * 1.1,
    };
    this.cam.fy = world.heightAt(0, 0);

    this.traffic = null;
    this.lifeOf = null;     // i -> 0..1 occupancy, set by the game layer

    this._sky();
    this._lights();
    this._raycaster = new THREE.Raycaster();
    this.resize();
  }

  // ─── sky & light ──────────────────────────────────────────────────────────

  /** Gradient dome. A flat background colour is the flattest thing in a scene. */
  _sky() {
    const geo = new THREE.SphereGeometry(this.world.width * 1.8, 24, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(SKY.top) },
        horizon: { value: new THREE.Color(SKY.horizon) },
        ground: { value: new THREE.Color(SKY.ground) },
      },
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 top; uniform vec3 horizon; uniform vec3 ground;
        varying vec3 vPos;
        void main() {
          float h = normalize(vPos).y;
          vec3 c = h > 0.0
            ? mix(horizon, top, pow(clamp(h, 0.0, 1.0), 0.55))
            : mix(horizon, ground, pow(clamp(-h, 0.0, 1.0), 0.5));
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.skyDome = new THREE.Mesh(geo, mat);
    this.skyDome.frustumCulled = false;
    this.scene.add(this.skyDome);
  }

  _lights() {
    this.scene.add(new THREE.HemisphereLight(AMBIENT.sky, AMBIENT.ground, AMBIENT.intensity));

    const sun = new THREE.DirectionalLight(SUN.colour, SUN.intensity);
    sun.castShadow = true;
    sun.shadow.camera.near = 20;
    sun.shadow.camera.far = 4000;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0009;
    sun.shadow.normalBias = 0.5;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    // ⚠️ Fill light, no shadows. Without it every surface facing away from the
    // sun is lit ONLY by the blue hemisphere term, so shaded faces of tall
    // buildings collapse to near-black navy and towers read as monoliths.
    // Cheap, and it is what separates "in shadow" from "unlit".
    const fill = new THREE.DirectionalLight(FILL.colour, FILL.intensity);
    fill.position.set(
      Math.cos(SUN.azimuth + Math.PI) * 800,
      420,
      Math.sin(SUN.azimuth + Math.PI) * 800
    );
    this.scene.add(fill);
    this.fill = fill;

    this._shadowSpan = 0;
    this._shadowAt = null;      // camera focus/zoom the current shadow map was built for
  }

  /** Force a shadow refresh — call after anything that changes geometry. */
  invalidateShadows() { this.renderer.shadowMap.needsUpdate = true; }

  /**
   * Size the shadow frustum to what the camera can actually see.
   *
   * ⚠️ A fixed box is the trap here: anything OUTSIDE the shadow camera samples
   * beyond the shadow map and comes back fully shadowed, so a zoomed-out view
   * renders every distant building solid black. It reads as a lighting bug but
   * it is a frustum-coverage bug. Span tracks zoom so coverage always holds,
   * quantised so the projection is not rebuilt every frame.
   */
  _fitShadow(dist) {
    const span = Math.max(160, Math.min(1500, dist * 0.95));
    const q = Math.round(span / 60) * 60;
    if (q === this._shadowSpan) return;
    this._shadowSpan = q;
    const c = this.sun.shadow.camera;
    c.left = -q; c.right = q; c.top = q; c.bottom = -q;
    c.updateProjectionMatrix();
  }

  // ─── build ────────────────────────────────────────────────────────────────

  /** The graph must be known before build() so traffic can be created with it. */
  useGraph(graph) { this._graph = graph; }

  build() {
    const t0 = performance.now();
    this.buildTerrain();
    this.buildAreas();
    this.buildRoads();
    this.buildBuildings();
    this.buildTrees();
    this.traffic = new Traffic(this.world, this._graph, this.scene);
    return performance.now() - t0;
  }

  buildTerrain() {
    const w = this.world;
    const { cols, rows, cell } = w;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(cols * rows * 3);
    const col = new Float32Array(cols * rows * 3);
    const span = Math.max(1, w.maxH - w.minH);
    const lerp = (a, b, t) => a + (b - a) * t;

    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const n = j * cols + i;
        const x = w.x0 + i * cell, z = w.z0 + j * cell;
        const h = w.heights[n];
        pos[n * 3] = x; pos[n * 3 + 1] = h; pos[n * 3 + 2] = z;

        // Ground between buildings should read as ground and never compete with
        // the city on top of it — a muted green that dries out slightly with
        // height, rockier where it is steep, plus a little stable per-cell
        // variation so a big flat area is not one dead colour.
        const t = (h - w.minH) / span;
        const rock = Math.min(1, w.slopeAt(x, z) / 0.55);
        const noise = (hash01(n, 21) - 0.5) * 0.045;

        let r = lerp(GROUND.lowGreen[0], GROUND.highGreen[0], t);
        let g = lerp(GROUND.lowGreen[1], GROUND.highGreen[1], t);
        let b = lerp(GROUND.lowGreen[2], GROUND.highGreen[2], t);
        r = lerp(r, GROUND.rock[0], rock); g = lerp(g, GROUND.rock[1], rock); b = lerp(b, GROUND.rock[2], rock);
        if (h <= 0.2) { r = GROUND.wet[0]; g = GROUND.wet[1]; b = GROUND.wet[2]; }

        col[n * 3] = Math.max(0, r + noise);
        col[n * 3 + 1] = Math.max(0, g + noise);
        col[n * 3 + 2] = Math.max(0, b + noise);
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

    this.terrain = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
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
      this._drapeRing(a.ring, style.y, groups.get(a.k).pos, groups.get(a.k));
    }

    this.areaMeshes = [];
    for (const [kind, g] of groups) {
      if (!g.n) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
        color: g.style.color,
        transparent: kind === 'water',
        opacity: kind === 'water' ? 0.9 : 1,
      }));
      mesh.receiveShadow = true;
      mesh.renderOrder = 1;
      this.scene.add(mesh);
      this.areaMeshes.push(mesh);
    }
  }

  /**
   * Streets.
   *
   * Drivable roads go into ONE vertex-coloured mesh, not one per class, because
   * the player edits individual streets and we need a per-street vertex range in
   * order to recolour or hide one. Footways, rail and rivers keep their own
   * meshes — they are never edited.
   */
  buildRoads() {
    const w = this.world;
    const c = new THREE.Color();
    this.roadRange = new Map();          // world.roads index -> {start, end}

    const strip = (pts, width, style, out, roadIndex) => {
      const simple = simplify(pts, 0.6);
      if (simple.length < 4) return;
      const { left, right } = ribbon(simple, width);
      const n = simple.length / 2;
      for (let i = 0; i < n - 1; i++) {
        const y = (px, pz) => w.heightAt(px, pz) + style.y;
        const l0x = left[i * 2], l0z = left[i * 2 + 1];
        const r0x = right[i * 2], r0z = right[i * 2 + 1];
        const l1x = left[(i + 1) * 2], l1z = left[(i + 1) * 2 + 1];
        const r1x = right[(i + 1) * 2], r1z = right[(i + 1) * 2 + 1];
        // Wound L,L,R / R,L,R so the ribbon faces UP — see the winding warning
        // in geom.triangulate; the mirrored order is culled from above.
        out.pos.push(
          l0x, y(l0x, l0z), l0z,  l1x, y(l1x, l1z), l1z,  r0x, y(r0x, r0z), r0z,
          r0x, y(r0x, r0z), r0z,  l1x, y(l1x, l1z), l1z,  r1x, y(r1x, r1z), r1z
        );
        if (out.col) {
          c.setHex(style.color);
          for (let k = 0; k < 6; k++) out.col.push(c.r, c.g, c.b);
        }
        if (out.faceRoad) out.faceRoad.push(roadIndex, roadIndex);
        out.n += 6;
      }
    };

    // ── the drivable network, one mesh ──────────────────────────────────────
    const drive = { pos: [], col: [], faceRoad: [], n: 0 };
    for (let i = 0; i < w.roads.length; i++) {
      const r = w.roads[i];
      const style = ROAD_STYLE[r.k];
      if (!style || r.k === 'foot') continue;
      const from = drive.pos.length / 3;
      strip(r.pts, r.w, style, drive, i);
      const to = drive.pos.length / 3;
      if (to > from) this.roadRange.set(i, { start: from, end: to });
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(drive.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(drive.col, 3));
    geo.computeVertexNormals();
    this.roadGeo = geo;
    this.roadBasePos = Float32Array.from(drive.pos);   // to restore a torn street
    this.roadFace = Int32Array.from(drive.faceRoad);
    this.roadMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.roadMesh.receiveShadow = true;
    this.roadMesh.renderOrder = 2;
    this.scene.add(this.roadMesh);

    // ── everything that is never edited ─────────────────────────────────────
    this.roadMeshes = [this.roadMesh];
    const extras = [
      { list: w.roads.filter(r => r.k === 'foot'), style: ROAD_STYLE.foot, width: r => r.w },
      { list: w.waterways, style: { color: 0x35617f, y: Y.water }, width: r => r.w },
      { list: w.rails, style: { color: 0x605649, y: Y.rail }, width: () => 4.2 },
    ];
    for (const ex of extras) {
      if (!ex.list.length) continue;
      const out = { pos: [], n: 0 };
      for (const r of ex.list) strip(r.pts, ex.width(r), ex.style, out, -1);
      if (!out.n) continue;
      const g2 = new THREE.BufferGeometry();
      g2.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
      g2.computeVertexNormals();
      const m = new THREE.Mesh(g2, new THREE.MeshLambertMaterial({ color: ex.style.color }));
      m.receiveShadow = true;
      m.renderOrder = 2;
      this.scene.add(m);
      this.roadMeshes.push(m);
    }
  }

  /**
   * Repaint streets from sim state. Closed streets go amber, torn-out streets
   * collapse to zero-area triangles so they vanish without rebuilding the mesh.
   */
  paintRoads(state, lanes, selected) {
    if (!this.roadGeo) return;
    const posAttr = this.roadGeo.getAttribute('position');
    const colAttr = this.roadGeo.getAttribute('color');
    const P = posAttr.array, C = colAttr.array, B = this.roadBasePos;
    const c = new THREE.Color();

    for (const [roadIndex, range] of this.roadRange) {
      const st = state ? state[roadIndex] : 0;
      const isSel = selected && selected.has(roadIndex);
      const wide = lanes ? lanes[roadIndex] : 1;

      if (st === 2) {
        // torn out: collapse every triangle onto its own first vertex
        for (let vtx = range.start; vtx < range.end; vtx += 3) {
          for (let k = 1; k < 3; k++) {
            P[(vtx + k) * 3] = P[vtx * 3];
            P[(vtx + k) * 3 + 1] = P[vtx * 3 + 1];
            P[(vtx + k) * 3 + 2] = P[vtx * 3 + 2];
          }
        }
        continue;
      }

      // restore geometry — it may have been collapsed on an earlier pass
      for (let k = range.start * 3; k < range.end * 3; k++) P[k] = B[k];

      if (isSel) c.setHex(0x63c6ff);
      else if (st === 1) c.setHex(0xd8a13c);
      else if (wide > 1.01) c.setHex(0x6f7a86);
      else if (wide < 0.99) c.setHex(0x484b50);
      else c.setHex(0x515459);

      for (let vtx = range.start; vtx < range.end; vtx++) {
        C[vtx * 3] = c.r; C[vtx * 3 + 1] = c.g; C[vtx * 3 + 2] = c.b;
      }
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    this.roadGeo.computeVertexNormals();
    this.invalidateShadows();     // a torn-out street changes the silhouette
  }

  buildBuildings() {
    const w = this.world;
    const pos = [], col = [], faceOwner = [], ao = [];
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
      const height = Math.max(0.5, roof - floor);

      const startVert = pos.length / 3;

      // walls — `ao` carries a 0..1 "how lit is this vertex" so recolouring can
      // darken the base without re-deriving geometry.
      //
      // ⚠️ A tall wall is SPLIT at WALL_AO.riseM. Emitting one quad per storey-
      // less wall would stretch the contact gradient over the whole building, so
      // a 60 m tower darkens across all 60 m and reads as a black monolith
      // instead of a lit tower standing in a shadow. The split keeps the dark
      // band a fixed few metres tall no matter how tall the building is.
      const splitY = floor + WALL_AO.riseM;
      const tall = height > WALL_AO.riseM * 1.05;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = ring[i * 2], az = ring[i * 2 + 1];
        const bx = ring[j * 2], bz = ring[j * 2 + 1];

        if (tall) {
          // contact band: dark at the ground, fully lit at splitY
          pos.push(ax, floor, az, bx, floor, bz, ax, splitY, az);
          pos.push(bx, floor, bz, bx, splitY, bz, ax, splitY, az);
          ao.push(0, 0, 1, 0, 1, 1);
          // the rest of the wall, evenly lit
          pos.push(ax, splitY, az, bx, splitY, bz, ax, roof, az);
          pos.push(bx, splitY, bz, bx, roof, bz, ax, roof, az);
          ao.push(1, 1, 1, 1, 1, 1);
          for (let k = 0; k < 12; k++) col.push(1, 1, 1);
          faceOwner.push(bi, bi, bi, bi);
        } else {
          pos.push(ax, floor, az, bx, floor, bz, ax, roof, az);
          pos.push(bx, floor, bz, bx, roof, bz, ax, roof, az);
          const t = Math.min(1, height / WALL_AO.riseM);
          ao.push(0, 0, t, 0, t, t);
          for (let k = 0; k < 6; k++) col.push(1, 1, 1);
          faceOwner.push(bi, bi);
        }
      }

      // roof cap
      const roofStart = pos.length / 3;
      const tris = triangulate(ring);
      for (let i = 0; i < tris.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const p = tris[i + k] * 2;
          pos.push(ring[p], roof, ring[p + 1]);
          col.push(1, 1, 1); ao.push(1);
        }
        faceOwner.push(bi);
      }

      this.buildings.push({ b, i: bi, startVert, roofStart, endVert: pos.length / 3 });
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();

    this.buildingGeo = geo;
    this.buildingAO = Float32Array.from(ao);
    this.faceOwner = Int32Array.from(faceOwner);
    this.buildingMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.buildingMesh.castShadow = true;
    this.buildingMesh.receiveShadow = true;
    this.scene.add(this.buildingMesh);

    this.paintBuildings();
  }

  /**
   * Scatter trees through every green area.
   *
   * A city with no vegetation reads as a model, not a place. Placement uses a
   * stable hash rather than Math.random so the same world always grows the same
   * trees — screenshots stay comparable between runs.
   */
  buildTrees() {
    const w = this.world;
    const spots = [];
    const GREEN = new Set(['park', 'wood', 'sport', 'cemetery']);

    for (let ai = 0; ai < w.areas.length; ai++) {
      const a = w.areas[ai];
      if (!GREEN.has(a.k)) continue;
      const want = Math.min(400, Math.floor(a.a / TREE_DENSITY));
      if (want < 1) continue;

      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < a.ring.length; i += 2) {
        if (a.ring[i] < x0) x0 = a.ring[i]; if (a.ring[i] > x1) x1 = a.ring[i];
        if (a.ring[i + 1] < z0) z0 = a.ring[i + 1]; if (a.ring[i + 1] > z1) z1 = a.ring[i + 1];
      }

      // rejection-sample inside the ring; bounded so a thin sliver cannot spin
      let placed = 0;
      for (let t = 0; t < want * 12 && placed < want; t++) {
        const x = x0 + hash01(ai * 7919 + t, 31) * (x1 - x0);
        const z = z0 + hash01(ai * 7919 + t, 37) * (z1 - z0);
        if (!pointInFlatRing(x, z, a.ring)) continue;
        spots.push(x, z, ai * 7919 + t);
        placed++;
      }
    }

    this.treeCount = spots.length / 3;
    if (!this.treeCount) { this.trees = null; return; }

    const geo = treeGeometry();
    const mesh = new THREE.InstancedMesh(
      geo, new THREE.MeshLambertMaterial({ vertexColors: true }), this.treeCount);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    const p = new THREE.Vector3(), s = new THREE.Vector3();
    const c = new THREE.Color();
    for (let i = 0; i < this.treeCount; i++) {
      const x = spots[i * 3], z = spots[i * 3 + 1], seed = spots[i * 3 + 2];
      const scale = 0.7 + hash01(seed, 41) * 0.8;
      p.set(x, w.heightAt(x, z) - 0.2, z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash01(seed, 43) * Math.PI * 2);
      s.set(scale, scale * (0.85 + hash01(seed, 47) * 0.4), scale);
      mesh.setMatrixAt(i, m.compose(p, q, s));
      c.setHex(FOLIAGE[Math.floor(hash01(seed, 53) * FOLIAGE.length) % FOLIAGE.length]);
      mesh.setColorAt(i, c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    this.trees = mesh;
    this.scene.add(mesh);
  }

  /**
   * Build the sea surface from a flood mask — one quad per flooded cell.
   *
   * ⚠️ Deliberately NOT one big plane at y = level. The mask is a connected
   * flood from the map edge, so a big plane would also cover dry inland ground
   * that merely happens to sit below sea level, and anyone who knows the place
   * would spot it instantly.
   */
  buildWater(mask, level) {
    if (this.water) {
      this.scene.remove(this.water);
      this.water.geometry.dispose();
      this.water = null;
    }
    if (!mask) return 0;

    const w = this.world;
    const { cols, rows, cell } = w;
    const pos = [];
    let cells = 0;
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        if (!mask[j * cols + i]) continue;
        const x = w.x0 + i * cell, z = w.z0 + j * cell;
        const x1 = x + cell, z1 = z + cell;
        // wound to face UP, same convention as everything else here
        pos.push(x, level, z,  x, level, z1,  x1, level, z);
        pos.push(x1, level, z,  x, level, z1,  x1, level, z1);
        cells++;
      }
    }
    if (!cells) return 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    this.water = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      color: 0x2f6489, transparent: true, opacity: 0.82,
      depthWrite: false,
    }));
    this.water.renderOrder = 3;
    this.water.receiveShadow = true;
    this.scene.add(this.water);
    this.invalidateShadows();
    return cells;
  }


  /**
   * Transit lines, drawn ABOVE the buildings.
   *
   * A line is infrastructure the player placed, not part of the map, so it
   * deliberately does not drape or hide behind anything — it rides over the
   * city at a fixed height with depth testing off, the way a diagram would.
   */
  buildTransit(lines) {
    if (this.transitGroup) {
      this.scene.remove(this.transitGroup);
      this.transitGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    }
    this.transitGroup = new THREE.Group();
    this.transitGroup.renderOrder = 900;
    this.scene.add(this.transitGroup);
    if (!lines || !lines.length) return 0;

    const w = this.world;
    for (const line of lines) {
      const spec = TRANSIT.kinds[line.kind] || TRANSIT.kinds.tram;
      this._addLineMesh(line.stops, spec, 1);
      void w;
    }
    this.invalidateShadows();
    return lines.length;
  }

  /** The line currently being drawn, shown translucent until it is finished. */
  setDraftLine(draft) {
    if (this.draftGroup) {
      this.scene.remove(this.draftGroup);
      this.draftGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      this.draftGroup = null;
    }
    if (!draft || !draft.stops.length) return;
    const spec = TRANSIT.kinds[draft.kind] || TRANSIT.kinds.tram;
    this.draftGroup = new THREE.Group();
    this.draftGroup.renderOrder = 901;
    this.scene.add(this.draftGroup);
    this._addLineMesh(draft.stops, spec, 0.55, this.draftGroup);
  }

  _addLineMesh(stops, spec, opacity, group = this.transitGroup) {
    const w = this.world;
    const LIFT = 14;                     // metres above the ground, clear of most roofs
    const y = (x, z) => w.heightAt(x, z) + LIFT;

    // the ribbon
    if (stops.length >= 2) {
      const flat = stops.flat();
      const { left, right } = ribbon(flat, spec.width);
      const pos = [];
      for (let i = 0; i < stops.length - 1; i++) {
        const l0 = [left[i * 2], left[i * 2 + 1]], r0 = [right[i * 2], right[i * 2 + 1]];
        const l1 = [left[(i + 1) * 2], left[(i + 1) * 2 + 1]], r1 = [right[(i + 1) * 2], right[(i + 1) * 2 + 1]];
        pos.push(
          l0[0], y(...l0), l0[1], l1[0], y(...l1), l1[1], r0[0], y(...r0), r0[1],
          r0[0], y(...r0), r0[1], l1[0], y(...l1), l1[1], r1[0], y(...r1), r1[1]
        );
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: spec.colour, transparent: true, opacity,
        depthTest: false, side: THREE.DoubleSide,
      })));
    }

    // a marker per stop
    const stopGeo = new THREE.CylinderGeometry(spec.width * 0.9, spec.width * 0.9, 2.5, 10);
    const stopMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: Math.min(1, opacity + 0.2), depthTest: false,
    });
    const marks = new THREE.InstancedMesh(stopGeo, stopMat, stops.length);
    const mtx = new THREE.Matrix4();
    stops.forEach(([x, z], i) => {
      mtx.makeTranslation(x, y(x, z) + 1.6, z);
      marks.setMatrixAt(i, mtx);
    });
    marks.instanceMatrix.needsUpdate = true;
    group.add(marks);
  }


  /**
   * The clickable problems — Plague Inc's bubbles, but derived from the model
   * rather than rolled, so every one of them is telling the truth about the
   * city. Drawn as sprites so they always face the camera and stay legible at
   * any zoom, with depthTest off so a problem is never hidden behind a tower.
   */
  buildBubbles(bubbles) {
    if (!this._bubbleGroup) {
      this._bubbleGroup = new THREE.Group();
      this._bubbleGroup.renderOrder = 950;
      this.scene.add(this._bubbleGroup);
      this._bubbleTex = {};
    }
    // reuse sprites; a bubble list is at most a handful
    while (this._bubbleGroup.children.length > bubbles.length) {
      this._bubbleGroup.remove(this._bubbleGroup.children[this._bubbleGroup.children.length - 1]);
    }
    this.bubbles = bubbles;

    for (let i = 0; i < bubbles.length; i++) {
      const b = bubbles[i];
      let sp = this._bubbleGroup.children[i];
      if (!sp) {
        sp = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, transparent: true }));
        this._bubbleGroup.add(sp);
      }
      const key = b.kind;
      if (!this._bubbleTex[key]) this._bubbleTex[key] = makeBubbleTexture(key);
      sp.material.map = this._bubbleTex[key];
      sp.material.needsUpdate = true;
      const y = this.world.heightAt(b.x, b.z);
      sp.position.set(b.x, y + 48, b.z);
      const s = Math.max(26, this.cam.dist * 0.055);
      sp.scale.set(s, s, 1);
      sp.userData.key = b.key;
    }
  }

  /** Screen position of a world point, in CSS pixels. */
  project(x, y, z) {
    const v3 = new THREE.Vector3(x, y, z).project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (v3.x * 0.5 + 0.5) * r.width,
      y: (-v3.y * 0.5 + 0.5) * r.height,
      behind: v3.z > 1,
    };
  }

  /**
   * Which problem was clicked, if any. Screen-space distance rather than a
   * raycast: sprites are billboards with no useful geometry to hit, and a
   * generous radius is what makes them feel tappable.
   */
  bubbleAt(px, py, radius = 34) {
    if (!this._bubbleGroup) return null;
    let best = null, bestD = radius * radius;
    for (const sp of this._bubbleGroup.children) {
      const p = this.project(sp.position.x, sp.position.y, sp.position.z);
      if (p.behind) continue;
      const d = (p.x - px) ** 2 + (p.y - py) ** 2;
      if (d < bestD) { bestD = d; best = sp.userData.key; }
    }
    return best;
  }

  // ─── colouring ────────────────────────────────────────────────────────────

  /**
   * Paint every building. `overlay` selects what the colour MEANS; `data`
   * carries per-building values for sim overlays (occupancy, desirability…).
   *
   * Colours are always re-derived from source data rather than mutated in
   * place, so switching overlays back and forth is lossless.
   */
  paintBuildings(overlay = this.overlay, data = null) {
    if (!this.buildingGeo) return;
    this.overlay = overlay;
    const attr = this.buildingGeo.getAttribute('color');
    const arr = attr.array;
    const ao = this.buildingAO;
    const c = new THREE.Color();
    const tmp = new THREE.Color();

    for (const rec of this.buildings) {
      const b = rec.b, i = rec.i;
      let wall, roof;

      if (overlay === 'none' || !data) {
        wall = wallColour(i, b.kind, b.h);
        roof = roofColour(i);
        // ⚠️ THE CITY MUST SHOW ITS OWN STATE. Without this, a thriving block
        // and a dead one are pixel-identical and every consequence of a
        // player's action has to be read off a number in a bar. An empty
        // building goes grey and cold; a full one keeps its colour.
        if (this.lifeOf) {
          const life = this.lifeOf(i);
          if (life !== null && life < 0.85) {
            const k = Math.max(0, Math.min(1, 1 - life / 0.85));   // 0 lived-in, 1 derelict
            c.setHex(wall);
            const l = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
            wall = c.setRGB(c.r + (l - c.r) * 0.85 * k, c.g + (l - c.g) * 0.85 * k, c.b + (l - c.b) * 0.85 * k)
              .multiplyScalar(1 - 0.42 * k).getHex();
            c.setHex(roof);
            const lr = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
            roof = c.setRGB(c.r + (lr - c.r) * 0.85 * k, c.g + (lr - c.g) * 0.85 * k, c.b + (lr - c.b) * 0.85 * k)
              .multiplyScalar(1 - 0.35 * k).getHex();
          }
        }
      } else if (data.colourAt) {
        // categorical overlay (zoning): fixed colour per class
        const hex = data.colourAt(i);
        if (hex === null) { wall = 0x8f8a83; roof = 0x76716b; }
        else { wall = hex; roof = tmp.setHex(hex).multiplyScalar(0.76).getHex(); }
      } else {
        const v = data.valueAt(i);           // 0..1, or null to grey out
        if (v === null) { wall = 0x8f8a83; roof = 0x76716b; }
        else {
          tmp.setHSL(data.hueFor(v), 0.62, 0.30 + 0.32 * v);
          wall = tmp.getHex();
          roof = tmp.multiplyScalar(0.78).getHex();
        }
      }

      if (this.showGuessed && b.g) {
        // desaturate toward grey so invented heights are visible at a glance
        c.setHex(wall);
        const l = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
        wall = c.setRGB(c.r + (l - c.r) * 0.7, c.g + (l - c.g) * 0.7, c.b + (l - c.b) * 0.7).getHex();
      }

      const roofStart = rec.roofStart;
      for (let v = rec.startVert; v < rec.endVert; v++) {
        const isRoof = v >= roofStart;
        c.setHex(isRoof ? roof : wall);
        if (!isRoof) {
          // darken toward the base of the wall — cheap ambient occlusion that
          // does more for perceived depth than any amount of extra geometry
          const k = WALL_AO.floor + (1 - WALL_AO.floor) * ao[v];
          c.multiplyScalar(k);
        }
        arr[v * 3] = c.r; arr[v * 3 + 1] = c.g; arr[v * 3 + 2] = c.b;
      }
    }
    attr.needsUpdate = true;
  }

  /** Back-compat shim for the guessed-height toggle. */
  applyGuessedShading() { this.paintBuildings(this.overlay, this._overlayData || null); }

  setOverlay(overlay, data) {
    this._overlayData = data || null;
    this.paintBuildings(overlay, this._overlayData);
  }

  // ─── camera + frame ───────────────────────────────────────────────────────

  applyCamera() {
    const c = this.cam, w = this.world;
    c.fx = Math.max(w.x0, Math.min(w.x0 + w.width, c.fx));
    c.fz = Math.max(w.z0, Math.min(w.z0 + w.depth, c.fz));
    c.fy = w.heightAt(c.fx, c.fz);
    c.dist = Math.max(c.minDist, Math.min(c.maxDist, c.dist));
    c.pitch = Math.max(0.10, Math.min(1.45, c.pitch));

    const h = Math.cos(c.pitch) * c.dist;
    this.camera.position.set(
      c.fx + Math.sin(c.yaw) * h,
      c.fy + Math.sin(c.pitch) * c.dist,
      c.fz + Math.cos(c.yaw) * h
    );
    this.camera.lookAt(c.fx, c.fy + 4, c.fz);
    this.skyDome.position.copy(this.camera.position);

    this._fitShadow(c.dist);
    const lift = Math.max(900, c.dist * 1.4);
    this.sun.position.set(
      c.fx + Math.cos(SUN.azimuth) * lift * Math.cos(SUN.elevation),
      c.fy + lift * Math.sin(SUN.elevation),
      c.fz + Math.sin(SUN.azimuth) * lift * Math.cos(SUN.elevation)
    );
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

  /** Cars move every frame; nothing else here does. */
  animate(dt) { if (this.traffic) this.traffic.update(dt); }

  /** Pick at normalised device coords. Returns {x, y, z, building}|null. */
  pick(ndcX, ndcY) {
    this._raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    const targets = [this.buildingMesh, this.roadMesh, this.terrain].filter(Boolean);
    const hits = this._raycaster.intersectObjects(targets, false);
    if (!hits.length) return null;
    const hit = hits[0];
    const p = hit.point;
    const out = { x: p.x, y: p.y, z: p.z, building: null, index: -1, road: null, roadIndex: -1 };

    if (hit.object === this.buildingMesh && hit.faceIndex != null) {
      out.index = this.faceOwner[hit.faceIndex];
      if (out.index >= 0) out.building = this.world.buildings[out.index];
    } else if (hit.object === this.roadMesh && hit.faceIndex != null) {
      out.roadIndex = this.roadFace[hit.faceIndex];
      if (out.roadIndex >= 0) out.road = this.world.roads[out.roadIndex];
    } else {
      out.building = this.world.buildingAt(p.x, p.z);
      if (out.building) out.index = this.world.buildings.indexOf(out.building);
    }
    return out;
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** A low-poly tree: tapered trunk plus two offset foliage masses. */
function treeGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.16, 0.26, 2.4, 6);
  trunk.translate(0, 1.2, 0);
  paintGeo(trunk, TRUNK);
  parts.push(trunk);

  const c1 = new THREE.IcosahedronGeometry(1.55, 0);
  c1.scale(1, 1.15, 1); c1.translate(0, 3.1, 0);
  paintGeo(c1, 0xffffff);          // instance colour tints the foliage
  parts.push(c1);

  const c2 = new THREE.IcosahedronGeometry(1.05, 0);
  c2.translate(0.55, 4.0, -0.3);
  paintGeo(c2, 0xffffff);
  parts.push(c2);

  return mergeGeometries(parts);
}

/** Bake a flat colour into a geometry's vertex colours. */
function paintGeo(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

/** Minimal non-indexed merge — enough for the tree, no BufferGeometryUtils. */
function mergeGeometries(list) {
  const posArrays = [], colArrays = [], norArrays = [];
  let total = 0;
  for (const g of list) {
    const ng = g.index ? g.toNonIndexed() : g;
    ng.computeVertexNormals();
    posArrays.push(ng.getAttribute('position').array);
    colArrays.push(ng.getAttribute('color').array);
    norArrays.push(ng.getAttribute('normal').array);
    total += ng.getAttribute('position').count;
  }
  const pos = new Float32Array(total * 3), col = new Float32Array(total * 3), nor = new Float32Array(total * 3);
  let o = 0;
  for (let i = 0; i < posArrays.length; i++) {
    pos.set(posArrays[i], o); col.set(colArrays[i], o); nor.set(norArrays[i], o);
    o += posArrays[i].length;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return geo;
}

const BUBBLE_LOOK = {
  jam:      { icon: '🚗', ring: '#e0663c' },
  unserved: { icon: '🎓', ring: '#d8a13c' },
  vacant:   { icon: '🏚️', ring: '#8a93a6' },
};

/** A round badge with an icon — drawn once per kind and reused. */
function makeBubbleTexture(kind) {
  const look = BUBBLE_LOOK[kind] || BUBBLE_LOOK.jam;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');

  g.beginPath(); g.arc(S / 2, S / 2, S * 0.40, 0, Math.PI * 2);
  g.fillStyle = 'rgba(16,22,30,0.86)'; g.fill();
  g.lineWidth = S * 0.075; g.strokeStyle = look.ring; g.stroke();

  g.font = `${S * 0.42}px system-ui, "Segoe UI Emoji", sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(look.icon, S / 2, S / 2 + S * 0.02);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function pointInFlatRing(px, pz, r) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
    if ((zi > pz) !== (zj > pz) && px < (xj - xi) * (pz - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
