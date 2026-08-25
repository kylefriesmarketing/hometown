// sim.js — the deterministic city simulation.
//
// ⚠️⚠️ THE IRON RULES, same shape as every other sim in this workspace:
//  1. NO `Math.random` in this file, ever. All randomness comes from `this.rng`
//     (seeded LCG) or from stable per-building hashes. The view may use
//     Math.random; the sim may not.
//  2. NO three.js, NO DOM, NO Date, NO fetch. This file runs headless in node
//     and that is how it is tested.
//  3. `execCommand` is the ONLY way player intent mutates state. Everything
//     else is derived. That keeps replays and any future multiplayer honest.
//  4. Any new state MUST be added to snapshot(), restore() AND stateHash(),
//     or saves silently diverge and the harness will happily tell you they did
//     not. This is written in blood elsewhere in this workspace.

import {
  TICK, ZONES, ZONE_KINDS, ZONE_INDEX, SIM, DESIRE, FALLOFF, SLOPE_HALF,
  SERVICES, REZONE_COST_PER_M2, DEMOLISH_COST_PER_M2,
} from './data.js';
import { chamferFrom, sampleField, stampPoint } from './field.js';

const Z_NONE = ZONE_INDEX.none;
const Z_RES = ZONE_INDEX.residential;
const Z_COM = ZONE_INDEX.commercial;
const Z_IND = ZONE_INDEX.industrial;
const Z_CIV = ZONE_INDEX.civic;

/** Half-life decay: 1 at d=0, 0.5 at d=half, asymptotically 0. */
const decay = (d, half) => 1 / (1 + (d / half) * (d / half));

/** Stable per-building "character" in [0,1). Not from the rng stream, so it
 *  never depends on iteration order or on how many ticks have run. */
function charOf(i) {
  let h = (i + 0x9e3779b9) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class Sim {
  constructor(world, graph, opts = {}) {
    this.world = world;
    this.graph = graph;
    this.seed = (opts.seed ?? 12345) >>> 0;
    this.rng = this.seed;

    this.day = 0;
    this.money = opts.startMoney ?? SIM.startMoney;
    this.bankrupt = false;

    const n = world.buildings.length;
    this.n = n;
    this.zone = new Uint8Array(n);
    this.cap = new Float32Array(n);
    this.occ = new Float32Array(n);
    this.desire = new Float32Array(n);
    this.accessOf = new Float32Array(n);   // job access at this building, 0..1

    this._initZoning();
    this._buildFields();
    this._buildZoneGrid();

    // Round-robin cursors — work is spread over many ticks so no single tick
    // is expensive and the cost does not scale with city size per frame.
    this._bCursor = 0;
    this._zCursor = 0;
    this._nextLoad = new Float32Array(graph.edgeCount);

    this.stats = this._blankStats();
    this.history = [];
    this._recomputeTotals();

    // Prime the picture so tick 0 is not a blank city.
    this._fullTrafficPass();
    for (let i = 0; i < n; i++) this._updateDesire(i);
  }

  // ── setup ────────────────────────────────────────────────────────────────

  /**
   * Seed zoning from what OSM said the buildings are.
   *
   * ⚠️ `other` (a bare `building=yes`) becomes HOUSING. In a dense city that is
   * overwhelmingly what those buildings are, and the alternative — starting 79%
   * of San Francisco vacant — is a dead town, not a game. It is an inference,
   * not data: `world.buildings[i].ks === 'none'` still marks it as such and the
   * UI says so. `minor` (sheds, garages, carports) stays unzoned.
   */
  _initZoning() {
    const b = this.world.buildings;
    for (let i = 0; i < this.n; i++) {
      const k = b[i].kind;
      const z = k === 'other' ? Z_RES : (k === 'minor' ? Z_NONE : (ZONE_INDEX[k] ?? Z_NONE));
      this.zone[i] = z;
      this.cap[i] = this._capacityOf(i, z);
      // Start the town alive but with room to grow, varied per building.
      this.occ[i] = z === Z_NONE ? 0 : this.cap[i] * (0.55 + 0.30 * charOf(i));
    }
  }

  _capacityOf(i, z) {
    const def = ZONES[ZONE_KINDS[z]];
    if (!def || !def.areaPer) return 0;
    const b = this.world.buildings[i];
    const floorArea = b.a * Math.max(1, b.lv);
    return floorArea / def.areaPer;
  }

  /** Distance fields the desirability model reads. */
  _buildFields() {
    const w = this.world;
    const { cols, rows, cell, x0, z0 } = { cols: w.cols, rows: w.rows, cell: w.cell, x0: w.x0, z0: w.z0 };
    this._fieldDims = { cols, rows, cell, x0, z0 };
    const BIG = 1e6;

    // parks & open green
    const park = new Float32Array(cols * rows).fill(BIG);
    for (const a of w.areas) {
      if (a.k !== 'park' && a.k !== 'wood' && a.k !== 'sport' && a.k !== 'cemetery') continue;
      for (let i = 0; i < a.ring.length; i += 2) {
        stampPoint(park, cols, rows, cell, x0, z0, a.ring[i], a.ring[i + 1]);
      }
    }
    this.parkDist = chamferFrom(park, cols, rows, cell);

    // one coverage field per service, seeded from OSM POIs
    this.serviceDist = {};
    for (const [key, def] of Object.entries(SERVICES)) {
      const f = new Float32Array(cols * rows).fill(BIG);
      const want = new Set(def.poi);
      for (const p of w.pois) {
        if (want.has(p.k)) stampPoint(f, cols, rows, cell, x0, z0, p.x, p.z);
      }
      this.serviceDist[key] = chamferFrom(f, cols, rows, cell);
    }

    this._rebuildNuisance();
  }

  /** Industry depresses nearby housing. Rebuilt when industrial zoning changes. */
  _rebuildNuisance() {
    const { cols, rows, cell, x0, z0 } = this._fieldDims;
    const f = new Float32Array(cols * rows).fill(1e6);
    let any = false;
    for (let i = 0; i < this.n; i++) {
      if (this.zone[i] !== Z_IND) continue;
      const c = this.world.buildings[i].c;
      stampPoint(f, cols, rows, cell, x0, z0, c[0], c[1]);
      any = true;
    }
    this.nuisanceDist = any ? chamferFrom(f, cols, rows, cell) : null;
    this._nuisanceDirty = false;
  }

  _sample(field, x, z) {
    const d = this._fieldDims;
    return sampleField(field, d.cols, d.rows, d.cell, d.x0, d.z0, x, z);
  }

  /**
   * Coarse zones for traffic. Buildings aggregate into ~200 m cells and each
   * cell routes from its nearest street node — routing 6,000 buildings
   * individually would be pointless precision at enormous cost.
   */
  _buildZoneGrid() {
    const w = this.world;
    const CELL = 200;
    this.zCell = CELL;
    this.zCols = Math.max(1, Math.ceil(w.width / CELL));
    this.zRows = Math.max(1, Math.ceil(w.depth / CELL));
    const nz = this.zCols * this.zRows;

    this.bZone = new Int32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const c = w.buildings[i].c;
      const gi = Math.max(0, Math.min(this.zCols - 1, Math.floor((c[0] - w.x0) / CELL)));
      const gj = Math.max(0, Math.min(this.zRows - 1, Math.floor((c[1] - w.z0) / CELL)));
      this.bZone[i] = gj * this.zCols + gi;
    }

    this.zonePop = new Float32Array(nz);
    this.zoneJobs = new Float32Array(nz);
    this.zoneAccess = new Float32Array(nz);
    this.zoneNode = new Int32Array(nz).fill(-1);
    for (let j = 0; j < this.zRows; j++) {
      for (let i = 0; i < this.zCols; i++) {
        const x = w.x0 + (i + 0.5) * CELL, z = w.z0 + (j + 0.5) * CELL;
        this.zoneNode[j * this.zCols + i] = this.graph.nearestNode(x, z);
      }
    }
    this.nZones = nz;
  }

  // ── the tick ─────────────────────────────────────────────────────────────

  tick() {
    this.day += TICK.daysPerTick;

    this._aggregateZones();
    this._trafficSlice();
    this._buildingSlice();

    if (this.day % TICK.daysPerMonth === 0) this._settleFinances();

    this._recomputeTotals();
    return this.stats;
  }

  _aggregateZones() {
    this.zonePop.fill(0);
    this.zoneJobs.fill(0);
    for (let i = 0; i < this.n; i++) {
      const z = this.zone[i];
      if (z === Z_NONE) continue;
      const cell = this.bZone[i];
      if (z === Z_RES) this.zonePop[cell] += this.occ[i];
      else this.zoneJobs[cell] += this.occ[i];
    }
  }

  /**
   * Assign commuter traffic for a slice of origin zones.
   *
   * One Dijkstra per origin gives BOTH the accessibility score and the traffic
   * loading, which is why they live in the same pass. Loads accumulate into a
   * back buffer and are swapped in only when a full sweep completes, so the
   * network never shows a half-updated picture.
   */
  _trafficSlice() {
    const per = Math.max(1, Math.ceil(this.nZones / SIM.zoneSliceTicks));
    const path = [];
    for (let s = 0; s < per; s++) {
      const z = this._zCursor;
      this._assignFrom(z, path);
      this._zCursor++;
      if (this._zCursor >= this.nZones) {
        this._zCursor = 0;
        // sweep complete — publish it
        this.graph.load.set(this._nextLoad);
        this._nextLoad.fill(0);
      }
    }
  }

  _assignFrom(z, path) {
    const g = this.graph;
    const from = this.zoneNode[z];
    const workers = this.zonePop[z] * SIM.workforceShare;
    if (from < 0) { this.zoneAccess[z] = 0; return; }

    const dist = g.dijkstra(from, SIM.commuteHorizon);

    // gravity weights to every job-holding zone
    let reach = 0;
    const weights = [];
    for (let w = 0; w < this.nZones; w++) {
      const jobs = this.zoneJobs[w];
      if (jobs <= 0) continue;
      const node = this.zoneNode[w];
      if (node < 0) continue;
      const t = dist[node];
      if (!Number.isFinite(t) || t > SIM.commuteHorizon) continue;
      const wgt = jobs * decay(t, SIM.commuteHalfLife);
      if (wgt <= 0) continue;
      weights.push(w, wgt, node);
      reach += wgt;
    }

    this.zoneAccess[z] = reach;
    if (workers <= 0 || reach <= 0) return;

    // vehicles/hour at peak, distributed along each shortest path
    const vehicles = workers * SIM.carShare / SIM.occupantsPerCar * SIM.peakShare;
    for (let k = 0; k < weights.length; k += 3) {
      const share = weights[k + 1] / reach;
      const flow = vehicles * share;
      if (flow < 0.01) continue;
      g.pathEdges(from, weights[k + 2], path);
      for (const e of path) this._nextLoad[e] += flow;
    }
  }

  /** Refresh desirability and occupancy for a slice of buildings. */
  _buildingSlice() {
    if (this._nuisanceDirty) this._rebuildNuisance();

    const per = Math.max(1, Math.ceil(this.n / SIM.buildingSliceTicks));
    const housingMul = this._housingDemand();
    const businessMul = this._businessDemand();

    for (let s = 0; s < per; s++) {
      const i = this._bCursor;
      this._bCursor = (this._bCursor + 1) % this.n;
      const z = this.zone[i];
      if (z === Z_NONE) { this.occ[i] = 0; continue; }

      this._updateDesire(i);
      const d = this.desire[i];
      const mul = z === Z_RES ? housingMul : businessMul;
      const target = this.cap[i] * Math.max(0, Math.min(1, d * mul));

      const rate = target > this.occ[i] ? SIM.growthRate : SIM.declineRate;
      // A slice runs once every buildingSliceTicks, so scale up to stay
      // frame-rate independent of how the slice is divided.
      const step = rate * SIM.buildingSliceTicks;
      this.occ[i] += (target - this.occ[i]) * Math.min(1, step);
      if (this.occ[i] < 0.01) this.occ[i] = 0;
    }
  }

  /** More jobs than workers pulls people in; the reverse pushes them out. */
  _housingDemand() {
    const workers = Math.max(1, this.stats.population * SIM.workforceShare);
    return Math.max(0.5, Math.min(1.35, 0.75 + 0.55 * (this.stats.jobs / workers)));
  }

  _businessDemand() {
    const jobs = Math.max(1, this.stats.jobs);
    const workers = this.stats.population * SIM.workforceShare;
    return Math.max(0.5, Math.min(1.35, 0.75 + 0.55 * (workers / jobs)));
  }

  /**
   * How good is this plot, 0..1. Reads only real map facts: the grade it sits
   * on, how far the nearest drivable road is, how many jobs it can reach, what
   * is nearby. This is where the OSM data earns its keep.
   */
  _updateDesire(i) {
    const b = this.world.buildings[i];
    const z = this.zone[i];
    if (z === Z_NONE) { this.desire[i] = 0; return; }
    const wts = DESIRE[ZONE_KINDS[z]];
    if (!wts) { this.desire[i] = 0; return; }

    const x = b.c[0], zc = b.c[1];
    const w = this.world;

    const road = decay(w.roadDistAt(x, zc), FALLOFF.road);
    const slope = decay(w.slopeAt(x, zc), SLOPE_HALF);
    const park = decay(this._sample(this.parkDist, x, zc), FALLOFF.park);

    let services = 0, sw = 0;
    for (const [key, def] of Object.entries(SERVICES)) {
      services += def.weight * decay(this._sample(this.serviceDist[key], x, zc), FALLOFF.service);
      sw += def.weight;
    }
    services = sw > 0 ? services / sw : 0;

    // nuisance is a PENALTY: 1 when far from industry, 0 right next to it
    const nuisance = this.nuisanceDist
      ? 1 - decay(this._sample(this.nuisanceDist, x, zc), FALLOFF.nuisance)
      : 1;

    const totalJobs = Math.max(1, this.stats.jobs);
    const access = Math.max(0, Math.min(1, this.zoneAccess[this.bZone[i]] / totalJobs));
    this.accessOf[i] = access;

    const congestion = 1 - Math.max(0, Math.min(1, this._localCongestion(i)));

    const parts = wts.roadAccess * road + wts.slope * slope + wts.access * access
      + wts.park * park + wts.services * services + wts.nuisance * nuisance
      + wts.congestion * congestion;
    const tot = wts.roadAccess + wts.slope + wts.access + wts.park
      + wts.services + wts.nuisance + wts.congestion;

    // a little stable per-building character so a street is not uniform
    const jitter = 0.92 + 0.16 * charOf(i);
    this.desire[i] = Math.max(0, Math.min(1, (parts / tot) * jitter));
  }

  /** Worst volume/capacity ratio on roads serving this building's zone cell. */
  _localCongestion(i) {
    const node = this.zoneNode[this.bZone[i]];
    if (node < 0) return 0;
    const g = this.graph;
    let worst = 0;
    for (let k = g.adjStart[node]; k < g.adjStart[node + 1]; k++) {
      const e = g.adjEdge[k];
      const r = g.load[e] / g.ecap[e];
      if (r > worst) worst = r;
    }
    return worst;
  }

  _settleFinances() {
    let income = 0, upkeep = 0;
    for (let i = 0; i < this.n; i++) {
      const z = this.zone[i];
      if (z === Z_NONE || this.occ[i] <= 0) continue;
      const def = ZONES[ZONE_KINDS[z]];
      income += this.occ[i] * (def.taxPerOccupant || 0);
      upkeep += this.occ[i] * (def.upkeepPerOccupant || 0);
    }
    // roads cost money to keep
    let km = 0;
    for (let e = 0; e < this.graph.edgeCount; e++) km += this.graph.elen[e];
    upkeep += (km / 1000) * 12;

    this.lastIncome = income;
    this.lastUpkeep = upkeep;
    this.money += income - upkeep;
    if (this.money < 0) this.bankrupt = true;

    this.history.push({
      day: this.day, population: this.stats.population, jobs: this.stats.jobs,
      money: this.money, income, upkeep,
    });
    if (this.history.length > 600) this.history.shift();
  }

  _blankStats() {
    return {
      population: 0, jobs: 0, housingCap: 0, jobCap: 0,
      unemployment: 0, vacancy: 0, avgDesire: 0, congested: 0,
      byZone: {},
    };
  }

  _recomputeTotals() {
    const s = this._blankStats();
    let desireSum = 0, desireN = 0;
    for (const k of ZONE_KINDS) s.byZone[k] = { count: 0, occ: 0, cap: 0 };

    for (let i = 0; i < this.n; i++) {
      const z = this.zone[i];
      const kind = ZONE_KINDS[z];
      const bz = s.byZone[kind];
      bz.count++; bz.occ += this.occ[i]; bz.cap += this.cap[i];
      if (z === Z_NONE) continue;
      if (z === Z_RES) { s.population += this.occ[i]; s.housingCap += this.cap[i]; }
      else { s.jobs += this.occ[i]; s.jobCap += this.cap[i]; }
      desireSum += this.desire[i]; desireN++;
    }

    const workers = s.population * SIM.workforceShare;
    s.unemployment = workers > 0 ? Math.max(0, (workers - s.jobs) / workers) : 0;
    s.vacancy = s.housingCap > 0 ? Math.max(0, 1 - s.population / s.housingCap) : 0;
    s.avgDesire = desireN > 0 ? desireSum / desireN : 0;

    let congested = 0;
    for (let e = 0; e < this.graph.edgeCount; e++) {
      if (this.graph.load[e] / this.graph.ecap[e] > 0.85) congested++;
    }
    s.congested = this.graph.edgeCount > 0 ? congested / this.graph.edgeCount : 0;

    this.stats = s;
    return s;
  }

  /** Full traffic sweep in one go — used at construction and by tests. */
  _fullTrafficPass() {
    this._aggregateZones();
    this._nextLoad.fill(0);
    const path = [];
    for (let z = 0; z < this.nZones; z++) this._assignFrom(z, path);
    this.graph.load.set(this._nextLoad);
    this._nextLoad.fill(0);
    this._zCursor = 0;
  }

  // ── commands: the only way player intent enters ──────────────────────────

  /**
   * Apply one player command. Returns {ok, reason?, cost?}.
   * ⚠️ Every mutation a player can cause MUST arrive through here — that is what
   * makes a replay or a networked session reproduce the same city.
   */
  execCommand(cmd) {
    switch (cmd.t) {
      case 'rezone': return this._cmdRezone(cmd);
      case 'demolish': return this._cmdDemolish(cmd);
      default: return { ok: false, reason: `unknown command "${cmd.t}"` };
    }
  }

  _cmdRezone(cmd) {
    const z = ZONE_INDEX[cmd.zone];
    if (z === undefined) return { ok: false, reason: `no such zone "${cmd.zone}"` };
    const ids = (cmd.ids || []).filter(i => i >= 0 && i < this.n);
    if (!ids.length) return { ok: false, reason: 'nothing selected' };

    let cost = 0;
    for (const i of ids) {
      if (this.zone[i] === z) continue;
      cost += this.world.buildings[i].a * REZONE_COST_PER_M2;
    }
    if (cost > this.money) return { ok: false, reason: 'not enough money', cost };

    for (const i of ids) {
      if (this.zone[i] === z) continue;
      if (this.zone[i] === Z_IND || z === Z_IND) this._nuisanceDirty = true;
      this.zone[i] = z;
      this.cap[i] = this._capacityOf(i, z);
      // Occupants do not survive a change of use.
      this.occ[i] = 0;
      this.desire[i] = 0;
    }
    this.money -= cost;
    this._recomputeTotals();
    return { ok: true, cost, count: ids.length };
  }

  _cmdDemolish(cmd) {
    const ids = (cmd.ids || []).filter(i => i >= 0 && i < this.n);
    if (!ids.length) return { ok: false, reason: 'nothing selected' };
    let cost = 0;
    for (const i of ids) if (this.zone[i] !== Z_NONE) cost += this.world.buildings[i].a * DEMOLISH_COST_PER_M2;
    if (cost > this.money) return { ok: false, reason: 'not enough money', cost };

    for (const i of ids) {
      if (this.zone[i] === Z_IND) this._nuisanceDirty = true;
      this.zone[i] = Z_NONE;
      this.cap[i] = 0; this.occ[i] = 0; this.desire[i] = 0;
    }
    this.money -= cost;
    this._recomputeTotals();
    return { ok: true, cost, count: ids.length };
  }

  // ── save / load / hash ───────────────────────────────────────────────────

  snapshot() {
    return {
      v: 1,
      seed: this.seed, rng: this.rng,
      day: this.day, money: this.money, bankrupt: this.bankrupt,
      zone: Array.from(this.zone),
      occ: Array.from(this.occ, v => Math.round(v * 1000) / 1000),
      bCursor: this._bCursor, zCursor: this._zCursor,
      history: this.history.slice(),
    };
  }

  restore(s) {
    if (!s || s.v !== 1) throw new Error('unsupported save version');
    this.seed = s.seed >>> 0;
    this.rng = s.rng >>> 0;
    this.day = s.day;
    this.money = s.money;
    this.bankrupt = !!s.bankrupt;
    this.zone.set(s.zone);
    this.occ.set(s.occ);
    this._bCursor = s.bCursor | 0;
    this._zCursor = s.zCursor | 0;
    this.history = (s.history || []).slice();

    // Everything else is DERIVED and must be rebuilt, never trusted from a save.
    for (let i = 0; i < this.n; i++) this.cap[i] = this._capacityOf(i, this.zone[i]);
    this._rebuildNuisance();
    this._recomputeTotals();
    this._fullTrafficPass();
    for (let i = 0; i < this.n; i++) this._updateDesire(i);
    this._recomputeTotals();
    return this;
  }

  /**
   * Fold every piece of AUTHORITATIVE state into one number.
   * ⚠️ Derived values (desire, access, traffic) are deliberately NOT folded —
   * they are rebuilt identically from the state that IS folded. Anything that
   * a player action can change and that is not recomputable belongs here.
   */
  stateHash() {
    let h = 2166136261 >>> 0;
    const mix = v => { h ^= v >>> 0; h = Math.imul(h, 16777619) >>> 0; };
    mix(this.day); mix(this.rng); mix(this.seed);
    mix(Math.round(this.money * 100));
    mix(this.bankrupt ? 1 : 0);
    mix(this._bCursor); mix(this._zCursor);
    for (let i = 0; i < this.n; i++) {
      mix(this.zone[i] * 31 + 7);
      mix(Math.round(this.occ[i] * 1000));
    }
    return h | 0;
  }
}
