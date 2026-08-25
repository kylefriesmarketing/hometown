#!/usr/bin/env node
// bake.mjs — turn a real place into a playable world file.
//
//   node tools/bake.mjs --place "Asheville, North Carolina" --radius 1200 --name asheville
//   node tools/bake.mjs --center 37.8005,-122.4130 --radius 1000 --name russian-hill
//   node tools/bake.mjs --bbox 37.795,-122.420,37.805,-122.405 --name sf-north
//
// Sources, both free and key-less:
//   • OpenStreetMap via Overpass API      (ODbL — attribution required, see world.meta)
//   • AWS Terrain Tiles (terrarium PNG)   (SRTM/Copernicus derived, public domain-ish)
//
// ⚠️ Overpass is genuinely flaky — 500/502/504 are routine and mean "try again",
//    not "your query is wrong". That is the entire reason this bakes to a file
//    instead of the game fetching live.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, terrariumToMetres } from './png.mjs';
import { buildingKind, buildingHeight, buildingMinHeight, roadInfo, areaKind, waterwayInfo, poiKind } from './osm.js';
import { makeProjection, metresPerDegree, lonLatToTile, tileResolution, ringArea, ringCentroid } from '../geo.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
// Overpass and Nominatim both require a real User-Agent identifying the client
// (a missing one is answered with 406). Point it at the repo rather than a
// personal address — same purpose, and nothing personal ends up in a public bake.
const UA = 'hometown-citybuilder/0.1 (+https://github.com/kylefriesmarketing/hometown)';

// ⚠️ GLOBAL instances only. Regional mirrors (overpass.osm.ch is Switzerland-only)
//    answer 200 OK with ZERO elements for anywhere outside their region — which
//    bakes a silently empty world. That cost a debugging round; see the
//    zero-element guard in fetchOsm, which is the real defence.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const round = (v, d = 1) => { const f = 10 ** d; return Math.round(v * f) / f; };

/** Nominatim labels run very long ("Russian Hill, San Francisco, California,
 *  94109, United States") — keep the first few parts for the world picker. */
const shortLabel = s => !s ? '' : s.split(',').map(x => x.trim()).slice(0, 3).join(', ');

// ─── args ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true';
    a[k] = v;
  }
  return a;
}

/** Square bbox of side 2*radius metres around a lat/lon. */
function bboxAround(lat, lon, radiusM) {
  const m = metresPerDegree(lat);
  return {
    s: lat - radiusM / m.lat, n: lat + radiusM / m.lat,
    w: lon - radiusM / m.lon, e: lon + radiusM / m.lon,
  };
}

async function geocode(place) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(place)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Nominatim ${r.status}`);
  const j = await r.json();
  if (!j.length) throw new Error(`no such place: "${place}"`);
  return { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon), label: j[0].display_name };
}

// ─── overpass ───────────────────────────────────────────────────────────────

function overpassQuery(b) {
  const B = `${b.s},${b.w},${b.n},${b.e}`;
  return `[out:json][timeout:180];
(
  way["building"](${B});
  relation["building"]["type"="multipolygon"](${B});
  way["highway"](${B});
  way["waterway"](${B});
  way["railway"~"^(rail|light_rail|subway|tram|narrow_gauge)$"](${B});
  way["natural"](${B});
  way["landuse"](${B});
  way["leisure"](${B});
  way["amenity"](${B});
  node["amenity"](${B});
  node["shop"](${B});
  node["tourism"](${B});
);
out body geom;`;
}

async function fetchOsm(bbox, log) {
  const q = overpassQuery(bbox);
  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const url = OVERPASS[(attempt - 1) % OVERPASS.length];
    const host = new URL(url).host;
    try {
      const t0 = Date.now();
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: 'data=' + encodeURIComponent(q),
      });
      if (r.ok) {
        const j = await r.json();
        const n = (j.elements || []).length;
        // A populated bbox that comes back empty means we hit a mirror that does
        // not hold this region — NOT that the place is empty. Treat it as a
        // failure and move on, or we bake a ghost town and never know why.
        if (n === 0) {
          log(`  overpass returned 0 elements from ${host} — wrong-region mirror? retrying elsewhere`);
        } else {
          log(`  overpass ok via ${host} in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${n} elements`);
          return j.elements;
        }
      } else {
        log(`  overpass ${r.status} from ${host} (attempt ${attempt}/${maxAttempts})`);
      }
    } catch (e) {
      log(`  overpass ${e.message} from ${host} (attempt ${attempt}/${maxAttempts})`);
    }
    await sleep(Math.min(1500 * attempt, 8000));
  }
  throw new Error('Overpass unreachable after ' + maxAttempts + ' attempts — try again in a minute');
}

// ─── terrain ────────────────────────────────────────────────────────────────

async function fetchTile(z, x, y, log) {
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.ok) return terrariumToMetres(decodePng(Buffer.from(await r.arrayBuffer())));
      if (r.status === 404) { log(`  tile ${z}/${x}/${y} missing — treating as sea level`); return null; }
    } catch { /* retry */ }
    await sleep(400 * attempt);
  }
  log(`  tile ${z}/${x}/${y} FAILED after 5 tries — treating as sea level`);
  return null;
}

/** Fetch every terrarium tile covering bbox and return a bilinear sampler over lat/lon. */
async function buildElevationSampler(bbox, zoom, log) {
  const nw = lonLatToTile(bbox.n, bbox.w, zoom);
  const se = lonLatToTile(bbox.s, bbox.e, zoom);
  const x0 = Math.floor(nw.x), x1 = Math.floor(se.x);
  const y0 = Math.floor(nw.y), y1 = Math.floor(se.y);
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push({ x, y });
  log(`  terrain: ${jobs.length} tile(s) at z${zoom} (~${tileResolution((bbox.s + bbox.n) / 2, zoom).toFixed(1)} m/px)`);

  const tiles = new Map();
  const LIMIT = 6;
  for (let i = 0; i < jobs.length; i += LIMIT) {
    const slice = jobs.slice(i, i + LIMIT);
    const got = await Promise.all(slice.map(j => fetchTile(zoom, j.x, j.y, log)));
    slice.forEach((j, k) => tiles.set(`${j.x}/${j.y}`, got[k]));
  }

  const TS = 256;
  const px = (tx, ty) => {   // single-pixel read, clamped, missing tile = 0 m
    const t = tiles.get(`${Math.floor(tx / TS)}/${Math.floor(ty / TS)}`);
    if (!t) return 0;
    const ix = ((tx % TS) + TS) % TS, iy = ((ty % TS) + TS) % TS;
    return t[iy * TS + ix];
  };

  return function sample(lat, lon) {
    const t = lonLatToTile(lat, lon, zoom);
    const fx = t.x * TS, fy = t.y * TS;          // global pixel space at this zoom
    const x = Math.floor(fx), y = Math.floor(fy);
    const dx = fx - x, dy = fy - y;
    const a = px(x, y), b = px(x + 1, y), c = px(x, y + 1), d = px(x + 1, y + 1);
    return a * (1 - dx) * (1 - dy) + b * dx * (1 - dy) + c * (1 - dx) * dy + d * dx * dy;
  };
}

// ─── assembly ───────────────────────────────────────────────────────────────

function ringToLocal(geometry, proj) {
  const pts = [];
  for (const g of geometry) {
    if (!g) continue;                       // Overpass emits nulls for clipped nodes
    const p = proj.toLocal(g.lat, g.lon);
    pts.push(p);
  }
  // Drop the duplicated closing vertex — our rings are implicitly closed.
  if (pts.length > 2) {
    const f = pts[0], l = pts[pts.length - 1];
    if (Math.abs(f.x - l.x) < 0.01 && Math.abs(f.z - l.z) < 0.01) pts.pop();
  }
  return pts;
}

const flat = pts => pts.flatMap(p => [round(p.x), round(p.z)]);

/** Axis-aligned bounds of a flat [x,z,x,z,…] ring. */
function boundsOf(flatRing) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < flatRing.length; i += 2) {
    const x = flatRing[i], z = flatRing[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return { x0, x1, z0, z1 };
}

/** Ray-cast point-in-polygon against a flat [x,z,…] ring. */
function pointInRing(px, pz, r) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
    if ((zi > pz) !== (zj > pz) && px < (xj - xi) * (pz - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// A POI inside a building tells us what that building IS, when its own tags didn't.
const POI_TO_KIND = {
  education: 'civic', health: 'civic', fire: 'civic', police: 'civic', worship: 'civic',
  civic: 'civic', attraction: 'civic',
  food: 'commercial', money: 'commercial', shop: 'commercial', lodging: 'commercial', fuel: 'commercial',
};
const LANDUSE_TO_KIND = { residential: 'residential', commercial: 'commercial', industrial: 'industrial' };

/**
 * Fill in `kind` for buildings OSM only tagged `building=yes`.
 * Evidence order: a POI standing inside the footprint beats the landuse zone
 * the footprint sits in. Every building records `ks` (kind source) so the game
 * — and the player — can tell surveyed fact from inference.
 */
function enrichBuildingKinds(buildings, areas, pois, log) {
  const unknown = buildings.filter(b => b.kind === 'other');
  if (!unknown.length) return { poi: 0, landuse: 0 };

  const bounds = new Map(unknown.map(b => [b, boundsOf(b.ring)]));
  let byPoi = 0, byLanduse = 0;

  // 1. POIs inside a footprint
  for (const p of pois) {
    const k = POI_TO_KIND[p.k];
    if (!k) continue;
    for (const b of unknown) {
      if (b.kind !== 'other') continue;
      const bb = bounds.get(b);
      if (p.x < bb.x0 || p.x > bb.x1 || p.z < bb.z0 || p.z > bb.z1) continue;
      if (!pointInRing(p.x, p.z, b.ring)) continue;
      b.kind = k; b.ks = 'poi'; byPoi++;
      break;
    }
  }

  // 2. otherwise, the landuse polygon the centroid falls in
  const zones = areas.filter(a => LANDUSE_TO_KIND[a.k]).map(a => ({ a, bb: boundsOf(a.ring) }));
  for (const b of unknown) {
    if (b.kind !== 'other') continue;
    for (const { a, bb } of zones) {
      const [cx, cz] = b.c;
      if (cx < bb.x0 || cx > bb.x1 || cz < bb.z0 || cz > bb.z1) continue;
      if (!pointInRing(cx, cz, a.ring)) continue;
      b.kind = LANDUSE_TO_KIND[a.k]; b.ks = 'landuse'; byLanduse++;
      break;
    }
  }

  log(`  enriched ${byPoi} building(s) from POIs, ${byLanduse} from landuse zones ` +
      `(${buildings.filter(b => b.kind === 'other').length} still unknown)`);
  return { poi: byPoi, landuse: byLanduse };
}

let MIN_AREA = 8;

async function bake(opts) {
  const log = (...a) => console.log(...a);
  MIN_AREA = Number(opts.minArea || 8);

  // 1. resolve the area ------------------------------------------------------
  let bbox, label = opts.name;
  if (opts.bbox) {
    const [s, w, n, e] = opts.bbox.split(',').map(Number);
    bbox = { s, w, n, e };
  } else if (opts.center) {
    const [lat, lon] = opts.center.split(',').map(Number);
    bbox = bboxAround(lat, lon, Number(opts.radius || 1000));
  } else if (opts.place) {
    log(`geocoding "${opts.place}"…`);
    const g = await geocode(opts.place);
    label = g.label;
    log(`  -> ${g.lat.toFixed(5)}, ${g.lon.toFixed(5)}  (${g.label})`);
    bbox = bboxAround(g.lat, g.lon, Number(opts.radius || 1000));
  } else {
    throw new Error('need one of --bbox, --center or --place');
  }

  const proj = makeProjection(bbox);
  const name = opts.name || 'world';
  log(`\nbaking "${name}"  ${proj.width.toFixed(0)} × ${proj.depth.toFixed(0)} m` +
      `  @ ${proj.lat0.toFixed(5)}, ${proj.lon0.toFixed(5)}`);

  // 2. fetch both sources ----------------------------------------------------
  log('\nfetching OpenStreetMap…');
  const els = await fetchOsm(bbox, log);

  log('\nfetching elevation…');
  const zoom = Number(opts.zoom || 14);
  const sampleH = await buildElevationSampler(bbox, zoom, log);

  // 3. heightmap on a regular local grid -------------------------------------
  const cell = Number(opts.cell || 10);
  const cols = Math.ceil(proj.width / cell) + 1;
  const rows = Math.ceil(proj.depth / cell) + 1;
  const heights = new Array(cols * rows);
  let minH = Infinity, maxH = -Infinity;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = -proj.width / 2 + i * cell;
      const z = -proj.depth / 2 + j * cell;
      const g = proj.toGeo(x, z);
      const h = sampleH(g.lat, g.lon);
      heights[j * cols + i] = round(h, 1);
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }
  log(`  heightmap ${cols}×${rows} @ ${cell} m — elevation ${minH.toFixed(1)}…${maxH.toFixed(1)} m ` +
      `(${(maxH - minH).toFixed(0)} m of relief)`);

  // terrain height at an arbitrary local point, for baking building bases
  const heightAt = (x, z) => {
    const fi = (x + proj.width / 2) / cell, fj = (z + proj.depth / 2) / cell;
    const i = Math.max(0, Math.min(cols - 2, Math.floor(fi)));
    const j = Math.max(0, Math.min(rows - 2, Math.floor(fj)));
    const dx = Math.max(0, Math.min(1, fi - i)), dz = Math.max(0, Math.min(1, fj - j));
    const h00 = heights[j * cols + i], h10 = heights[j * cols + i + 1];
    const h01 = heights[(j + 1) * cols + i], h11 = heights[(j + 1) * cols + i + 1];
    return h00 * (1 - dx) * (1 - dz) + h10 * dx * (1 - dz) + h01 * (1 - dx) * dz + h11 * dx * dz;
  };

  // 4. classify every element ------------------------------------------------
  const buildings = [], roads = [], areas = [], waterways = [], rails = [], pois = [];
  const stat = { kinds: {}, roadClasses: {}, guessedHeights: 0, realHeights: 0, skippedRelations: 0 };

  const addBuilding = (tags, pts, id) => {
    if (pts.length < 3) return;
    const area = ringArea(pts);
    // A big-radius bake is dominated by sheds and garages, so --minArea lets a
    // flagship map shed the noise without losing the city.
    if (area < MIN_AREA) return;
    const kind = buildingKind(tags);
    const { height, levels, guessed } = buildingHeight(tags, kind);
    const c = ringCentroid(pts);
    // Ground under the footprint: MIN keeps a building on a slope planted rather
    // than floating; the renderer skirts down to groundMax - see README.
    let gMin = Infinity, gMax = -Infinity;
    for (const p of pts) { const h = heightAt(p.x, p.z); if (h < gMin) gMin = h; if (h > gMax) gMax = h; }
    buildings.push({
      id, kind, ks: kind === 'other' ? 'none' : 'tag',
      h: round(height), lv: levels, base: round(buildingMinHeight(tags)),
      g: guessed ? 1 : 0, gm: round(gMin), gx: round(gMax),
      a: round(area), c: [round(c.x), round(c.z)], ring: flat(pts),
      n: tags.name || undefined,
    });
    guessed ? stat.guessedHeights++ : stat.realHeights++;
  };

  for (const el of els) {
    const tags = el.tags || {};

    if (el.type === 'node') {
      const k = poiKind(tags);
      if (!k) continue;
      const p = proj.toLocal(el.lat, el.lon);
      pois.push({ k, x: round(p.x), z: round(p.z), n: tags.name || undefined });
      continue;
    }

    if (el.type === 'relation') {
      if (!tags.building) continue;
      const outers = (el.members || []).filter(m => m.role === 'outer' && m.geometry);
      if (!outers.length) { stat.skippedRelations++; continue; }
      // Holes are dropped on purpose (v1) — a courtyard renders solid. See README.
      for (const m of outers) addBuilding(tags, ringToLocal(m.geometry, proj), `r${el.id}`);
      continue;
    }

    if (!el.geometry) continue;
    const pts = ringToLocal(el.geometry, proj);
    if (pts.length < 2) continue;

    if (tags.building) { addBuilding(tags, pts, `w${el.id}`); continue; }

    const road = roadInfo(tags);
    if (road) {
      roads.push({ c: road.cls, k: road.kind, w: round(road.width), r: road.rank,
        o: road.oneway ? 1 : 0, b: road.bridge ? 1 : 0, t: road.tunnel ? 1 : 0,
        l: road.layer || undefined, n: road.name || undefined, pts: flat(pts) });
      stat.roadClasses[road.cls] = (stat.roadClasses[road.cls] || 0) + 1;
      continue;
    }

    if (tags.railway) { rails.push({ c: tags.railway, pts: flat(pts) }); continue; }

    const ww = waterwayInfo(tags);
    if (ww) { waterways.push({ c: ww.cls, w: round(ww.width), n: ww.name || undefined, pts: flat(pts) }); continue; }

    const ak = areaKind(tags);
    if (ak && pts.length >= 3 && ringArea(pts) >= 40) {
      areas.push({ k: ak, a: round(ringArea(pts)), ring: flat(pts), n: tags.name || undefined });
    }
  }

  // 4b. infer what the untagged buildings are, from the layers we already have
  log(`\ninferring land use…`);
  const enriched = enrichBuildingKinds(buildings, areas, pois, log);
  for (const b of buildings) stat.kinds[b.kind] = (stat.kinds[b.kind] || 0) + 1;
  stat.kindSource = buildings.reduce((m, b) => (m[b.ks] = (m[b.ks] || 0) + 1, m), {});

  // Big areas paint first so small ones (a pond inside a park) land on top.
  areas.sort((a, b) => b.a - a.a);
  roads.sort((a, b) => a.r - b.r);

  // 5. emit ------------------------------------------------------------------
  const world = {
    name, label,
    bbox,
    origin: { lat: round(proj.lat0, 7), lon: round(proj.lon0, 7) },
    size: { width: round(proj.width), depth: round(proj.depth) },
    terrain: { cols, rows, cell, minH: round(minH), maxH: round(maxH), heights },
    buildings, roads, areas, waterways, rails, pois,
    meta: {
      generated: new Date().toISOString(),
      zoom, cell,
      counts: {
        buildings: buildings.length, roads: roads.length, areas: areas.length,
        waterways: waterways.length, rails: rails.length, pois: pois.length,
      },
      buildingKinds: stat.kinds,
      kindSource: stat.kindSource,
      roadClasses: stat.roadClasses,
      heightSource: { fromOsm: stat.realHeights, guessed: stat.guessedHeights },
      skippedRelations: stat.skippedRelations,
      attribution: {
        osm: '© OpenStreetMap contributors (ODbL) — https://www.openstreetmap.org/copyright',
        elevation: 'AWS Terrain Tiles — SRTM / Copernicus DEM / NED, via registry.opendata.aws/terrain-tiles',
      },
    },
  };

  const out = path.join(ROOT, 'worlds', `${name}.json`);
  await fs.writeFile(out, JSON.stringify(world));
  const kb = (await fs.stat(out)).size / 1024;

  // Keep the world picker's manifest in step, so a fresh bake is playable with
  // no extra step. Re-baking a name updates its entry rather than duplicating.
  const manifestPath = path.join(ROOT, 'worlds', 'index.json');
  let manifest = [];
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch { /* first bake */ }
  manifest = manifest.filter(e => e.name !== name);
  manifest.push({
    name,
    label: shortLabel(label) || name,
    buildings: buildings.length,
    km2: round((proj.width * proj.depth) / 1e6, 2),
    relief: round(maxH - minH),
  });
  manifest.sort((a, b) => a.name.localeCompare(b.name));
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  log(`\n── ${name} ─────────────────────────────`);
  log(`  buildings  ${buildings.length}  (${JSON.stringify(stat.kinds)})`);
  log(`  land use   ${JSON.stringify(stat.kindSource)}`);
  log(`  heights    ${stat.realHeights} from OSM, ${stat.guessedHeights} guessed`);
  log(`  roads      ${roads.length}   areas ${areas.length}   water ${waterways.length}   rail ${rails.length}   POI ${pois.length}`);
  log(`  relief     ${(maxH - minH).toFixed(0)} m  (${minH.toFixed(0)} … ${maxH.toFixed(0)})`);
  log(`  written    worlds/${name}.json  (${kb.toFixed(0)} KB)`);
  return world;
}

const opts = parseArgs(process.argv.slice(2));
bake(opts).catch(e => { console.error('\nBAKE FAILED:', e.message); process.exit(1); });
