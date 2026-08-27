// game.js — the play layer: HUD, overlays, selection, and the tick clock.
//
// Reads the Sim, issues COMMANDS to it, and tells the View how to paint.
// It never writes sim state directly — every mutation goes through
// `sim.execCommand`, which is what keeps a city reproducible.

import { TICK, ZONES, ZONE_KINDS, ZONE_INDEX, OVERLAYS, REZONE_COST_PER_M2, TRANSIT, SERVICES, SERVICE_KINDS, SERVICE_INDEX } from './data.js';
import { encode as encodeShare, CommandLog } from './share.js';
import { BRANCHES, NODES, NODE_BY_ID, costOf, canBuy } from './tree.js';

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
  services: {
    valueAt: (sim, i) => sim.zone[i] === ZONE_INDEX.none && !sim.service[i]
      ? null : sim.serviceScoreAt(i),
    legend: ['no services near', 'well served'],
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

    // ⚠️ STATE BEFORE BUILDERS. _buildSeaSlider() calls setSea(0), which routes
    // through issue(), which needs the log — creating the log afterwards threw
    // on construction and the game never booted. Anything a UI builder can reach
    // must already exist here.
    // Every command the player issues, day-stamped. This IS the share link.
    this.log = new CommandLog();
    // What the town looked like before this player touched it — the reference
    // for the before/after comparison.
    this.baseline = { zone: Uint8Array.from(sim.zone) };
    this.comparing = false;
    this.drawing = null;      // {kind, stops:[[x,z],…]} while laying a line

    // Buildings paint themselves from occupancy, so the city visibly thrives or
    // empties without the player switching to an overlay.
    view.lifeOf = i => {
      if (this.sim.zone[i] === ZONE_INDEX.none) return this.sim.service[i] ? 1 : 0;
      const cap = this.sim.cap[i];
      return cap > 0 ? Math.min(1, this.sim.occ[i] / cap) : null;
    };

    this._buildSpeeds();
    this._buildSeaSlider();
    this._buildOverlays();
    this._buildZoneButtons();
    this._buildServiceButtons();
    this._buildRoadButtons();
    this._buildShare();
    this._buildTransitButtons();
    this._buildTree();
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
    if (this._hudT >= 0.25) {
      this._hudT = 0;
      this.refreshHud();
      this.repaintOverlay();
      if (this.overlay === 'none' && mult > 0) this.view.paintBuildings('none', null);
      this.view.buildBubbles(this.sim.bubbles);
      this.refreshTree();
    }

    // Traffic is redistributed on a slower beat than it is drawn: the pattern
    // only changes when the model does, but the cars move every frame.
    this._trafficT = (this._trafficT || 0) + dt;
    if (this._trafficT >= 2.5) { this._trafficT = 0; this.view.traffic?.sync(); }
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
    // Priming the slider is not a player edit, so it must not enter the log —
    // otherwise every share link opens with a redundant "set sea to 0".
    this.setSea(0, { silent: true });
  }

  setSea(level, { silent = false } = {}) {
    const r = silent ? this.sim.execCommand({ t: 'sea', level }) : this.issue({ t: 'sea', level });
    if (!r.ok) return;
    const cells = this.view.buildWater(this.sim.floodMask, level);
    $('sea-value').textContent = (level >= 0 ? '+' : '') + level.toFixed(1) + ' m';
    const f = this.sim.floodStats;
    $('sea-info').innerHTML = level === 0 && !f.buildings
      ? 'drag to raise the sea'
      : `<b>${fmt(f.buildings)}</b> buildings under water · <b>${fmt(f.displaced)}</b> people displaced · <b>${f.roads}</b> streets cut`;
    this.view.traffic?.sync();
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
    const mm = $('m-momentum');
    if (mm) mm.textContent = Math.floor(sim.momentum).toLocaleString();

    const cv = $('m-coverage');
    if (cv) {
      const c = sim.stats.coverage || 0;
      cv.textContent = (c * 100).toFixed(0) + '%';
      cv.className = 'v' + (c < 0.25 ? ' bad' : c > 0.6 ? ' good' : '');
      const n = sim.stats.services || 0;
      cv.title = `${n} building${n === 1 ? '' : 's'} run services`;
    }

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




  /**
   * The ONE place a player command reaches the sim.
   *
   * ⚠️ Nothing else may call sim.execCommand. Routing everything through here is
   * what keeps the command log complete, and the log is what the share link is —
   * a command that skips this funnel is a change that silently will not travel.
   */
  issue(cmd) {
    const r = this.sim.execCommand(cmd);
    if (r && r.ok) this.log.record(this.sim.day, cmd);
    return r;
  }

  // ── share & compare ──────────────────────────────────────────────────────

  _buildShare() {
    const s = $('share-btn'), c = $('compare-btn');
    if (s) s.addEventListener('click', () => this.copyLink());
    if (!c) return;
    // hold, do not toggle — a comparison you have to keep holding is one you
    // actually flick back and forth, which is the whole point
    const on = e => { e.preventDefault(); this.setCompare(true); };
    const off = () => this.setCompare(false);
    c.addEventListener('pointerdown', on);
    c.addEventListener('pointerup', off);
    c.addEventListener('pointerleave', off);
  }

  async copyLink() {
    try {
      const code = await encodeShare(this.sim.world, this.sim.day, this.log);
      const url = `${location.origin}${location.pathname}?world=${encodeURIComponent(this.sim.world.name)}#s=${code}`;
      let copied = false;
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch { /* clipboard is blocked in some contexts — fall through */ }
      // Always put it in the address bar too, so the link is recoverable even
      // when the clipboard is refused.
      history.replaceState(null, '', url);
      this.toast(copied
        ? `Link copied — ${this.log.length} change${this.log.length === 1 ? '' : 's'}, ${code.length} characters`
        : 'Link is in the address bar (clipboard was blocked)');
      return url;
    } catch (e) {
      this.toast('Could not build a link: ' + e.message, true);
      return null;
    }
  }

  /**
   * Show the town as it really is, without this player's edits.
   * Nothing in the SIM changes — only what is painted — so letting go puts the
   * real city straight back without re-running anything.
   */
  setCompare(on) {
    if (on === this.comparing) return;
    this.comparing = on;
    $('compare-btn')?.classList.toggle('on', on);
    $('compare-tag')?.classList.toggle('on', on);

    if (on) {
      this._savedOverlay = this.overlay;
      this.view.paintRoads(null, null, null);            // every street as built
      if (this.view.water) this.view.water.visible = false;

      // Reuse the overlay machinery, but read the BASELINE zoning rather than
      // the live sim. On the zoning overlay that is the whole comparison; on the
      // others the honest answer is that they describe a simulated present with
      // no "before", so fall back to natural colours.
      if (this._savedOverlay === 'zone') {
        const base = this.baseline.zone;
        this.view.setOverlay('zone', {
          valueAt: i => base[i] === ZONE_INDEX.none ? null : base[i],
          hueFor: () => 0,
          colourAt: i => base[i] === ZONE_INDEX.none
            ? null : ZONES[ZONE_KINDS[base[i]]].colour,
        });
      } else {
        this.view.setOverlay('none', null);
      }
    } else {
      if (this.view.water) this.view.water.visible = true;
      this.refreshRoads();
      this.applyOverlay(this._savedOverlay ?? 'none');
    }
    this.view.invalidateShadows();
  }



  // ── the plan ─────────────────────────────────────────────────────────────

  _buildTree() {
    const btn = $('tree-btn'), panel = $('tree-panel'), close = $('tree-close');
    if (!btn) return;
    btn.addEventListener('click', () => this.toggleTree());
    close?.addEventListener('click', () => this.toggleTree(false));

    const cols = $('tree-cols');
    cols.innerHTML = '';
    this._nodeEls = new Map();
    for (const [key, br] of Object.entries(BRANCHES)) {
      const col = document.createElement('div');
      col.innerHTML = `<div class="tcol-head">${br.icon} ${br.label}</div>
                       <div class="tcol-blurb">${br.blurb}</div>`;
      for (const n of NODES.filter(x => x.branch === key)) {
        const b = document.createElement('button');
        b.className = 'tnode';
        b.innerHTML = `<span class="ic">${n.icon}</span>
          <span><span class="nm">${n.label}</span><span class="bl">${n.blurb}</span></span>
          <span class="px"></span>`;
        b.addEventListener('click', () => this.buyNode(n.id));
        col.appendChild(b);
        this._nodeEls.set(n.id, b);
      }
      cols.appendChild(col);
    }
    this.refreshTree();
  }

  toggleTree(force) {
    const panel = $('tree-panel');
    const open = force === undefined ? !panel.classList.contains('open') : force;
    panel.classList.toggle('open', open);
    if (open) this.refreshTree();
  }

  buyNode(id) {
    const r = this.issue({ t: 'build', id });
    if (!r.ok) return this.toast(r.reason === 'not enough momentum'
      ? `Not enough momentum — ${NODE_BY_ID[id].label} costs ${r.cost}` : r.reason, true);
    this.toast(`${NODE_BY_ID[id].label} built · ${r.cost} momentum`);
    this.refreshTree();
    this.refreshHud();
    this.refreshTransit();
    this.view.traffic?.sync();
    this.repaintOverlay(true);
  }

  refreshTree() {
    if (!this._nodeEls) return;
    const owned = this.sim.owned, mom = this.sim.momentum;
    let anyAffordable = false;
    for (const n of NODES) {
      const el = this._nodeEls.get(n.id);
      const px = el.querySelector('.px');
      const has = owned.has(n.id);
      el.classList.toggle('owned', has);
      if (has) { px.textContent = 'BUILT'; px.className = 'px'; el.disabled = true; continue; }

      const check = canBuy(n, owned, mom);
      const cost = costOf(n, owned.size);
      const locked = (n.needs || []).some(d => !owned.has(d));
      el.disabled = locked || !check.ok;
      el.classList.toggle('afford', check.ok);
      px.textContent = locked ? '🔒' : cost;
      px.className = 'px' + (check.ok ? '' : ' no');
      if (check.ok) anyAffordable = true;
    }
    $('tree-btn')?.classList.toggle('can-buy', anyAffordable);
  }

  /** A click on the map may be a problem being claimed. */
  tryClaim(px, py) {
    const key = this.view.bubbleAt(px, py);
    if (!key) return false;
    const r = this.issue({ t: 'claim', key });
    if (r.ok) {
      this.toast(`+${r.value} momentum`);
      this.refreshHud();
      this.refreshTree();
      this.view.buildBubbles(this.sim.bubbles);
    }
    return true;
  }

  // ── transit ──────────────────────────────────────────────────────────────

  _buildTransitButtons() {
    const row = $('transit-row');
    if (!row) return;
    row.innerHTML = '';
    for (const [key, spec] of Object.entries(TRANSIT.kinds)) {
      const b = document.createElement('button');
      b.textContent = `${spec.icon} ${spec.label}`;
      b.dataset.kind = key;
      b.title = `${spec.speed} km/h · ${spec.accessMin} min to reach a stop`;
      b.dataset.transit = key;
      b.addEventListener('click', () => {
        if (!this._transitUnlocked(key)) {
          return this.toast(`${spec.label} is not unlocked yet — see The Plan`, true);
        }
        this.startLine(key);
      });
      row.appendChild(b);
    }
    const fin = document.createElement('button');
    fin.textContent = '✓ Finish';
    fin.addEventListener('click', () => this.finishLine());
    row.appendChild(fin);

    const clr = document.createElement('button');
    clr.textContent = '✕ All lines';
    clr.className = 'danger';
    clr.title = 'Remove every transit line';
    clr.addEventListener('click', () => {
      const r = this.issue({ t: 'transit', op: 'clear' });
      this.toast(r.ok ? `${r.count} line${r.count === 1 ? '' : 's'} removed` : r.reason, !r.ok);
      this.afterTransit();
    });
    row.appendChild(clr);
    this.refreshTransit();
  }

  /** Transit modes are earned in the tree, not given. */
  _transitUnlocked(kind) {
    const fx = this.sim.fx || {};
    return kind === 'bus' ? !!fx.unlockBus
      : kind === 'tram' ? !!fx.unlockTram
      : kind === 'metro' ? !!fx.unlockMetro : false;
  }

  startLine(kind) {
    if (!this._transitUnlocked(kind)) return this.toast('Not unlocked yet — see The Plan', true);
    if (this.drawing && this.drawing.kind === kind) { this.cancelLine(); return; }
    this.drawing = { kind, stops: [] };
    this.clearSelection();
    this.refreshTransit();
    this.toast(`Click along the map to place ${TRANSIT.kinds[kind].label.toLowerCase()} stops, then Finish`);
  }

  cancelLine() {
    this.drawing = null;
    this.view.setDraftLine(null);
    this.refreshTransit();
  }

  /** A map click while drawing drops a stop rather than selecting anything. */
  addStop(x, z) {
    if (!this.drawing) return false;
    if (this.drawing.stops.length >= TRANSIT.maxStops) {
      this.toast(`A line can have at most ${TRANSIT.maxStops} stops`, true);
      return true;
    }
    this.drawing.stops.push([Math.round(x), Math.round(z)]);
    this.view.setDraftLine(this.drawing);
    this.refreshTransit();
    return true;
  }

  finishLine() {
    if (!this.drawing) return this.toast('Pick a mode first', true);
    const { kind, stops } = this.drawing;
    if (stops.length < TRANSIT.minStops) {
      return this.toast(`A line needs at least ${TRANSIT.minStops} stops`, true);
    }
    const r = this.issue({ t: 'transit', op: 'add', kind, stops });
    this.drawing = null;
    this.view.setDraftLine(null);
    if (!r.ok) { this.refreshTransit(); return this.toast(r.reason, true); }
    this.toast(`${TRANSIT.kinds[kind].label} line laid — ${r.stops} stops, ${r.km.toFixed(2)} km`);
    this.afterTransit();
  }

  afterTransit() {
    this.view.buildTransit(this.sim.transit);
    this.view.traffic?.sync();
    this.refreshHud();
    this.refreshTransit();
    this.refreshRoads();
    this.repaintOverlay(true);
  }

  refreshTransit() {
    const row = $('transit-row');
    if (row) {
      for (const b of row.children) {
        if (!b.dataset.kind) continue;
        b.classList.toggle('drawing', !!this.drawing && this.drawing.kind === b.dataset.kind);
        const unlocked = this._transitUnlocked(b.dataset.kind);
        b.disabled = !unlocked;
        b.style.opacity = unlocked ? '' : '0.45';
      }
    }
    const info = $('transit-info');
    if (!info) return;
    const s = this.sim.stats;
    if (this.drawing) {
      const n = this.drawing.stops.length;
      info.innerHTML = `laying a ${TRANSIT.kinds[this.drawing.kind].label.toLowerCase()} — <b>${n}</b> stop${n === 1 ? '' : 's'} placed ` +
        `${n >= TRANSIT.minStops ? '· press Finish' : `· ${TRANSIT.minStops - n} more needed`}`;
    } else if (s.transitLines) {
      info.innerHTML = `<b>${s.transitLines}</b> line${s.transitLines === 1 ? '' : 's'} · ` +
        `<b>${s.transitKm.toFixed(1)}</b> km · <b>${(s.transitShare * 100).toFixed(1)}%</b> of trips ride`;
    } else {
      info.textContent = 'pick a mode, then click along the map';
    }
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
    const r = this.issue({ t: 'road', ids: [...this.roadSel], op });
    if (!r.ok) return this.toast(r.reason, true);
    const verb = { close: 'closed', open: 'reopened', widen: 'widened',
                   narrow: 'narrowed', remove: 'torn out' }[op] || op;
    this.toast(`${r.count} street${r.count === 1 ? '' : 's'} ${verb}`);
    this.view.traffic?.sync();
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


  _buildServiceButtons() {
    const row = $('service-row');
    if (!row) return;
    row.innerHTML = '';
    for (const [key, def] of Object.entries(SERVICES)) {
      const b = document.createElement('button');
      b.textContent = `${def.icon} ${def.label}`;
      b.title = `Turn the selected buildings into ${def.label.toLowerCase()}`;
      b.addEventListener('click', () => this.makeService(key));
      row.appendChild(b);
    }
  }

  makeService(kind) {
    if (!this.selection.size) return this.toast('Select a building first', true);
    const r = this.issue({ t: 'service', ids: [...this.selection], kind });
    if (!r.ok) {
      return this.toast(r.reason === 'not enough money'
        ? `Not enough money — that costs ${money(r.cost)}` : r.reason, true);
    }
    const label = SERVICES[kind] ? SERVICES[kind].label.toLowerCase() : kind;
    this.toast(`${r.count} building${r.count === 1 ? '' : 's'} now ${label} · ${money(r.cost)}`);
    this.afterCommand();
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
    const svc = {};
    for (const i of this.selection) {
      const k = SERVICE_KINDS[this.sim.service[i]];
      if (k !== 'none') svc[k] = (svc[k] || 0) + 1;
    }
    const svcLabel = Object.keys(svc).length
      ? ' · ' + Object.entries(svc).map(([k, c]) =>
          `${c}× ${SERVICES[k] ? SERVICES[k].icon : ''}${SERVICES[k] ? SERVICES[k].label : k}`).join(', ')
      : '';
    info.innerHTML = `<b>${n}</b> selected · ${fmt(area)} m² · ` +
      `${fmt(occ)}/${fmt(cap)} occupied${svcLabel} · rezone costs <b>${money(cost)}</b>`;
  }

  rezone(kind) {
    if (!this.selection.size) return this.toast('Select a building first', true);
    const r = this.issue({ t: 'rezone', ids: [...this.selection], zone: kind });
    if (!r.ok) return this.toast(r.reason === 'not enough money'
      ? `Not enough money — that costs ${money(r.cost)}` : r.reason, true);
    this.toast(`${r.count} building${r.count === 1 ? '' : 's'} rezoned to ${ZONES[kind].label} · ${money(r.cost)}`);
    this.afterCommand();
  }

  demolish() {
    if (!this.selection.size) return this.toast('Select a building first', true);
    const r = this.issue({ t: 'demolish', ids: [...this.selection] });
    if (!r.ok) return this.toast(r.reason, true);
    this.toast(`${r.count} plot${r.count === 1 ? '' : 's'} cleared · ${money(r.cost)}`);
    this.afterCommand();
  }

  afterCommand() {
    this.view.traffic?.sync();
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
