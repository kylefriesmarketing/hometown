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
  }

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

  build() {
    const t0 = performance.now();
    this.buildTerrain();
    this.buildAreas();
    this.buildRoads();
    this.buildBuildings();
    this.buildTrees();
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

  buildRoads() {
    const groups = new Map();
    const w = this.world;

    const strip = (pts, width, style, g) => {
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
        g.pos.push(
          l0x, y(l0x, l0z), l0z,  l1x, y(l1x, l1z), l1z,  r0x, y(r0x, r0z), r0z,
          r0x, y(r0x, r0z), r0z,  l1x, y(l1x, l1z), l1z,  r1x, y(r1x, r1z), r1z
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
    if (this.world.waterways.length) {
      groups.set('_water', { pos: [], n: 0, style: { color: 0x35617f, y: Y.water } });
      for (const ww of this.world.waterways) strip(ww.pts, ww.w, groups.get('_water').style, groups.get('_water'));
    }
    if (this.world.rails.length) {
      groups.set('_rail', { pos: [], n: 0, style: { color: 0x605649, y: Y.rail } });
      for (const rl of this.world.rails) strip(rl.pts, 4.2, groups.get('_rail').style, groups.get('_rail'));
    }

    this.roadMeshes = [];
    for (const [, g] of groups) {
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
      } else {
        const v = data.valueAt(i);           // 0..1, or null to grey out
        if (v === null) { wall = 0x9a948c; roof = 0x7d7871; }
        else {
          tmp.setHSL(data.hueFor(v), 0.62, 0.28 + 0.34 * v);
          wall = tmp.getHex();
          roof = tmp.clone().multiplyScalar(0.78).getHex();
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

  /** Pick at normalised device coords. Returns {x, y, z, building}|null. */
  pick(ndcX, ndcY) {
    this._raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    const hits = this._raycaster.intersectObjects([this.buildingMesh, this.terrain], false);
    if (!hits.length) return null;
    const hit = hits[0];
    const p = hit.point;
    let building = null, index = -1;
    if (hit.object === this.buildingMesh && hit.faceIndex != null) {
      index = this.faceOwner[hit.faceIndex];
      if (index >= 0) building = this.world.buildings[index];
    } else {
      building = this.world.buildingAt(p.x, p.z);
      if (building) index = this.world.buildings.indexOf(building);
    }
    return { x: p.x, y: p.y, z: p.z, building, index };
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

function pointInFlatRing(px, pz, r) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
    if ((zi > pz) !== (zj > pz) && px < (xj - xi) * (pz - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
