// graph.js — the routable street network, derived from the baked roads.
//
// Pure: no three.js, no DOM, no randomness. Built once at load and then read by
// the sim every tick, so everything here is typed arrays and integer indices.
//
// ⚠️ TOPOLOGY COMES FROM COORDINATE IDENTITY, not from OSM node ids (the bake
//    does not carry them). Two ways that share an OSM junction project to the
//    same point and are rounded to the same 0.1 m, so an exact string key on the
//    rounded coordinate reconstructs the junction exactly. Measured on Russian
//    Hill: 911 shared coordinates with a 3/4/5-way degree histogram that matches
//    a real street grid. If the bake's coordinate rounding ever changes, this
//    assumption changes with it — see test.mjs, which guards connectivity.

import { ROAD_SPEED, ROAD_LANES, LANE_CAPACITY, BPR, TRANSIT, JUNCTION_DELAY, JUNCTION_MIN_DEGREE } from './data.js';

const key = (x, z) => x.toFixed(1) + ',' + z.toFixed(1);

/** Minimal binary min-heap over (priority, value) pairs. */
class Heap {
  constructor() { this.p = [0]; this.v = [0]; this.n = 0; }
  clear() { this.n = 0; }
  push(pri, val) {
    let i = ++this.n;
    this.p[i] = pri; this.v[i] = val;
    while (i > 1) {
      const par = i >> 1;
      if (this.p[par] <= this.p[i]) break;
      [this.p[par], this.p[i]] = [this.p[i], this.p[par]];
      [this.v[par], this.v[i]] = [this.v[i], this.v[par]];
      i = par;
    }
  }
  pop() {
    const top = this.v[1];
    this.p[1] = this.p[this.n]; this.v[1] = this.v[this.n];
    this.n--;
    let i = 1;
    for (;;) {
      const l = i << 1, r = l + 1;
      let m = i;
      if (l <= this.n && this.p[l] < this.p[m]) m = l;
      if (r <= this.n && this.p[r] < this.p[m]) m = r;
      if (m === i) break;
      [this.p[m], this.p[i]] = [this.p[i], this.p[m]];
      [this.v[m], this.v[i]] = [this.v[i], this.v[m]];
      i = m;
    }
    return top;
  }
  get size() { return this.n; }
}

export class RoadGraph {
  constructor(world) {
    this.world = world;
    this._build(world);
    // Everything built so far is the ROAD network and never changes. Transit is
    // appended on top, so base edge indices 0..baseEdgeCount-1 stay stable and
    // every per-edge array can simply be extended rather than remapped.
    this.baseNodeCount = this.nodeCount;
    this.baseEdgeCount = this.edgeCount;
    this._base = {
      nx: this.nx, nz: this.nz, ea: this.ea, eb: this.eb,
      elen: this.elen, espeed: this.espeed, ecap: this.ecap,
      eroad: this.eroad, freeTime: this.freeTime,
    };
    this.lines = [];
    this.isTransit = new Uint8Array(this.edgeCount);

    this.load = new Float32Array(this.edgeCount);      // vehicles per hour, per edge
    // Two INDEPENDENT reasons an edge can be shut, kept apart on purpose: the
    // sea receding must not reopen a street the player closed, and reopening a
    // street must not undo a flood. `_shut` is the OR of the two.
    this.blockedFlood = new Uint8Array(this.edgeCount);
    this.blockedPlayer = new Uint8Array(this.edgeCount);
    this._shut = new Uint8Array(this.edgeCount);
    this.capMul = new Float32Array(this.edgeCount).fill(1);
    // Dijkstra scratch, reused across calls so routing allocates nothing.
    this._dist = new Float32Array(this.nodeCount);
    this._prevEdge = new Int32Array(this.nodeCount);
    this._done = new Uint8Array(this.nodeCount);
    this._heap = new Heap();
  }

  _build(world) {
    // ── pass 1: which coordinates are junctions? ─────────────────────────────
    // A point is a node if two or more ways touch it, or if it is a way's end.
    const touch = new Map();
    // ⚠️ Keep the ORIGINAL index into world.roads. `drivable` is a filtered
    // list, so an index into it is not an index into the world — and the player
    // edits WHOLE STREETS, which are addressed by their world index.
    const drivable = [];
    const drivableIdx = [];
    world.roads.forEach((r, i) => { if (r.k !== 'foot') { drivable.push(r); drivableIdx.push(i); } });
    for (const r of drivable) {
      for (let i = 0; i < r.pts.length; i += 2) {
        const k = key(r.pts[i], r.pts[i + 1]);
        touch.set(k, (touch.get(k) || 0) + 1);
      }
    }

    const nodeId = new Map();
    const nx = [], nz = [];
    const nodeFor = (x, z) => {
      const k = key(x, z);
      let id = nodeId.get(k);
      if (id === undefined) { id = nx.length; nodeId.set(k, id); nx.push(x); nz.push(z); }
      return id;
    };

    // ── pass 2: split each way at its junctions into edges ───────────────────
    const ea = [], eb = [], elen = [], espeed = [], ecap = [], eroad = [], ekind = [];
    for (let ri = 0; ri < drivable.length; ri++) {
      const r = drivable[ri];
      const n = r.pts.length / 2;
      if (n < 2) continue;

      const speed = ROAD_SPEED[r.c] ?? 30;
      const lanes = Math.max(1, Math.round((r.w || 6) / ROAD_LANES.metresPerLane));
      const cap = lanes * LANE_CAPACITY * (r.o ? 1 : 0.5); // two-way splits its lanes

      let segStart = 0, runLen = 0;
      for (let i = 1; i < n; i++) {
        const px = r.pts[(i - 1) * 2], pz = r.pts[(i - 1) * 2 + 1];
        const qx = r.pts[i * 2], qz = r.pts[i * 2 + 1];
        runLen += Math.hypot(qx - px, qz - pz);

        const isEnd = i === n - 1;
        const isJunction = (touch.get(key(qx, qz)) || 0) > 1;
        if (!isEnd && !isJunction) continue;

        const a = nodeFor(r.pts[segStart * 2], r.pts[segStart * 2 + 1]);
        const b = nodeFor(qx, qz);
        if (a !== b && runLen > 0.5) {
          ea.push(a); eb.push(b); elen.push(runLen);
          espeed.push(speed); ecap.push(Math.max(200, cap)); eroad.push(drivableIdx[ri]);
          ekind.push(r.k);
        }
        segStart = i; runLen = 0;
      }
    }

    this.nodeCount = nx.length;
    this.edgeCount = ea.length;
    this.nx = Float32Array.from(nx);
    this.nz = Float32Array.from(nz);
    this.ea = Int32Array.from(ea);
    this.eb = Int32Array.from(eb);
    this.elen = Float32Array.from(elen);
    this.espeed = Float32Array.from(espeed);
    this.ecap = Float32Array.from(ecap);
    this.eroad = Int32Array.from(eroad);      // -> index into world.roads
    this.drivable = drivable;
    this.drivableIdx = Int32Array.from(drivableIdx);
    this.ekind = ekind;

    this._buildAdjacency();

    // Free-flow traversal time = driving + the junctions at each end.
    // ⚠️ Adjacency must exist first: junction cost depends on node DEGREE, and
    // half of each endpoint's delay is charged to the edge so a through trip
    // pays each intersection exactly once however it is split into edges.
    const degree = n => this.adjStart[n + 1] - this.adjStart[n];
    this.freeTime = new Float32Array(this.edgeCount);
    for (let e = 0; e < this.edgeCount; e++) {
      const drive = this.elen[e] / (this.espeed[e] * 1000 / 60);
      const per = JUNCTION_DELAY[this.ekind[e]] ?? JUNCTION_DELAY.street;
      let junction = 0;
      if (degree(this.ea[e]) >= JUNCTION_MIN_DEGREE) junction += per / 2;
      if (degree(this.eb[e]) >= JUNCTION_MIN_DEGREE) junction += per / 2;
      this.freeTime[e] = drive + junction;
    }
    this._buildNodeIndex();
  }


  /**
   * Install a set of transit lines on top of the road network.
   *
   * Each stop becomes its own NODE, joined to the nearest street node by a short
   * "access" edge whose cost is the wait — which is what naturally limits
   * transit to people who can actually reach a stop. Consecutive stops are
   * joined by a fast transit edge.
   *
   * ⚠️ Transit edges are APPENDED, never interleaved, so road edge indices are
   * stable and every per-edge array (load, blocks, capacity) extends in place.
   * The sim re-applies its own road and flood state afterwards.
   *
   * lines: [{ id, kind, stops: [[x,z], ...] }]
   */
  setTransit(lines) {
    const b = this._base;
    this.lines = lines || [];

    const nx = Array.from(b.nx), nz = Array.from(b.nz);
    const ea = Array.from(b.ea), eb = Array.from(b.eb);
    const elen = Array.from(b.elen), espeed = Array.from(b.espeed);
    const ecap = Array.from(b.ecap), eroad = Array.from(b.eroad);
    const freeTime = Array.from(b.freeTime);
    const isTransit = new Array(this.baseEdgeCount).fill(0);

    // nearestNode must search only REAL street nodes, so do the lookups before
    // any transit node exists.
    const anchors = [];
    for (const line of this.lines) {
      anchors.push(line.stops.map(([x, z]) => this.nearestNode(x, z, TRANSIT.maxWalkM)));
    }

    this.stopNodes = [];
    for (let li = 0; li < this.lines.length; li++) {
      const line = this.lines[li];
      const spec = TRANSIT.kinds[line.kind] || TRANSIT.kinds.tram;
      const nodes = [];

      for (let s = 0; s < line.stops.length; s++) {
        const [x, z] = line.stops[s];
        const id = nx.length;
        nx.push(x); nz.push(z);
        nodes.push(id);

        // access edge: street <-> platform, costed as the wait
        const anchor = anchors[li][s];
        if (anchor >= 0) {
          ea.push(anchor); eb.push(id);
          elen.push(Math.hypot(this.nx[anchor] - x, this.nz[anchor] - z));
          espeed.push(spec.speed); ecap.push(1e9); eroad.push(-1);
          freeTime.push(spec.accessMin);
          isTransit.push(1);
        }
      }

      // running edges between consecutive stops
      for (let s = 0; s + 1 < nodes.length; s++) {
        const [x0, z0] = line.stops[s], [x1, z1] = line.stops[s + 1];
        const len = Math.hypot(x1 - x0, z1 - z0);
        ea.push(nodes[s]); eb.push(nodes[s + 1]);
        elen.push(len); espeed.push(spec.speed); ecap.push(1e9); eroad.push(-1);
        freeTime.push(len / (spec.speed * 1000 / 60) + spec.dwellMin);
        isTransit.push(1);
      }
      this.stopNodes.push(nodes);
    }

    this.nodeCount = nx.length;
    this.edgeCount = ea.length;
    this.nx = Float32Array.from(nx); this.nz = Float32Array.from(nz);
    this.ea = Int32Array.from(ea); this.eb = Int32Array.from(eb);
    this.elen = Float32Array.from(elen); this.espeed = Float32Array.from(espeed);
    this.ecap = Float32Array.from(ecap); this.eroad = Int32Array.from(eroad);
    this.freeTime = Float32Array.from(freeTime);
    this.isTransit = Uint8Array.from(isTransit);

    // extend the per-edge arrays, preserving road entries
    const grow = (old, fill = 0) => {
      const next = new Float32Array(this.edgeCount).fill(fill);
      if (old) next.set(old.subarray(0, Math.min(old.length, this.baseEdgeCount)));
      return next;
    };
    const growU8 = old => {
      const next = new Uint8Array(this.edgeCount);
      if (old) next.set(old.subarray(0, Math.min(old.length, this.baseEdgeCount)));
      return next;
    };
    this.load = grow(this.load);
    this.capMul = grow(this.capMul, 1);
    for (let e = this.baseEdgeCount; e < this.edgeCount; e++) this.capMul[e] = 1;
    this.blockedFlood = growU8(this.blockedFlood);
    this.blockedPlayer = growU8(this.blockedPlayer);
    this._shut = new Uint8Array(this.edgeCount);
    this._refreshShut();

    this._dist = new Float32Array(this.nodeCount);
    this._prevEdge = new Int32Array(this.nodeCount);
    this._done = new Uint8Array(this.nodeCount);

    this._buildAdjacency();
    // ⚠️ The node index is REBUILT FROM BASE NODES ONLY. If platforms entered it,
    // a later line would snap its access edge to another line's platform instead
    // of to the street, and transit would quietly detach from the city.
    this._buildNodeIndex(this.baseNodeCount);
    return this;
  }

  /** Total route length per line, metres — for the UI and for upkeep. */
  transitLengthOf(line) {
    let m = 0;
    for (let s = 0; s + 1 < line.stops.length; s++) {
      m += Math.hypot(line.stops[s + 1][0] - line.stops[s][0],
                      line.stops[s + 1][1] - line.stops[s][1]);
    }
    return m;
  }

  /** CSR adjacency. Streets are two-way for routing; oneway is a v2 refinement. */
  _buildAdjacency() {
    const deg = new Int32Array(this.nodeCount + 1);
    for (let e = 0; e < this.edgeCount; e++) { deg[this.ea[e]]++; deg[this.eb[e]]++; }
    const start = new Int32Array(this.nodeCount + 1);
    for (let i = 0; i < this.nodeCount; i++) start[i + 1] = start[i] + deg[i];
    const fill = start.slice();
    const adjNode = new Int32Array(start[this.nodeCount]);
    const adjEdge = new Int32Array(start[this.nodeCount]);
    for (let e = 0; e < this.edgeCount; e++) {
      const a = this.ea[e], b = this.eb[e];
      adjNode[fill[a]] = b; adjEdge[fill[a]++] = e;
      adjNode[fill[b]] = a; adjEdge[fill[b]++] = e;
    }
    this.adjStart = start; this.adjNode = adjNode; this.adjEdge = adjEdge;
  }

  /** Uniform bucket grid so nearestNode() is not a linear scan. */
  _buildNodeIndex(limit = this.nodeCount) {
    const w = this.world;
    this._bucket = 60;
    this._gc = Math.ceil(w.width / this._bucket) + 1;
    this._gr = Math.ceil(w.depth / this._bucket) + 1;
    const idx = new Map();
    for (let i = 0; i < limit; i++) {
      const gi = Math.floor((this.nx[i] - w.x0) / this._bucket);
      const gj = Math.floor((this.nz[i] - w.z0) / this._bucket);
      const k = gj * this._gc + gi;
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push(i);
    }
    this._nIndex = idx;
  }

  /** Nearest graph node to a world point, or -1 if nothing is within `maxR`. */
  nearestNode(x, z, maxR = 220) {
    const w = this.world;
    const gi = Math.floor((x - w.x0) / this._bucket);
    const gj = Math.floor((z - w.z0) / this._bucket);
    let best = -1, bestD = maxR * maxR;
    const rings = Math.ceil(maxR / this._bucket);
    for (let r = 0; r <= rings; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (r > 0 && Math.max(Math.abs(di), Math.abs(dj)) !== r) continue; // ring only
          const list = this._nIndex.get((gj + dj) * this._gc + (gi + di));
          if (!list) continue;
          for (const n of list) {
            const dx = this.nx[n] - x, dz = this.nz[n] - z;
            const d = dx * dx + dz * dz;
            if (d < bestD) { bestD = d; best = n; }
          }
        }
      }
      if (best >= 0 && r >= 1) break;   // one extra ring guards the corner case
    }
    return best;
  }

  /**
   * Mark edges as impassable (flooded, demolished, closed to cars).
   * Routing skips them entirely, so the network reroutes around the gap rather
   * than driving through it — that is what makes drowning a street a MECHANIC
   * and not a paint job.
   */
  setFlooded(flags) { this.blockedFlood.set(flags); this._refreshShut(); }

  /** Player-closed streets (torn out, pedestrianised, or simply shut). */
  setPlayerBlocked(flags) { this.blockedPlayer.set(flags); this._refreshShut(); }

  _refreshShut() {
    for (let e = 0; e < this.edgeCount; e++) {
      this._shut[e] = (this.blockedFlood[e] || this.blockedPlayer[e]) ? 1 : 0;
    }
  }

  /** Effective capacity after the player has widened or narrowed a street. */
  capacityOf(e) { return Math.max(120, this.ecap[e] * this.capMul[e]); }

  /** Is this edge carried by rail rather than road? Cars never load these. */
  isTransitEdge(e) { return this.isTransit[e] === 1; }

  /** Congested traversal time (minutes) for an edge, BPR volume-delay. */
  edgeTime(e) {
    const ratio = this.load[e] / this.capacityOf(e);
    return this.freeTime[e] * (1 + BPR.alpha * Math.pow(ratio, BPR.beta));
  }

  /**
   * Dijkstra from one node over congested travel time.
   * Returns the internal distance array (minutes) — DO NOT retain it, it is
   * reused on the next call. `_prevEdge` holds the shortest-path tree.
   */
  dijkstra(from, maxTime = Infinity) {
    const dist = this._dist, done = this._done, prev = this._prevEdge;
    dist.fill(Infinity); done.fill(0); prev.fill(-1);
    const heap = this._heap;
    heap.clear();
    dist[from] = 0;
    heap.push(0, from);

    while (heap.size) {
      const u = heap.pop();
      if (done[u]) continue;
      done[u] = 1;
      const du = dist[u];
      if (du > maxTime) break;
      for (let k = this.adjStart[u]; k < this.adjStart[u + 1]; k++) {
        const v = this.adjNode[k], e = this.adjEdge[k];
        if (done[v]) continue;
        if (this._shut[e]) continue;                     // under water / torn out
        const nd = du + this.edgeTime(e);
        if (nd < dist[v]) { dist[v] = nd; prev[v] = e; heap.push(nd, v); }
      }
    }
    return dist;
  }

  /** Edge indices along the shortest path found by the last dijkstra() call. */
  pathEdges(from, to, out = []) {
    out.length = 0;
    let cur = to, guard = this.nodeCount + 4;
    while (cur !== from && guard-- > 0) {
      const e = this._prevEdge[cur];
      if (e < 0) { out.length = 0; return out; }   // unreachable
      out.push(e);
      cur = this.ea[e] === cur ? this.eb[e] : this.ea[e];
    }
    return out;
  }

  /**
   * Connected components by node, plus the size of the largest.
   * A street network should be almost entirely ONE component; a low share is
   * the signal that the coordinate-identity assumption above has broken.
   */
  components() {
    const comp = new Int32Array(this.nodeCount).fill(-1);
    const stack = [];
    let n = 0, largest = 0;
    const sizes = [];
    for (let s = 0; s < this.nodeCount; s++) {
      if (comp[s] >= 0) continue;
      let size = 0;
      comp[s] = n; stack.push(s);
      while (stack.length) {
        const u = stack.pop(); size++;
        for (let k = this.adjStart[u]; k < this.adjStart[u + 1]; k++) {
          const v = this.adjNode[k];
          if (comp[v] < 0) { comp[v] = n; stack.push(v); }
        }
      }
      sizes.push(size);
      if (size > largest) largest = size;
      n++;
    }
    return { comp, count: n, largest, sizes, largestShare: largest / Math.max(1, this.nodeCount) };
  }

  stats() {
    let km = 0;
    for (let e = 0; e < this.edgeCount; e++) km += this.elen[e];
    const c = this.components();
    let transitKm = 0, transitEdges = 0;
    for (let e = this.baseEdgeCount; e < this.edgeCount; e++) {
      if (this.isTransit[e]) { transitKm += this.elen[e]; transitEdges++; }
    }
    return {
      nodes: this.nodeCount, edges: this.edgeCount,
      km: km / 1000,
      components: c.count, largestShare: c.largestShare,
      lines: this.lines.length, transitEdges, transitKm: transitKm / 1000,
    };
  }
}
