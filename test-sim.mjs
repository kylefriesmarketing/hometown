// test-sim.mjs — headless checks for M2: the street graph, the scalar fields
// and the simulation. `node test-sim.mjs`
//
// ⚠️ RUN THIS AFTER EVERY SIM CHANGE. The determinism and save-round-trip
// blocks are the contract the whole design rests on: if they go red, replays
// and any future networked play are already broken even if the game "works".

import { World } from './world.js';
import { RoadGraph } from './graph.js';
import { Sim } from './sim.js';
import { chamfer, chamferFrom, sampleField, stampPolyline } from './field.js';
import { ZONE_INDEX } from './data.js';
import { wallColour, roofColour, hash01 } from './palette.js';

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
