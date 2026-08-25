// game.js — the play layer: HUD, overlays, selection, and the tick clock.
//
// Reads the Sim, issues COMMANDS to it, and tells the View how to paint.
// It never writes sim state directly — every mutation goes through
// `sim.execCommand`, which is what keeps a city reproducible.

import { TICK, ZONES, ZONE_KINDS, ZONE_INDEX, OVERLAYS, REZONE_COST_PER_M2 } from './data.js';

const $ = id => document.getElementById(id);
const fmt = n => Math.round(n).toLocaleString();
const money = n => (n < 0 ? '-' : '') + '$' + fmt(Math.abs(n));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Overlays that colour buildings by a sim value. Hue runs red -> green. */
const OVERLAY_DATA = {
  zone: {
    valueAt: (sim, i) => sim.zone[i] === ZONE_INDEX.none ? null : sim.zone[i],
    colourAt: (sim, i) => {
      const z = sim.zone[i];
      return z === ZONE_INDEX.none ? null : ZONES[ZONE_KINDS[z]].colour;
    },
    legend: null,
  },
  occupancy: {
    valueAt: (sim, i) => sim.cap[i] > 0 ? Math.min(1, sim.occ[i] / sim.cap[i]) : null,
    legend: ['empty', 'full'],
  },
  desire: {
    valueAt: (sim, i) => sim.zone[i] === ZONE_INDEX.none ? null : sim.desire[i],
    legend: ['nobody wants this', 'everyone wants this'],
  },
  access: {
    valueAt: (sim, i) => sim.zone[i] === ZONE_INDEX.none ? null : Math.min(1, sim.accessOf[i] * 3),
    legend: ['cut off', 'reaches the jobs'],
  },
  congestion: {
    valueAt: (sim, i) => {
      const g = sim.graph, node = sim.zoneNode[sim.bZone[i]];
      if (node < 0) return null;
      let worst = 0;
      for (let k = g.adjStart[node]; k < g.adjStart[node + 1]; k++) {
        const r = g.load[g.adjEdge[k]] / g.ecap[g.adjEdge[k]];
        if (r > worst) worst = r;
      }
      return Math.min(1, worst);
    },
    invert: true,                       // high congestion is BAD, so flip the hue
    legend: ['clear', 'gridlocked'],
  },
};

export class Game {
  constructor(sim, view, ui) {
    this.sim = sim;
    this.view = view;
    this.ui = ui;
    this.speed = 1;
    this.accum = 0;
    this.selection = new Set();      // building indices
    this.roadSel = new Set();        // world.roads indices
    this.overlay = 'none';
    this._hudT = 0;

    this._buildSpeeds();
    this._buildSeaSlider();
    this._buildOverlays();
    this._buildZoneButtons();
    this._buildRoadButtons();
    this.refreshHud();
    this.refreshRoads();
    this.applyOverlay('none');
  }

  // ── clock ────────────────────────────────────────────────────────────────

  /** Advance sim time. Fixed timestep so the city is frame-rate independent. */
  update(dt) {
    const mult = TICK.speeds[this.speed] || 0;
    if (mult > 0) {
      this.accum += dt * TICK.ticksPerSecond * mult;
      // Cap the catch-up so a stalled tab cannot stampede through a decade.
      let budget = 40;
      while (this.accum >= 1 && budget-- > 0) { this.accum -= 1; this.sim.tick(); }
      if (budget <= 0) this.accum = 0;
    }

    this._hudT += dt;
    if (this._hudT >= 0.25) { this._hudT = 0; this.refreshHud(); this.repaintOverlay(); }
  }

  setSpeed(s) {
    this.speed = s;
    for (const b of $('speeds').children) b.classList.toggle('on', +b.dataset.speed === s);
  }

  _buildSpeeds() {
    const row = $('speeds');
    row.innerHTML = '';
    ['❚❚', '▶', '▶▶', '▶▶▶'].forEach((label, i) => {
      const b = document.createElement('button');
      b.textContent = label; b.dataset.speed = i;
      b.title = i === 0 ? 'Pause' : `${TICK.speeds[i]}x`;
      b.addEventListener('click', () => this.setSpeed(i));
      row.appendChild(b);
    });
    this.setSpeed(1);
  }

  // ── the sea ──────────────────────────────────────────────────────────────

  _buildSeaSlider() {
    const el = $('sea-slider');
    if (!el) return;
    el.addEventListener('input', () => this.setSea(+el.value / 10));
    this.setSea(0);
  }

  setSea(level) {
    const r = this.sim.execCommand({ t: 'sea', level });
    if (!r.ok) return;
    const cells = this.view.buildWater(this.sim.floodMask, level);
    $('sea-value').textContent = (level >= 0 ? '+' : '') + level.toFixed(1) + ' m';
    const f = this.sim.floodStats;
    $('sea-info').innerHTML = level === 0 && !f.buildings
      ? 'drag to raise the sea'
      : `<b>${fmt(f.buildings)}</b> buildings under water · <b>${fmt(f.displaced)}</b> people displaced · <b>${f.roads}</b> streets cut`;
    this.refreshHud();
    this.refreshRoads();
    this.repaintOverlay(true);
    void cells;
  }

  // ── HUD ──────────────────────────────────────────────────────────────────

  refreshHud() {
    const s = this.sim.stats, sim = this.sim;
    const year = Math.floor(sim.day / 360);
    const month = Math.floor((sim.day % 360) / 30);
    $('m-date').textContent = `${MONTHS[month]} ${2026 + year}`;
    $('m-pop').textContent = fmt(s.population);
    $('m-jobs').textContent = fmt(s.jobs);

    const un = $('m-unemp');
    un.textContent = (s.unemployment * 100).toFixed(1) + '%';
    un.className = 'v' + (s.unemployment > 0.12 ? ' bad' : s.unemployment < 0.05 ? ' good' : '');

    const tr = $('m-traffic');
    tr.textContent = (s.congested * 100).toFixed(0) + '%';
    tr.className = 'v' + (s.congested > 0.25 ? ' bad' : '');

    // ⚠️ The treasury used to live here and it was noise: in a sandbox with no
    // fail state it only ever climbs, so it told the player nothing. The mean
    // commute is the number that actually responds to what they do to the city.
    const cm = $('m-commute');
    const mins = sim.stats.commute;
    cm.textContent = mins > 0 ? mins.toFixed(1) + ' min' : '—';
    cm.className = 'v' + (mins > 32 ? ' bad' : mins > 0 && mins < 18 ? ' good' : '');
    cm.title = sim.stats.stranded > 0
      ? `${fmt(sim.stats.stranded)} people cannot reach any work by road`
      : 'population-weighted mean travel time to work';
  }

  // ── overlays ─────────────────────────────────────────────────────────────

  _buildOverlays() {
    const row = $('overlay-row');
    row.innerHTML = '';
    for (const [key, def] of Object.entries(OVERLAYS)) {
      const b = document.createElement('button');
      b.textContent = def.label; b.dataset.overlay = key; b.title = def.hint;
      b.addEventListener('click', () => this.applyOverlay(key));
      row.appendChild(b);
    }
  }

  applyOverlay(key) {
    this.overlay = key;
    for (const b of $('overlay-row').children) b.classList.toggle('on', b.dataset.overlay === key);

    const spec = OVERLAY_DATA[key];
    const legend = $('legend');
    if (!spec) {
      legend.classList.remove('on');
      this.view.setOverlay('none', null);
      return;
    }
    if (spec.legend) {
      legend.classList.add('on');
      $('legend-lo').textContent = spec.legend[0];
      $('legend-hi').textContent = spec.legend[1];
      $('legend-bar').style.background = spec.invert
        ? 'linear-gradient(90deg, hsl(140 62% 45%), hsl(0 62% 45%))'
        : 'linear-gradient(90deg, hsl(0 62% 45%), hsl(140 62% 45%))';
    } else {
      legend.classList.remove('on');
    }
    this.repaintOverlay(true);
  }

  repaintOverlay(force = false) {
    const spec = OVERLAY_DATA[this.overlay];
    if (!spec) return;
    if (!force && this.speed === 0) return;   // paused and unchanged: nothing to redo
    const sim = this.sim;
    this.view.setOverlay(this.overlay, {
      valueAt: i => spec.valueAt(sim, i),
      hueFor: v => {
        if (spec.colourAt) return 0;
        const t = spec.invert ? 1 - v : v;
        return (t * 140) / 360;              // red (0) -> green (140)
      },
      colourAt: spec.colourAt ? i => spec.colourAt(sim, i) : null,
    });
  }


  // ── streets ──────────────────────────────────────────────────────────────

  _buildRoadButtons() {
    const row = $('road-row');
    if (!row) return;
    row.innerHTML = '';
    const add = (label, title, fn, cls) => {
      const b = document.createElement('button');
      b.textContent = label; b.title = title;
      if (cls) b.className = cls;
      b.addEventListener('click', fn);
      row.appendChild(b);
    };
    add('Close', 'Shut this street to traffic — it stays on the map', () => this.roadOp('close'));
    add('Reopen', 'Let traffic back on', () => this.roadOp('open'));
    add('Widen', 'More lanes, more capacity', () => this.roadOp('widen'));
    add('Narrow', 'Fewer lanes', () => this.roadOp('narrow'));
    add('Tear out', 'Remove the street entirely', () => this.roadOp('remove'), 'danger');
    // The what-if this whole sandbox exists for.
    add('⚑ Select every freeway', 'Select all motorways and trunk roads — then tear them out',
        () => this.selectFreeways(), 'wide');
  }

  selectRoad(index, additive) {
    if (index == null || index < 0) { if (!additive) this.clearRoadSelection(); return; }
    if (!additive) this.roadSel.clear();
    if (this.roadSel.has(index)) this.roadSel.delete(index);
    else this.roadSel.add(index);
    this.refreshRoads();
  }

  clearRoadSelection() { this.roadSel.clear(); this.refreshRoads(); }

  /** Every motorway and trunk road on the map — the freeway what-if in one click. */
  selectFreeways() {
    this.roadSel.clear();
    for (const i of this.sim.roadsOfKind('highway')) this.roadSel.add(i);
    this.selection.clear();
    this.refreshSelection();
    this.refreshRoads();
    this.toast(this.roadSel.size
      ? `${this.roadSel.size} freeway segments selected — now tear them out`
      : 'no freeways on this map', !this.roadSel.size);
  }

  roadOp(op) {
    if (!this.roadSel.size) return this.toast('Select a street first', true);
    const r = this.sim.execCommand({ t: 'road', ids: [...this.roadSel], op });
    if (!r.ok) return this.toast(r.reason, true);
    const verb = { close: 'closed', open: 'reopened', widen: 'widened',
                   narrow: 'narrowed', remove: 'torn out' }[op] || op;
    this.toast(`${r.count} street${r.count === 1 ? '' : 's'} ${verb}`);
    this.refreshHud();
    this.refreshRoads();
    this.repaintOverlay(true);
  }

  refreshRoads() {
    this.view.paintRoads(this.sim.roadState, this.sim.roadLanes, this.roadSel);
    const info = $('road-info');
    if (!info) return;
    const n = this.roadSel.size;
    const s = this.sim.stats;
    const state = [];
    if (s.roadsClosed) state.push(`${s.roadsClosed} closed`);
    if (s.roadsTorn) state.push(`${s.roadsTorn} torn out`);
    const suffix = state.length ? ` · ${state.join(', ')} citywide` : '';
    info.innerHTML = n
      ? `<b>${n}</b> street${n === 1 ? '' : 's'} selected${suffix}`
      : `click a street to select it · shift-click to add${suffix}`;
  }

  // ── selection & commands ─────────────────────────────────────────────────

  _buildZoneButtons() {
    const row = $('zone-row');
    row.innerHTML = '';
    for (const kind of ZONE_KINDS) {
      if (kind === 'none') continue;
      const def = ZONES[kind];
      const b = document.createElement('button');
      b.textContent = `${def.icon} ${def.label}`;
      b.addEventListener('click', () => this.rezone(kind));
      row.appendChild(b);
    }
    const d = document.createElement('button');
    d.textContent = '✕ Clear';
    d.title = 'Demolish — returns the plot to vacant';
    d.addEventListener('click', () => this.demolish());
    row.appendChild(d);
  }

  select(index, additive) {
    if (index == null || index < 0) { if (!additive) this.clearSelection(); return; }
    if (!additive) { this.selection.clear(); this.roadSel.clear(); this.refreshRoads(); }
    if (this.selection.has(index)) this.selection.delete(index);
    else this.selection.add(index);
    this.refreshSelection();
  }

  clearSelection() {
    this.selection.clear(); this.roadSel.clear();
    this.refreshSelection(); this.refreshRoads();
  }

  refreshSelection() {
    const n = this.selection.size;
    const info = $('sel-info');
    if (!n) {
      info.textContent = 'click a building to select it · shift-click to add';
      return;
    }
    let area = 0, occ = 0, cap = 0;
    for (const i of this.selection) {
      area += this.sim.world.buildings[i].a;
      occ += this.sim.occ[i]; cap += this.sim.cap[i];
    }
    const cost = area * REZONE_COST_PER_M2;
    info.innerHTML = `<b>${n}</b> selected · ${fmt(area)} m² · ` +
      `${fmt(occ)}/${fmt(cap)} occupied · rezone costs <b>${money(cost)}</b>`;
  }

  rezone(kind) {
    if (!this.selection.size) return this.toast('Select a building first', true);
    const r = this.sim.execCommand({ t: 'rezone', ids: [...this.selection], zone: kind });
    if (!r.ok) return this.toast(r.reason === 'not enough money'
      ? `Not enough money — that costs ${money(r.cost)}` : r.reason, true);
    this.toast(`${r.count} building${r.count === 1 ? '' : 's'} rezoned to ${ZONES[kind].label} · ${money(r.cost)}`);
    this.afterCommand();
  }

  demolish() {
    if (!this.selection.size) return this.toast('Select a building first', true);
    const r = this.sim.execCommand({ t: 'demolish', ids: [...this.selection] });
    if (!r.ok) return this.toast(r.reason, true);
    this.toast(`${r.count} plot${r.count === 1 ? '' : 's'} cleared · ${money(r.cost)}`);
    this.afterCommand();
  }

  afterCommand() {
    this.refreshHud();
    this.refreshSelection();
    this.repaintOverlay(true);
  }

  toast(msg, bad = false) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { t.className = ''; }, 2600);
  }
}
