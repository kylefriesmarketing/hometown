// test-sim.mjs — headless checks for M2: the street graph, the scalar fields
// and the simulation. `node test-sim.mjs`
//
// ⚠️ RUN THIS AFTER EVERY SIM CHANGE. The determinism and save-round-trip
// blocks are the contract the whole design rests on: if they go red, replays
// and any future networked play are already broken even if the game "works".

import { World } from './world.js';
import { RoadGraph } from './graph.js';
import { Sim } from './sim.js';
import { chamfer, chamferFrom, sampleField, stampPolyline, floodFromEdges } from './field.js';
import { ZONE_INDEX, TRANSIT, JUNCTION_DELAY, SERVICE_INDEX } from './data.js';
import { wallColour, roofColour, hash01 } from './palette.js';
import {
  encodeBytes, decodeBytes, toBase64Url, fromBase64Url,
  applyShare, CommandLog, MAX_REPLAY_DAYS, MAX_ENTRIES,
} from './share.js';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) pass++;
  else { fail++; fails.push(`${name}${detail ? ' — ' + detail : ''}`); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── field.js ────────────────────────────────────────────────────────────────
{
  const cols = 11, rows = 11, cell = 10;
  const d = chamfer(cols, rows, cell, (i, j) => i === 5 && j === 5);
  ok('chamfer is zero at the source', near(d[5 * cols + 5], 0, 1e-9));
  ok('chamfer grows orthogonally', near(d[5 * cols + 8], 30, 1e-6), String(d[5 * cols + 8]));
  ok('chamfer diagonal is ~root2 per step',
     Math.abs(d[8 * cols + 8] - 30 * Math.SQRT2) < 1e-3, String(d[8 * cols + 8]));
  ok('chamfer is symmetric', near(d[5 * cols + 2], d[5 * cols + 8], 1e-6));

  const f = new Float32Array(cols * rows).fill(1e6);
  stampPolyline(f, cols, rows, cell, -50, -50, [-50, 0, 50, 0]);
  const line = chamferFrom(f, cols, rows, cell);
  ok('stampPolyline seeds a whole line',
     near(line[5 * cols + 0], 0, 1e-9) && near(line[5 * cols + 10], 0, 1e-9));
  ok('distance grows away from the line', line[8 * cols + 5] > line[6 * cols + 5]);
  ok('sampleField interpolates', sampleField(line, cols, rows, cell, -50, -50, 0, 5) > 0);
}

// ── a synthetic grid town, so assertions can be exact ──────────────────────
//
// `pad` extends the WORLD beyond the road grid, leaving genuinely roadless
// ground at the edges. Without it the street grid reaches the world corner and
// there is nowhere in the map more than half a block from a road — which
// quietly invalidates any "far from a road" assertion.
function gridTown({ span = 4, block = 100, pad = 0 } = {}) {
  const roads = [];
  const half = span * block / 2;
  for (let i = 0; i <= span; i++) {
    const c = -half + i * block;
    const ew = [], ns = [];
    for (let j = 0; j <= span; j++) {
      const d = -half + j * block;
      ew.push(d, c); ns.push(c, d);
    }
    roads.push({ c: 'residential', k: 'street', w: 8, r: 4, o: 0, pts: ew });
    roads.push({ c: 'residential', k: 'street', w: 8, r: 4, o: 0, pts: ns });
  }

  const buildings = [];
  for (let i = 0; i < span; i++) {
    for (let j = 0; j < span; j++) {
      const cx = -half + i * block + block / 2;
      const cz = -half + j * block + block / 2;
      const s = 14;
      buildings.push({
        id: `b${i}_${j}`, kind: (i + j) % 3 === 0 ? 'commercial' : 'residential',
        ks: 'tag', h: 10, lv: 3, base: 0, g: 0, gm: 0, gx: 0,
        a: s * s * 4, c: [cx, cz],
        ring: [cx - s, cz - s, cx + s, cz - s, cx + s, cz + s, cx - s, cz + s],
      });
    }
  }

  const extent = span * block + pad * 2;
  const cols = extent / 10 + 1, rows = cols;
  return new World({
    name: 'grid', label: 'grid', origin: { lat: 0, lon: 0 },
    size: { width: extent, depth: extent },
    terrain: { cols, rows, cell: 10, minH: 0, maxH: 0, heights: new Array(cols * rows).fill(0) },
    buildings, roads, areas: [], waterways: [], rails: [], pois: [], meta: {},
  });
}

// ── graph.js ────────────────────────────────────────────────────────────────
{
  const w = gridTown();
  const g = new RoadGraph(w);
  ok('graph has nodes', g.nodeCount > 0, String(g.nodeCount));
  ok('graph has edges', g.edgeCount > 0, String(g.edgeCount));

  const comp = g.components();
  ok('a grid is ONE connected component', comp.count === 1,
     `${comp.count} components, largest share ${comp.largestShare.toFixed(3)}`);
  // ⚠️ The guard that matters: topology is recovered from COORDINATE IDENTITY,
  // so any change to how the baker rounds coordinates shows up here first.
  ok('graph connectivity is near-total', comp.largestShare > 0.99, String(comp.largestShare));

  const a = g.nearestNode(-200, -200), b = g.nearestNode(200, 200);
  ok('nearestNode finds corners', a >= 0 && b >= 0);
  ok('nearestNode rejects a far point', g.nearestNode(99999, 99999, 50) === -1);

  const dist = g.dijkstra(a);
  ok('dijkstra is zero at the origin', near(dist[a], 0, 1e-9));
  ok('dijkstra reaches the far corner', Number.isFinite(dist[b]), String(dist[b]));

  const path = g.pathEdges(a, b);
  ok('pathEdges returns a path', path.length > 0, String(path.length));
  let plen = 0;
  for (const e of path) plen += g.elen[e];
  ok('path length is the grid distance', plen >= 799 && plen <= 801, String(plen));

  const free = g.edgeTime(0);
  g.load[0] = g.ecap[0] * 2;
  const busy = g.edgeTime(0);
  ok('BPR slows a loaded edge', busy > free * 1.5, `${free.toFixed(3)} -> ${busy.toFixed(3)}`);
  g.load[0] = 0;
  ok('BPR is free-flow at zero load', near(g.edgeTime(0), free, 1e-9));
}

// ── determinism: the contract everything else rests on ─────────────────────
{
  const mk = () => { const w = gridTown(); return new Sim(w, new RoadGraph(w), { seed: 99 }); };

  const a = mk(), b = mk();
  ok('two fresh sims agree', a.stateHash() === b.stateHash());

  for (let i = 0; i < 120; i++) { a.tick(); b.tick(); }
  ok('same seed ticks identically', a.stateHash() === b.stateHash(),
     `${a.stateHash()} vs ${b.stateHash()}`);

  const c = mk();
  for (let i = 0; i < 120; i++) c.tick();
  ok('a third run agrees too', c.stateHash() === a.stateHash());

  const d = mk();
  for (let i = 0; i < 60; i++) d.tick();
  d.execCommand({ t: 'rezone', ids: [0, 1, 2], zone: 'industrial' });
  for (let i = 0; i < 60; i++) d.tick();
  ok('a command changes the outcome', d.stateHash() !== a.stateHash());
}

// ── save round-trip ────────────────────────────────────────────────────────
{
  const w = gridTown();
  const sim = new Sim(w, new RoadGraph(w), { seed: 5 });
  for (let i = 0; i < 90; i++) sim.tick();
  sim.execCommand({ t: 'rezone', ids: [3, 4], zone: 'commercial' });
  for (let i = 0; i < 30; i++) sim.tick();

  const before = sim.stateHash();
  const snap = JSON.parse(JSON.stringify(sim.snapshot()));

  const w2 = gridTown();
  const sim2 = new Sim(w2, new RoadGraph(w2), { seed: 1 });   // deliberately wrong seed
  sim2.restore(snap);
  ok('restore reproduces the hash', sim2.stateHash() === before,
     `${sim2.stateHash()} vs ${before}`);

  for (let i = 0; i < 40; i++) { sim.tick(); sim2.tick(); }
  ok('a restored sim stays in step', sim.stateHash() === sim2.stateHash());

  // ⚠️ derived state must be REBUILT by restore, never trusted from the blob
  ok('restore rebuilt capacity', sim2.cap[3] > 0);
  ok('restore rebuilt desirability', Array.from(sim2.desire).some(v => v > 0));
  ok('restore rebuilt traffic', Array.from(sim2.graph.load).some(v => v > 0));
  ok('restore rejects an unknown version', (() => {
    try { sim2.restore({ v: 99 }); return false; } catch { return true; }
  })());
}

// ── capacity, commands, money ──────────────────────────────────────────────
{
  const w = gridTown();
  const sim = new Sim(w, new RoadGraph(w), { seed: 3 });
  const b = w.buildings[0];
  const floor = b.a * b.lv;

  sim.execCommand({ t: 'rezone', ids: [0], zone: 'residential' });
  ok('residential capacity is floor area / 45',
     near(sim.cap[0], floor / 45, 1e-4), `${sim.cap[0]} vs ${floor / 45}`);
  sim.execCommand({ t: 'rezone', ids: [0], zone: 'commercial' });
  ok('commercial capacity is floor area / 30',
     near(sim.cap[0], floor / 30, 1e-4), `${sim.cap[0]} vs ${floor / 30}`);
  ok('rezoning empties the building', sim.occ[0] === 0);

  ok('unknown zone is rejected', sim.execCommand({ t: 'rezone', ids: [0], zone: 'nope' }).ok === false);
  ok('unknown command is rejected', sim.execCommand({ t: 'wat' }).ok === false);
  ok('empty selection is rejected', sim.execCommand({ t: 'rezone', ids: [], zone: 'civic' }).ok === false);
  ok('out-of-range ids are filtered',
     sim.execCommand({ t: 'rezone', ids: [999999], zone: 'civic' }).ok === false);

  const before = sim.money;
  const r = sim.execCommand({ t: 'rezone', ids: [1], zone: 'industrial' });
  ok('rezoning costs money', r.ok && r.cost > 0 && near(sim.money, before - r.cost, 1e-4));

  const pw = gridTown();
  const poor = new Sim(pw, new RoadGraph(pw), { seed: 3, startMoney: 0.5 });
  const rp = poor.execCommand({ t: 'rezone', ids: [0, 1, 2, 3], zone: 'civic' });
  ok('a broke city cannot rezone', rp.ok === false && rp.reason === 'not enough money');
  ok('a rejected command changes nothing', poor.money === 0.5);

  const dem = sim.execCommand({ t: 'demolish', ids: [2] });
  ok('demolish clears the plot',
     dem.ok && sim.zone[2] === ZONE_INDEX.none && sim.cap[2] === 0 && sim.occ[2] === 0);
}

// ── the model responds to the real map ─────────────────────────────────────
{
  const w = gridTown();
  const sim = new Sim(w, new RoadGraph(w), { seed: 11 });
  for (let i = 0; i < 200; i++) sim.tick();

  ok('the town has people', sim.stats.population > 0, String(sim.stats.population));
  ok('the town has jobs', sim.stats.jobs > 0, String(sim.stats.jobs));
  ok('occupancy never exceeds capacity',
     Array.from(sim.occ).every((v, i) => v <= sim.cap[i] + 1e-4));
  ok('desirability stays in range', Array.from(sim.desire).every(v => v >= 0 && v <= 1));
  ok('traffic reaches the network', Array.from(sim.graph.load).some(v => v > 0));
  ok('finances were settled', typeof sim.lastIncome === 'number' && sim.lastIncome > 0);
  ok('history is recorded', sim.history.length > 0);
  ok('unemployment is a fraction', sim.stats.unemployment >= 0 && sim.stats.unemployment <= 1);

  // ⚠️ The whole reason for choosing OSM: real map facts must MATTER.
  // Compare the SAME building on the grid vs stranded out on roadless ground.
  const onGrid = gridTown({ pad: 300 });
  const offGrid = gridTown({ pad: 300 });
  offGrid.buildings[0].c = [offGrid.x0 + 40, offGrid.z0 + 40];
  const roadNear = onGrid.roadDistAt(...onGrid.buildings[0].c);
  const roadFar = offGrid.roadDistAt(...offGrid.buildings[0].c);
  ok('the stranded plot really is farther from a road', roadFar > roadNear + 100,
     `${roadFar.toFixed(0)} m vs ${roadNear.toFixed(0)} m`);

  const s1 = new Sim(onGrid, new RoadGraph(onGrid), { seed: 11 });
  const s2 = new Sim(offGrid, new RoadGraph(offGrid), { seed: 11 });
  for (let i = 0; i < 200; i++) { s1.tick(); s2.tick(); }
  ok('a plot far from a road is less desirable', s2.desire[0] < s1.desire[0],
     `${s2.desire[0].toFixed(3)} vs ${s1.desire[0].toFixed(3)}`);
}

// slope has to bite, or the elevation data is decoration
{
  const flat = gridTown();
  const steep = gridTown();
  const h = new Float32Array(steep.cols * steep.rows);
  for (let j = 0; j < steep.rows; j++) {
    for (let i = 0; i < steep.cols; i++) h[j * steep.cols + i] = j * 4;   // 40% grade
  }
  steep.heights = h; steep.maxH = (steep.rows - 1) * 4;

  const a = new Sim(flat, new RoadGraph(flat), { seed: 2 });
  const b = new Sim(steep, new RoadGraph(steep), { seed: 2 });
  for (let i = 0; i < 120; i++) { a.tick(); b.tick(); }
  ok('a steep town is less desirable than a flat one',
     b.stats.avgDesire < a.stats.avgDesire,
     `steep ${b.stats.avgDesire.toFixed(3)} vs flat ${a.stats.avgDesire.toFixed(3)}`);
}

// industry must depress the housing next to it
{
  const w = gridTown();
  const sim = new Sim(w, new RoadGraph(w), { seed: 4 });
  for (let i = 0; i < 150; i++) sim.tick();
  const victim = 5;
  const beforeD = sim.desire[victim];

  // zone the victim's neighbours industrial
  const neighbours = [];
  for (let i = 0; i < w.buildings.length; i++) {
    if (i === victim) continue;
    const dx = w.buildings[i].c[0] - w.buildings[victim].c[0];
    const dz = w.buildings[i].c[1] - w.buildings[victim].c[1];
    if (Math.hypot(dx, dz) < 160) neighbours.push(i);
  }
  ok('the victim has neighbours to pollute', neighbours.length > 0, String(neighbours.length));
  sim.execCommand({ t: 'rezone', ids: neighbours, zone: 'industrial' });
  for (let i = 0; i < 150; i++) sim.tick();
  ok('industry next door hurts housing', sim.desire[victim] < beforeD,
     `${sim.desire[victim].toFixed(3)} vs ${beforeD.toFixed(3)}`);
}


// ── flooding ───────────────────────────────────────────────────────────────
{
  // A bowl: high rim, low middle, with ONE low channel out to the west edge.
  const cols = 21, rows = 21, cell = 10;
  const heights = new Float32Array(cols * rows).fill(10);
  for (let j = 8; j <= 12; j++) for (let i = 8; i <= 12; i++) heights[j * cols + i] = -2; // inner basin
  for (let j = 2; j <= 4; j++) for (let i = 0; i <= 4; i++) heights[j * cols + i] = -2;   // sea inlet at the edge

  const dry = floodFromEdges(heights, cols, rows, 0);
  const inlet = dry[3 * cols + 1], basin = dry[10 * cols + 10];
  ok('the sea floods in from the edge', inlet === 1);
  // ⚠️ THE POINT OF A CONNECTED FILL: the basin is below sea level but the sea
  // cannot reach it, so it must stay dry. A plain height test floods it.
  ok('an unreachable basin stays dry', basin === 0);

  // carve a channel and it must fill
  for (let i = 4; i <= 8; i++) heights[10 * cols + i] = -2;
  for (let j = 4; j <= 10; j++) heights[j * cols + 4] = -2;
  const joined = floodFromEdges(heights, cols, rows, 0);
  ok('a connected basin does flood', joined[10 * cols + 10] === 1);

  ok('a low sea floods less than a high sea', (() => {
    const lo = floodFromEdges(heights, cols, rows, -1);
    const hi = floodFromEdges(heights, cols, rows, 11);   // above the 10 m rim
    let a = 0, b = 0;
    for (let i = 0; i < lo.length; i++) { a += lo[i]; b += hi[i]; }
    return b > a;
  })());
}

// flooding must actually change the city, not just tint it
{
  const w = gridTown();
  // tilt the whole town so the west half is below sea level
  const hh = new Float32Array(w.cols * w.rows);
  for (let j = 0; j < w.rows; j++) {
    for (let i = 0; i < w.cols; i++) hh[j * w.cols + i] = (i - w.cols / 2) * 0.6;
  }
  w.heights = hh; w.minH = hh[0]; w.maxH = hh[w.cols - 1];
  for (const b of w.buildings) { b.gm = w.heightAt(b.c[0], b.c[1]); b.gx = b.gm; }

  const sim = new Sim(w, new RoadGraph(w), { seed: 8 });
  for (let i = 0; i < 120; i++) sim.tick();
  const before = { pop: sim.stats.population, hash: sim.stateHash() };
  ok('the dry town has people', before.pop > 0);

  const r = sim.execCommand({ t: 'sea', level: 5 });
  ok('raising the sea reports damage', r.ok && r.buildings > 0, JSON.stringify(r));
  ok('drowned buildings are emptied',
     Array.from(sim.floodedB).every((f, i) => !f || sim.occ[i] === 0));
  ok('drowned streets are cut', r.roads > 0, String(r.roads));
  ok('the sea changes the hash', sim.stateHash() !== before.hash);

  for (let i = 0; i < 60; i++) sim.tick();
  ok('drowned buildings do not repopulate',
     Array.from(sim.floodedB).every((f, i) => !f || sim.occ[i] === 0));
  ok('the town lost people to the sea', sim.stats.population < before.pop,
     `${Math.round(sim.stats.population)} vs ${Math.round(before.pop)}`);

  // routing must go AROUND the water, never through it
  const g = sim.graph;
  const a = g.nearestNode(w.x0 + 30, 0);
  if (a >= 0) {
    const dist = g.dijkstra(a);
    let usedFlooded = false;
    for (let e = 0; e < g.edgeCount; e++) {
      if (sim.floodedE[e] && Number.isFinite(dist[g.eb[e]]) && g._prevEdge[g.eb[e]] === e) usedFlooded = true;
    }
    ok('routing never crosses flooded street', !usedFlooded);
  }

  // and the sea must round-trip through a save
  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  const w2 = gridTown();
  w2.heights = hh; w2.minH = w.minH; w2.maxH = w.maxH;
  for (const b of w2.buildings) { b.gm = w2.heightAt(b.c[0], b.c[1]); b.gx = b.gm; }
  const sim2 = new Sim(w2, new RoadGraph(w2), { seed: 1 });
  sim2.restore(snap);
  ok('sea level survives a save', sim2.seaLevel === 5);
  ok('a flooded city round-trips', sim2.stateHash() === sim.stateHash());
}


// ── street surgery ─────────────────────────────────────────────────────────
{
  const w = gridTown();
  const sim = new Sim(w, new RoadGraph(w), { seed: 12 });
  for (let i = 0; i < 120; i++) sim.tick();

  const g = sim.graph;
  ok('every edge maps to a real world road',
     Array.from(g.eroad).every(r => r >= 0 && r < w.roads.length));
  ok('edge road indices point at DRIVABLE roads',
     Array.from(g.eroad).every(r => w.roads[r].k !== 'foot'));

  const before = sim.stateHash();
  const target = g.eroad[0];

  // close
  const rc = sim.execCommand({ t: 'road', ids: [target], op: 'close' });
  ok('closing a street reports a change', rc.ok && rc.count === 1, JSON.stringify(rc));
  ok('closing changes the hash', sim.stateHash() !== before);
  let anyBlocked = false;
  for (let e = 0; e < g.edgeCount; e++) if (g.eroad[e] === target && g.blockedPlayer[e]) anyBlocked = true;
  ok('closing blocks its graph edges', anyBlocked);

  // routing must not use it
  const usesClosed = () => {
    for (let n = 0; n < g.nodeCount; n += 7) {
      g.dijkstra(n);
      for (let e = 0; e < g.edgeCount; e++) {
        if (!g._shut[e]) continue;
        if (g._prevEdge[g.eb[e]] === e || g._prevEdge[g.ea[e]] === e) return true;
      }
    }
    return false;
  };
  ok('routing never uses a closed street', !usesClosed());

  // reopen
  sim.execCommand({ t: 'road', ids: [target], op: 'open' });
  let stillBlocked = false;
  for (let e = 0; e < g.edgeCount; e++) if (g.eroad[e] === target && g.blockedPlayer[e]) stillBlocked = true;
  ok('reopening unblocks it', !stillBlocked);

  // widen / narrow move capacity
  const capBefore = g.capacityOf(0);
  sim.execCommand({ t: 'road', ids: [g.eroad[0]], op: 'widen' });
  ok('widening raises capacity', g.capacityOf(0) > capBefore,
     `${capBefore.toFixed(0)} -> ${g.capacityOf(0).toFixed(0)}`);
  sim.execCommand({ t: 'road', ids: [g.eroad[0]], op: 'narrow' });
  sim.execCommand({ t: 'road', ids: [g.eroad[0]], op: 'narrow' });
  ok('narrowing lowers capacity', g.capacityOf(0) < capBefore,
     `${capBefore.toFixed(0)} -> ${g.capacityOf(0).toFixed(0)}`);

  ok('an unknown road op is rejected',
     sim.execCommand({ t: 'road', ids: [0], op: 'teleport' }).ok === false);
  ok('an empty street selection is rejected',
     sim.execCommand({ t: 'road', ids: [], op: 'close' }).ok === false);
}

// ⚠️ THE TWO BLOCK SOURCES MUST STAY INDEPENDENT. The sea receding must not
// reopen a street the player closed, and reopening a street must not un-flood it.
{
  const w = gridTown();
  const hh = new Float32Array(w.cols * w.rows);
  for (let j = 0; j < w.rows; j++) {
    for (let i = 0; i < w.cols; i++) hh[j * w.cols + i] = (i - w.cols / 2) * 0.6;
  }
  w.heights = hh; w.minH = hh[0]; w.maxH = hh[w.cols - 1];
  for (const b of w.buildings) { b.gm = w.heightAt(b.c[0], b.c[1]); b.gx = b.gm; }

  const sim = new Sim(w, new RoadGraph(w), { seed: 9 });
  const g = sim.graph;

  // close a street on the DRY side
  let dryRoad = -1;
  for (let e = 0; e < g.edgeCount; e++) {
    if (g.nx[g.ea[e]] > w.width * 0.3) { dryRoad = g.eroad[e]; break; }
  }
  ok('found a dry street to close', dryRoad >= 0);
  sim.execCommand({ t: 'road', ids: [dryRoad], op: 'close' });

  sim.execCommand({ t: 'sea', level: 5 });
  ok('flood and player blocks coexist',
     Array.from(g.blockedFlood).some(Boolean) && Array.from(g.blockedPlayer).some(Boolean));

  sim.execCommand({ t: 'sea', level: -50 });   // drain it completely
  ok('draining the sea clears flood blocks', !Array.from(g.blockedFlood).some(Boolean));
  ok('draining the sea does NOT reopen a closed street',
     Array.from(g.blockedPlayer).some(Boolean));

  sim.execCommand({ t: 'sea', level: 5 });
  sim.execCommand({ t: 'road', ids: [dryRoad], op: 'open' });
  ok('reopening a street does NOT un-flood the map',
     Array.from(g.blockedFlood).some(Boolean));
}

// tearing out the freeway must actually cost the city something
{
  const w = gridTown({ span: 6, block: 120 });
  // promote the middle east-west road to a motorway
  const mid = w.roads.findIndex(r => r.k === 'street');
  w.roads[mid].k = 'highway'; w.roads[mid].c = 'motorway'; w.roads[mid].w = 24;

  const sim = new Sim(w, new RoadGraph(w), { seed: 21 });
  for (let i = 0; i < 200; i++) sim.tick();
  const freeways = sim.roadsOfKind('highway');
  ok('roadsOfKind finds the freeway', freeways.length > 0, String(freeways.length));

  const accessBefore = sim.zoneAccess.reduce((a, b) => a + b, 0);
  sim.execCommand({ t: 'road', ids: freeways, op: 'remove' });
  for (let i = 0; i < 60; i++) sim.tick();
  const accessAfter = sim.zoneAccess.reduce((a, b) => a + b, 0);

  ok('tearing out the freeway is recorded', sim.stats.roadsTorn > 0, String(sim.stats.roadsTorn));
  ok('tearing out the freeway reduces job access', accessAfter < accessBefore,
     `${accessAfter.toFixed(0)} vs ${accessBefore.toFixed(0)}`);
}

// street edits must survive a save
{
  const w = gridTown();
  const sim = new Sim(w, new RoadGraph(w), { seed: 33 });
  for (let i = 0; i < 60; i++) sim.tick();
  sim.execCommand({ t: 'road', ids: [sim.graph.eroad[0]], op: 'close' });
  sim.execCommand({ t: 'road', ids: [sim.graph.eroad[3]], op: 'widen' });
  for (let i = 0; i < 30; i++) sim.tick();

  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  const w2 = gridTown();
  const sim2 = new Sim(w2, new RoadGraph(w2), { seed: 1 });
  sim2.restore(snap);
  ok('street state survives a save', sim2.stateHash() === sim.stateHash(),
     `${sim2.stateHash()} vs ${sim.stateHash()}`);
  ok('the closed street is still closed after load',
     Array.from(sim2.graph.blockedPlayer).some(Boolean));

  for (let i = 0; i < 40; i++) { sim.tick(); sim2.tick(); }
  ok('a city with edited streets stays in step', sim.stateHash() === sim2.stateHash());
}




// ── services ───────────────────────────────────────────────────────────────
{
  const w = gridTown({ span: 8, block: 150 });
  const sim = new Sim(w, new RoadGraph(w), { seed: 44 });
  for (let i = 0; i < 120; i++) sim.tick();

  ok('a fresh city has no player services', sim.stats.services === 0);
  const coverBefore = sim.stats.coverage;

  // put a school in the middle and one at each corner
  const mid = w.buildings.findIndex(b => Math.hypot(b.c[0], b.c[1]) < 120);
  ok('found a central building', mid >= 0);
  const r = sim.execCommand({ t: 'service', ids: [mid], kind: 'education' });
  ok('a building can become a school', r.ok && r.count === 1, JSON.stringify(r));
  ok('it is recorded as a school', sim.service[mid] === SERVICE_INDEX.education);
  ok('a service building is zoned civic', sim.zone[mid] === ZONE_INDEX.civic);
  ok('a service costs money', r.cost > 0);

  // ⚠️ the point of the whole feature: coverage must actually improve nearby
  const nearby = w.buildings.findIndex((b, i) =>
    i !== mid && Math.hypot(b.c[0] - w.buildings[mid].c[0], b.c[1] - w.buildings[mid].c[1]) < 200);
  const scoreNear = sim.serviceScoreAt(nearby);
  const far = w.buildings.reduce((best, b, i) => {
    const d = Math.hypot(b.c[0] - w.buildings[mid].c[0], b.c[1] - w.buildings[mid].c[1]);
    return d > best.d ? { i, d } : best;
  }, { i: -1, d: -1 });
  ok('a school serves what is near it more than what is far',
     scoreNear > sim.serviceScoreAt(far.i),
     `${scoreNear.toFixed(3)} vs ${sim.serviceScoreAt(far.i).toFixed(3)}`);

  for (let i = 0; i < 150; i++) sim.tick();
  ok('citywide coverage rose', sim.stats.coverage > coverBefore,
     `${sim.stats.coverage.toFixed(4)} vs ${coverBefore.toFixed(4)}`);
  ok('services are counted', sim.stats.services === 1 && sim.stats.byService.education === 1,
     JSON.stringify(sim.stats.byService));

  // ⚠️ rezoning a school must STOP it being a school, or coverage haunts the
  // map with nothing standing there to provide it
  const coverWithSchool = sim.serviceScoreAt(nearby);
  sim.execCommand({ t: 'rezone', ids: [mid], zone: 'residential' });
  for (let i = 0; i < 40; i++) sim.tick();
  ok('rezoning clears the service', sim.service[mid] === 0);
  ok('its coverage goes with it', sim.serviceScoreAt(nearby) < coverWithSchool,
     `${sim.serviceScoreAt(nearby).toFixed(3)} vs ${coverWithSchool.toFixed(3)}`);

  // and so must demolishing
  sim.execCommand({ t: 'service', ids: [mid], kind: 'health' });
  ok('it can become a clinic', sim.service[mid] === SERVICE_INDEX.health);
  sim.execCommand({ t: 'demolish', ids: [mid] });
  ok('demolishing clears the service', sim.service[mid] === 0);

  ok('an unknown service is rejected',
     sim.execCommand({ t: 'service', ids: [0], kind: 'wizardry' }).ok === false);
  ok('an empty selection is rejected',
     sim.execCommand({ t: 'service', ids: [], kind: 'education' }).ok === false);
  ok('setting it back to none works',
     sim.execCommand({ t: 'service', ids: [1], kind: 'education' }).ok &&
     sim.execCommand({ t: 'service', ids: [1], kind: 'none' }).ok &&
     sim.service[1] === 0);
}

// services must be deterministic, saved and hashed
{
  const mk = () => {
    const w = gridTown({ span: 8, block: 150 });
    return new Sim(w, new RoadGraph(w), { seed: 52 });
  };
  const a = mk(), b = mk();
  for (const s of [a, b]) {
    for (let i = 0; i < 50; i++) s.tick();
    s.execCommand({ t: 'service', ids: [4, 9, 14], kind: 'education' });
    s.execCommand({ t: 'service', ids: [20], kind: 'safety' });
    for (let i = 0; i < 60; i++) s.tick();
  }
  ok('services are deterministic', a.stateHash() === b.stateHash(),
     `${a.stateHash()} vs ${b.stateHash()}`);

  const plain = mk();
  for (let i = 0; i < 110; i++) plain.tick();
  ok('a service changes the hash', a.stateHash() !== plain.stateHash());

  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  const c = mk();
  c.restore(snap);
  ok('services survive a save', c.service[4] === SERVICE_INDEX.education
     && c.service[20] === SERVICE_INDEX.safety);
  ok('a city with services round-trips', c.stateHash() === a.stateHash(),
     `${c.stateHash()} vs ${a.stateHash()}`);
  // ⚠️ coverage is REBUILT on restore, not carried; if it were not, a loaded
  // city would keep the field while the schools were gone
  ok('restore rebuilt the coverage field',
     near(c.serviceScoreAt(5), a.serviceScoreAt(5), 1e-6),
     `${c.serviceScoreAt(5)} vs ${a.serviceScoreAt(5)}`);
  for (let i = 0; i < 40; i++) { a.tick(); c.tick(); }
  ok('a restored city with services stays in step', c.stateHash() === a.stateHash());
}

// ── transit ────────────────────────────────────────────────────────────────

// junction delay: the thing that makes cars realistic
{
  const w = gridTown({ span: 6, block: 120 });
  const g = new RoadGraph(w);
  // a grid has real 4-way junctions, so free-flow time must exceed pure driving
  let withDelay = 0, pureDrive = 0;
  for (let e = 0; e < g.edgeCount; e++) {
    withDelay += g.freeTime[e];
    pureDrive += g.elen[e] / (g.espeed[e] * 1000 / 60);
  }
  ok('junctions cost time', withDelay > pureDrive * 1.05,
     `${withDelay.toFixed(1)} vs ${pureDrive.toFixed(1)} min`);
  ok('a motorway pays no junction delay', JUNCTION_DELAY.highway === 0);
}

// laying and lifting a line
{
  const w = gridTown({ span: 6, block: 120 });
  const sim = new Sim(w, new RoadGraph(w), { seed: 15 });
  const g = sim.graph;
  const baseEdges = g.baseEdgeCount;

  ok('a fresh city has no transit', sim.transit.length === 0 && g.edgeCount === baseEdges);

  const stops = [[-300, -300], [-150, -150], [0, 0], [150, 150], [300, 300]];
  const r = sim.execCommand({ t: 'transit', op: 'add', kind: 'metro', stops });
  ok('a line can be laid', r.ok && r.stops === 5, JSON.stringify(r));
  ok('the graph grew', g.edgeCount > baseEdges, `${baseEdges} -> ${g.edgeCount}`);
  ok('road edge indices are unchanged', g.baseEdgeCount === baseEdges);
  ok('every new edge is flagged transit',
     Array.from(g.isTransit.subarray(baseEdges)).every(v => v === 1));
  ok('road edges are NOT flagged transit',
     !Array.from(g.isTransit.subarray(0, baseEdges)).some(v => v === 1));

  // ⚠️ THE BUG THIS GUARDS: transit edges carry eroad === -1, and _applyRoads
  // indexed roadState[-1] -> undefined -> "not 0" -> every transit edge marked
  // CLOSED, with capMul NaN. The lines existed, were shaped correctly, and were
  // simply unreachable. Nothing reported an error.
  ok('transit edges are not blocked', (() => {
    for (let e = baseEdges; e < g.edgeCount; e++) if (g._shut[e]) return false;
    return true;
  })(), 'transit was silently closed by the road pass');
  ok('transit capacity is a real number', (() => {
    for (let e = baseEdges; e < g.edgeCount; e++) {
      if (!Number.isFinite(g.capMul[e]) || !Number.isFinite(g.capacityOf(e))) return false;
    }
    return true;
  })(), 'capMul went NaN for transit edges');

  // platforms must actually be reachable from the street
  const street = g.nearestNode(-300, -300);
  const plat = g.stopNodes[0][0];
  const dist = g.dijkstra(street);
  ok('a platform is reachable from the street', Number.isFinite(dist[plat]),
     String(dist[plat]));
  ok('boarding costs the access time',
     near(dist[plat], TRANSIT.kinds.metro.accessMin, 1e-3), String(dist[plat]));

  // riding the line must beat walking the graph between distant stops
  const farPlat = g.stopNodes[0][4];
  ok('the line is faster than not having it', dist[farPlat] < dist[plat] + 30,
     String(dist[farPlat]));

  const rm = sim.execCommand({ t: 'transit', op: 'remove', id: r.id });
  ok('a line can be lifted', rm.ok && sim.transit.length === 0);
  ok('the graph shrank back', g.edgeCount === baseEdges);

  ok('an unknown kind is rejected',
     sim.execCommand({ t: 'transit', op: 'add', kind: 'hovercraft', stops }).ok === false);
  ok('a one-stop line is rejected',
     sim.execCommand({ t: 'transit', op: 'add', kind: 'tram', stops: [[0, 0]] }).ok === false);
  ok('an unknown op is rejected',
     sim.execCommand({ t: 'transit', op: 'wat' }).ok === false);
  ok('removing a line that is not there is rejected',
     sim.execCommand({ t: 'transit', op: 'remove', id: 999 }).ok === false);
}

// ⚠️ laying a line must not undo street surgery or a flood
{
  const w = gridTown({ span: 6, block: 120 });
  const hh = new Float32Array(w.cols * w.rows);
  for (let j = 0; j < w.rows; j++) {
    for (let i = 0; i < w.cols; i++) hh[j * w.cols + i] = (i - w.cols / 2) * 0.6;
  }
  w.heights = hh; w.minH = hh[0]; w.maxH = hh[w.cols - 1];
  for (const b of w.buildings) { b.gm = w.heightAt(b.c[0], b.c[1]); b.gx = b.gm; }

  const sim = new Sim(w, new RoadGraph(w), { seed: 6 });
  const g = sim.graph;
  const closed = [...new Set(Array.from(g.eroad))].filter(r => r >= 0)[0];
  sim.execCommand({ t: 'road', ids: [closed], op: 'close' });
  sim.execCommand({ t: 'sea', level: 5 });

  const blockedBefore = Array.from(g.blockedPlayer).filter(Boolean).length;
  const floodedBefore = Array.from(g.blockedFlood).filter(Boolean).length;
  ok('the city starts with closures and a flood', blockedBefore > 0 && floodedBefore > 0);

  sim.execCommand({ t: 'transit', op: 'add', kind: 'tram',
                    stops: [[-300, -300], [0, 0], [300, 300]] });

  ok('laying a line keeps streets closed',
     Array.from(g.blockedPlayer).filter(Boolean).length === blockedBefore,
     `${Array.from(g.blockedPlayer).filter(Boolean).length} vs ${blockedBefore}`);
  ok('laying a line keeps the flood',
     Array.from(g.blockedFlood).filter(Boolean).length === floodedBefore,
     `${Array.from(g.blockedFlood).filter(Boolean).length} vs ${floodedBefore}`);
  ok('transit itself is not flooded', (() => {
    for (let e = g.baseEdgeCount; e < g.edgeCount; e++) if (g.blockedFlood[e]) return false;
    return true;
  })());
}

// mode share must EMERGE, not be declared
{
  // The town must be big enough for transit to WIN, which is the real
  // condition rather than a test convenience: across 1.2 km a metro (6.7 min)
  // barely ties a car (6.9 min) and picks up no riders at all. Across 2.4 km
  // the gap is decisive, which is exactly why real transit serves long trips.
  const mk = () => {
    const w = gridTown({ span: 12, block: 200 });
    const s = new Sim(w, new RoadGraph(w), { seed: 31 });
    for (let i = 0; i < 200; i++) s.tick();
    return s;
  };
  const carLoad = s => {
    let t = 0;
    for (let e = 0; e < s.graph.edgeCount; e++) if (!s.graph.isTransit[e]) t += s.graph.load[e];
    return t;
  };

  const a = mk();
  ok('nobody rides a city with no transit', a.stats.transitShare === 0);
  const carsBefore = carLoad(a);

  const stops = [];
  for (let k = 0; k <= 12; k++) stops.push([-1200 + k * 200, -1200 + k * 200]);
  a.execCommand({ t: 'transit', op: 'add', kind: 'metro', stops });
  for (let i = 0; i < 200; i++) a.tick();

  ok('a metro line attracts riders', a.stats.transitShare > 0,
     `${(a.stats.transitShare * 100).toFixed(2)}%`);
  // ⚠️ the rule that makes mode share emerge: a transit trip adds no car
  ok('riders come off the road', carLoad(a) < carsBefore,
     `${Math.round(carLoad(a))} vs ${Math.round(carsBefore)}`);
  ok('no car load is ever put on a transit edge', (() => {
    for (let e = 0; e < a.graph.edgeCount; e++) {
      if (a.graph.isTransit[e] && a.graph.load[e] > 1e-6) return false;
    }
    return true;
  })());
  ok('stats report the line', a.stats.transitLines === 1 && a.stats.transitKm > 0,
     JSON.stringify({ lines: a.stats.transitLines, km: a.stats.transitKm }));
}

// determinism, save and hash
{
  const mk = () => {
    const w = gridTown({ span: 6, block: 120 });
    return new Sim(w, new RoadGraph(w), { seed: 77 });
  };
  const stops = [[-300, -300], [-100, 0], [100, 100], [300, 300]];

  const a = mk(), b = mk();
  for (const s of [a, b]) {
    for (let i = 0; i < 40; i++) s.tick();
    s.execCommand({ t: 'transit', op: 'add', kind: 'tram', stops });
    for (let i = 0; i < 60; i++) s.tick();
  }
  ok('transit is deterministic', a.stateHash() === b.stateHash(),
     `${a.stateHash()} vs ${b.stateHash()}`);

  const noLine = mk();
  for (let i = 0; i < 100; i++) noLine.tick();
  ok('a line changes the hash', a.stateHash() !== noLine.stateHash());

  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  const c = mk();
  c.restore(snap);
  ok('transit survives a save', c.transit.length === 1 && c.transit[0].kind === 'tram');
  ok('a city with transit round-trips', c.stateHash() === a.stateHash(),
     `${c.stateHash()} vs ${a.stateHash()}`);
  ok('the restored graph has the line', c.graph.edgeCount === a.graph.edgeCount);
  for (let i = 0; i < 40; i++) { a.tick(); c.tick(); }
  ok('a restored city with transit stays in step', c.stateHash() === a.stateHash());
}

// ── share codes ────────────────────────────────────────────────────────────

// base64url must survive every byte, including the ones that need escaping
{
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;
  const round = fromBase64Url(toBase64Url(bytes));
  ok('base64url round-trips all 256 byte values',
     round.length === 256 && Array.from(round).every((v, i) => v === i));
  ok('base64url is URL-safe', !/[+/=]/.test(toBase64Url(bytes)));
}

// the binary payload
{
  const w = gridTown();
  const log = new CommandLog();
  const empty = decodeBytes(encodeBytes(w, 0, log));
  ok('an untouched city encodes cleanly',
     empty.world === 'grid' && empty.entries.length === 0 && empty.finalDay === 0);

  log.record(10, { t: 'rezone', zone: 'industrial', ids: [0, 1, 5] });
  log.record(40, { t: 'road', op: 'remove', ids: [2, 3, 4] });
  log.record(55, { t: 'sea', level: -2.5 });
  log.record(70, { t: 'demolish', ids: [9] });

  const d = decodeBytes(encodeBytes(w, 90, log));
  ok('finalDay survives', d.finalDay === 90);
  ok('every entry survives', d.entries.length === 4, String(d.entries.length));
  ok('day stamps survive', d.entries.map(e => e.day).join() === '10,40,55,70',
     d.entries.map(e => e.day).join());
  ok('a rezone survives', d.entries[0].cmd.t === 'rezone'
     && d.entries[0].cmd.zone === 'industrial'
     && d.entries[0].cmd.ids.join() === '0,1,5');
  ok('a road op survives', d.entries[1].cmd.t === 'road' && d.entries[1].cmd.op === 'remove');
  ok('a NEGATIVE sea level survives', near(d.entries[2].cmd.level, -2.5, 1e-9),
     String(d.entries[2].cmd.level));
  ok('demolish becomes a rezone to none',
     d.entries[3].cmd.t === 'rezone' && d.entries[3].cmd.zone === 'none');

  // entries past finalDay are dropped rather than carried
  const trimmed = decodeBytes(encodeBytes(w, 45, log));
  ok('entries after finalDay are dropped', trimmed.entries.length === 2,
     String(trimmed.entries.length));

  // corrupt codes must be refused, not silently misread
  ok('a bad magic is refused', (() => {
    try { decodeBytes(new Uint8Array([1, 2, 3, 4])); return false; } catch { return true; }
  })());
  ok('a truncated code is refused', (() => {
    const b = encodeBytes(w, 90, log);
    try { decodeBytes(b.subarray(0, 6)); return false; } catch { return true; }
  })());
  ok('a future version is refused', (() => {
    const b = encodeBytes(w, 90, log);
    b[2] = 99;
    try { decodeBytes(b); return false; } catch { return true; }
  })());
  ok('an unknown opcode is refused', (() => {
    const b = Array.from(encodeBytes(w, 90, log));
    // first entry opcode sits right after the day delta
    const i = b.findIndex((v, k) => k > 8 && v === 1);
    if (i < 0) return true;
    b[i] = 77;
    try { decodeBytes(Uint8Array.from(b)); return false; } catch { return true; }
  })());
}

// ⚠️⚠️ THE CONTRACT: a shared city must BE the city that was shared — including
// WHEN each edit happened. The first version encoded only the final state and
// replayed it from day 0; the result was within 0.01% and still wrong.
{
  const mk = () => { const w = gridTown(); return new Sim(w, new RoadGraph(w), { seed: 7 }); };

  const author = mk();
  const log = new CommandLog();
  const issue = cmd => { const r = author.execCommand(cmd); if (r.ok) log.record(author.day, cmd); return r; };

  const distinct = [...new Set(Array.from(author.graph.eroad))];
  for (let i = 0; i < 60; i++) author.tick();
  issue({ t: 'rezone', ids: [0, 1, 5, 9], zone: 'industrial' });
  for (let i = 0; i < 45; i++) author.tick();
  issue({ t: 'road', ids: [distinct[0], distinct[1]], op: 'remove' });
  issue({ t: 'sea', level: 1.5 });
  for (let i = 0; i < 70; i++) author.tick();
  issue({ t: 'rezone', ids: [2, 3], zone: 'civic' });
  for (let i = 0; i < 30; i++) author.tick();

  const share = decodeBytes(encodeBytes(author.world, author.day, log));
  const guest = mk();
  const res = applyShare(guest, share);

  ok('every command replayed', res.skipped === 0, JSON.stringify(res));
  ok('the guest reached the same day', res.daysReplayed === author.day,
     `${res.daysReplayed} vs ${author.day}`);
  ok('a shared city IS the shared city', guest.stateHash() === author.stateHash(),
     `${guest.stateHash()} vs ${author.stateHash()}`);

  for (let i = 0; i < 40; i++) { author.tick(); guest.tick(); }
  ok('a shared city stays in step', guest.stateHash() === author.stateHash());

  // and the same edits applied at the WRONG time must NOT match — otherwise the
  // test above would pass even with the bug it exists to catch
  const authorAtShare = guest.stateHash();   // both already advanced 40 more days
  const naive = mk();
  for (const e of share.entries) naive.execCommand(e.cmd);   // ALL at day 0
  while (naive.day < author.day) naive.tick();
  ok('replaying edits at the wrong time gives a DIFFERENT city',
     naive.stateHash() !== authorAtShare,
     'day stamps are what make a share exact — if this passes trivially the test is dead');
}

// a hostile or stale code must not crash the game
{
  const w = gridTown();
  const sim = new Sim(w, new RoadGraph(w), { seed: 3 });
  const evil = {
    world: 'grid', finalDay: 5,
    entries: [
      { day: 1, cmd: { t: 'rezone', zone: 'industrial', ids: [-5, 999999] } },
      { day: 2, cmd: { t: 'road', op: 'close', ids: [999999] } },
      { day: 3, cmd: { t: 'sea', level: 2 } },
    ],
  };
  let threw = false, res;
  try { res = applyShare(sim, evil); } catch { threw = true; }
  ok('a malformed share does not throw', !threw);
  ok('out-of-range commands are rejected by the sim', res && res.skipped >= 2,
     JSON.stringify(res));

  const huge = { world: 'grid', finalDay: 99999999, entries: [] };
  const r2 = applyShare(new Sim(gridTown(), new RoadGraph(gridTown()), { seed: 3 }), huge);
  ok('an absurd day count is capped',
     r2.daysReplayed === MAX_REPLAY_DAYS && r2.dayCapped, JSON.stringify(r2));

  ok('the log refuses to grow without bound', (() => {
    const l = new CommandLog();
    for (let i = 0; i < MAX_ENTRIES + 50; i++) l.record(i, { t: 'sea', level: 0 });
    return l.length === MAX_ENTRIES;
  })());
}

// the whole point: a big city fits in a link
{
  const w = gridTown({ span: 6, block: 120 });
  const log = new CommandLog();
  log.record(100, { t: 'road', op: 'remove', ids: w.roads.map((_, i) => i) });
  const bytes = encodeBytes(w, 200, log);
  ok('tearing out every street stays small', bytes.length < 300,
     `${bytes.length} bytes for ${w.roads.length} streets`);
}

// ── palette: stable and in gamut ───────────────────────────────────────────
{
  ok('hash01 is in [0,1)', [0, 1, 500, 99999].every(i => {
    const v = hash01(i); return v >= 0 && v < 1;
  }));
  ok('hash01 is stable', hash01(42, 3) === hash01(42, 3));
  ok('hash01 varies with salt', hash01(42, 1) !== hash01(42, 2));
  ok('wallColour is stable per building',
     wallColour(7, 'residential', 10) === wallColour(7, 'residential', 10));
  ok('wallColour varies between buildings', new Set(
     [0, 1, 2, 3, 4, 5, 6, 7].map(i => wallColour(i, 'residential', 10))).size > 1);
  ok('tall buildings get a different family',
     wallColour(7, 'commercial', 60) !== wallColour(7, 'commercial', 8));
  ok('roofColour is in range', [0, 1, 2, 3].every(i => {
    const c = roofColour(i); return c >= 0 && c <= 0xffffff;
  }));
  ok('roofs differ from walls', roofColour(3) !== wallColour(3, 'residential', 10));
}

// ── report ─────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFAILURES:');
  for (const f of fails) console.log('  x ' + f);
  process.exit(1);
}
console.log('all green\n');
