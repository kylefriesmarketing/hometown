// traffic.js — cars you can watch.
//
// ⚠️ VIEW-ONLY. Nothing here touches sim state, and `Math.random` is fine here
// and nowhere in sim.js. Cars are decoration in the strict sense — but they are
// decoration DRIVEN BY the simulation: how many cars sit on a street is drawn
// from that street's actual assigned load, so a jam you can see is a jam the
// model believes in. That is the whole point. A city with no moving traffic
// reads as a diorama, and every consequence of a player's action has to be read
// off a number in a bar instead of watched.

import * as THREE from './lib/three.module.js';

const CAR_COLOURS = [
  0xd8d8d8, 0x2f3640, 0x8a9199, 0xb43a3a, 0x2d5f9a,
  0xe0e0e0, 0x4a4f57, 0xc9c4bb, 0x35704f, 0xd2a24c,
];

export class Traffic {
  /**
   * @param {number} max  hard ceiling on cars, whatever the city size —
   *                      density is expressed by DISTRIBUTION, not by count.
   */
  constructor(world, graph, scene, max = 2200) {
    this.world = world;
    this.graph = graph;
    this.scene = scene;
    this.max = max;
    this.enabled = true;
    this.count = 0;

    this.edge = new Int32Array(max);
    this.t = new Float32Array(max);
    this.dir = new Int8Array(max);
    this.speed = new Float32Array(max);   // metres per second
    this.lane = new Float32Array(max);    // lateral offset

    this._mesh = null;
    this._mtx = new THREE.Matrix4();
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._scl = new THREE.Vector3(1, 1, 1);
    this._up = new THREE.Vector3(0, 1, 0);
    this._build();
  }

  _build() {
    if (this._mesh) {
      this.scene.remove(this._mesh);
      this._mesh.geometry.dispose();
      this._mesh.material.dispose();
    }
    // A car is a box with a slightly narrower cabin — enough silhouette to read
    // at the zoom people actually play at, and cheap enough to draw thousands.
    // Deliberately OVERSIZED, about 1.7x. A real 4.4 m car viewed from the 400 m
    // a player actually plays at is two pixels; every city builder inflates its
    // vehicles for the same reason. Read beats accuracy here.
    const geo = new THREE.BoxGeometry(3.2, 2.4, 7.4);
    geo.translate(0, 1.2, 0);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: false });
    this._mesh = new THREE.InstancedMesh(geo, mat, this.max);
    this._mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 3), 3);
    this._mesh.castShadow = false;      // thousands of shadow casters is not worth it
    this._mesh.receiveShadow = false;
    this._mesh.frustumCulled = false;
    this._mesh.count = 0;
    this.scene.add(this._mesh);
  }

  /**
   * Redistribute cars across the network in proportion to assigned load.
   *
   * Called whenever the traffic model has meaningfully changed — not every
   * frame. Cars are placed by walking a cumulative-load table, so a street
   * carrying twice the flow gets twice the cars.
   */
  sync() {
    const g = this.graph;
    const drivable = [], cum = [];
    let total = 0;
    for (let e = 0; e < g.edgeCount; e++) {
      if (g.isTransit && g.isTransit[e]) continue;   // rail is not car traffic
      if (g._shut && g._shut[e]) continue;           // flooded or torn out
      const l = g.load[e];
      if (l <= 0.01 || g.elen[e] < 4) continue;
      total += l;
      drivable.push(e);
      cum.push(total);
    }

    if (!drivable.length || total <= 0) {
      this.count = 0;
      if (this._mesh) this._mesh.count = 0;
      return 0;
    }

    // Scale the fleet with how busy the city is, up to the ceiling, so an empty
    // town looks empty rather than being given a token car per street.
    const want = Math.min(this.max, Math.max(120, Math.round(total / 14)));
    const colour = new THREE.Color();

    for (let i = 0; i < want; i++) {
      // pick an edge weighted by load
      const r = Math.random() * total;
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
      const e = drivable[lo];

      this.edge[i] = e;
      this.t[i] = Math.random();
      this.dir[i] = Math.random() < 0.5 ? 1 : -1;
      this.speed[i] = this._speedOf(e);
      this.lane[i] = 2.0;
      colour.setHex(CAR_COLOURS[(Math.random() * CAR_COLOURS.length) | 0]);
      this._mesh.setColorAt(i, colour);
    }
    this.count = want;
    this._mesh.count = this.enabled ? want : 0;
    if (this._mesh.instanceColor) this._mesh.instanceColor.needsUpdate = true;
    return want;
  }

  /**
   * Metres per second on an edge, INCLUDING congestion.
   * A jammed street visibly crawls, which is the whole reason to draw cars.
   */
  _speedOf(e) {
    const g = this.graph;
    const mins = Math.max(1e-3, g.edgeTime(e));
    const mps = g.elen[e] / (mins * 60);
    return Math.max(1.5, Math.min(30, mps));
  }

  setEnabled(on) {
    this.enabled = on;
    if (this._mesh) this._mesh.count = on ? this.count : 0;
  }

  /** Advance every car. Cheap: a lerp, a heading and one matrix per car. */
  update(dt) {
    if (!this.enabled || !this.count) return;
    const g = this.graph, w = this.world;
    const m = this._mtx, p = this._pos, q = this._quat, s = this._scl;
    const step = Math.min(0.1, dt);

    for (let i = 0; i < this.count; i++) {
      let e = this.edge[i];
      const len = g.elen[e] || 1;
      this.t[i] += (this.speed[i] * step) / len;

      if (this.t[i] >= 1) {
        // Arrived at the far end: continue through the junction onto another
        // street, preferring a busy one. Re-picking the speed here is what makes
        // a car slow down when it turns onto a jammed road.
        const at = this.dir[i] === 1 ? g.eb[e] : g.ea[e];
        const next = this._pickNext(at, e);
        if (next < 0) {
          this.t[i] = 0;
          this.dir[i] = -this.dir[i];         // dead end: turn around
        } else {
          e = this.edge[i] = next;
          this.dir[i] = g.ea[next] === at ? 1 : -1;
          this.t[i] = 0;
          this.speed[i] = this._speedOf(next);
        }
      }

      const a = this.dir[i] === 1 ? g.ea[e] : g.eb[e];
      const b = this.dir[i] === 1 ? g.eb[e] : g.ea[e];
      const ax = g.nx[a], az = g.nz[a], bx = g.nx[b], bz = g.nz[b];
      const tt = this.t[i];
      let x = ax + (bx - ax) * tt;
      let z = az + (bz - az) * tt;

      // keep to one side of the centreline
      const dx = bx - ax, dz = bz - az;
      const inv = 1 / (Math.hypot(dx, dz) || 1);
      x += -dz * inv * this.lane[i];
      z += dx * inv * this.lane[i];

      p.set(x, w.heightAt(x, z) + 0.35, z);
      q.setFromAxisAngle(this._up, Math.atan2(dx, dz));
      m.compose(p, q, s);
      this._mesh.setMatrixAt(i, m);
    }
    this._mesh.instanceMatrix.needsUpdate = true;
  }

  /** Continue through a junction, favouring busier streets; avoid U-turns. */
  _pickNext(node, from) {
    const g = this.graph;
    const s = g.adjStart[node], end = g.adjStart[node + 1];
    let total = 0, fallback = -1;
    for (let k = s; k < end; k++) {
      const e = g.adjEdge[k];
      if (e === from) continue;
      if (g.isTransit && g.isTransit[e]) continue;
      if (g._shut && g._shut[e]) continue;
      total += Math.max(0.05, g.load[e]);
      fallback = e;
    }
    if (total <= 0) return fallback;
    let r = Math.random() * total;
    for (let k = s; k < end; k++) {
      const e = g.adjEdge[k];
      if (e === from) continue;
      if (g.isTransit && g.isTransit[e]) continue;
      if (g._shut && g._shut[e]) continue;
      r -= Math.max(0.05, g.load[e]);
      if (r <= 0) return e;
    }
    return fallback;
  }

  dispose() {
    if (!this._mesh) return;
    this.scene.remove(this._mesh);
    this._mesh.geometry.dispose();
    this._mesh.material.dispose();
    this._mesh = null;
  }
}
