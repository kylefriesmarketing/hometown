// OSM tags -> game features. Bake-time only; the runtime never sees an OSM tag.
//
// This file is where "a pile of triangles" becomes "a town you can play". The
// whole reason we chose OSM over photogrammetry is that these tags carry
// MEANING — so the job here is to preserve as much of it as the game can use,
// and to be honest (via `guessed`) about what we had to invent.

const M_PER_LEVEL = 3.2;   // storey height incl. floor slab; OSM's own rule of thumb
const ROOF_M = 1.2;        // parapet/roof above the top slab

// ─── buildings ──────────────────────────────────────────────────────────────

const RESIDENTIAL = new Set(['house', 'apartments', 'residential', 'detached', 'terrace',
  'semidetached_house', 'bungalow', 'dormitory', 'cabin', 'hut', 'houseboat', 'static_caravan',
  'farm', 'allotment_house']);
const COMMERCIAL = new Set(['commercial', 'retail', 'office', 'supermarket', 'shop', 'kiosk',
  'hotel', 'restaurant', 'bar', 'pub', 'mall', 'department_store']);
const INDUSTRIAL = new Set(['industrial', 'warehouse', 'factory', 'manufacture', 'hangar',
  'silo', 'storage_tank', 'works', 'digester']);
const CIVIC = new Set(['school', 'university', 'college', 'kindergarten', 'hospital', 'clinic',
  'church', 'cathedral', 'chapel', 'mosque', 'synagogue', 'temple', 'shrine', 'monastery',
  'civic', 'government', 'public', 'fire_station', 'police', 'train_station', 'transportation',
  'museum', 'library', 'sports_hall', 'stadium', 'grandstand', 'toilets']);
const MINOR = new Set(['shed', 'garage', 'garages', 'carport', 'roof', 'service', 'hut',
  'container', 'greenhouse', 'bunker', 'ruins', 'construction']);

// Fallback heights (metres) when OSM tells us nothing at all.
const DEFAULT_H = { residential: 7.0, commercial: 9.5, industrial: 9.0, civic: 11.0, minor: 3.0, other: 7.0 };

/** Classify a building's tags into one of our zone kinds. */
export function buildingKind(tags) {
  const b = tags.building;
  // A more specific tag beats a generic building=yes.
  const probe = [b, tags['building:use'], tags.amenity, tags.shop && 'shop',
    tags.office && 'office', tags.tourism === 'hotel' && 'hotel'].filter(Boolean);
  for (const v of probe) {
    if (RESIDENTIAL.has(v)) return 'residential';
    if (COMMERCIAL.has(v)) return 'commercial';
    if (INDUSTRIAL.has(v)) return 'industrial';
    if (CIVIC.has(v)) return 'civic';
    if (MINOR.has(v)) return 'minor';
  }
  if (tags.shop || tags.office) return 'commercial';
  if (tags.amenity) return 'civic';
  return 'other';
}

/** Parse an OSM height-ish string into metres. Handles "12", "12 m", "40'", "40 ft". */
export function parseLength(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  let m = s.match(/^([\d.]+)\s*(m|metre|meter|metres|meters)?$/);
  if (m) { const n = parseFloat(m[1]); return Number.isFinite(n) ? n : null; }
  m = s.match(/^([\d.]+)\s*(ft|feet|foot|')$/);
  if (m) { const n = parseFloat(m[1]); return Number.isFinite(n) ? n * 0.3048 : null; }
  // "12'6\"" — feet and inches
  m = s.match(/^(\d+)\s*'\s*(\d+(?:\.\d+)?)\s*"?$/);
  if (m) return (parseInt(m[1], 10) * 12 + parseFloat(m[2])) * 0.0254;
  return null;
}

/**
 * Best available height for a building, plus how we got it.
 * `guessed` is true when the number is our invention rather than OSM's data —
 * the renderer dims invented heights so the player can see what's real.
 */
export function buildingHeight(tags, kind) {
  const h = parseLength(tags.height) ?? parseLength(tags['building:height']);
  if (h != null && h > 0) return { height: h, levels: Math.max(1, Math.round(h / M_PER_LEVEL)), guessed: false, src: 'height' };

  const lv = parseFloat(tags['building:levels'] ?? tags.levels);
  if (Number.isFinite(lv) && lv > 0) {
    return { height: lv * M_PER_LEVEL + ROOF_M, levels: Math.round(lv), guessed: false, src: 'levels' };
  }

  const d = DEFAULT_H[kind] ?? DEFAULT_H.other;
  return { height: d, levels: Math.max(1, Math.round(d / M_PER_LEVEL)), guessed: true, src: 'default' };
}

/** Height of the building's base above ground (podiums, buildings on plinths). */
export function buildingMinHeight(tags) {
  const mh = parseLength(tags.min_height);
  if (mh != null) return mh;
  const ml = parseFloat(tags['building:min_level']);
  return Number.isFinite(ml) && ml > 0 ? ml * M_PER_LEVEL : 0;
}

// ─── roads ──────────────────────────────────────────────────────────────────

// width = full carriageway in metres; rank orders drawing (higher paints on top)
export const ROAD_CLASS = {
  motorway:      { width: 24, rank: 9, speed: 110, kind: 'highway' },
  motorway_link: { width: 10, rank: 8, speed: 60,  kind: 'highway' },
  trunk:         { width: 18, rank: 8, speed: 90,  kind: 'highway' },
  trunk_link:    { width: 9,  rank: 7, speed: 50,  kind: 'highway' },
  primary:       { width: 14, rank: 7, speed: 60,  kind: 'arterial' },
  primary_link:  { width: 8,  rank: 6, speed: 40,  kind: 'arterial' },
  secondary:     { width: 12, rank: 6, speed: 50,  kind: 'arterial' },
  secondary_link:{ width: 8,  rank: 5, speed: 40,  kind: 'arterial' },
  tertiary:      { width: 10, rank: 5, speed: 40,  kind: 'arterial' },
  tertiary_link: { width: 7,  rank: 4, speed: 30,  kind: 'arterial' },
  unclassified:  { width: 7,  rank: 4, speed: 40,  kind: 'street' },
  residential:   { width: 8,  rank: 4, speed: 30,  kind: 'street' },
  living_street: { width: 7,  rank: 3, speed: 20,  kind: 'street' },
  service:       { width: 5,  rank: 2, speed: 20,  kind: 'service' },
  track:         { width: 3.5,rank: 1, speed: 20,  kind: 'service' },
  pedestrian:    { width: 5,  rank: 3, speed: 5,   kind: 'foot' },
  footway:       { width: 2.5,rank: 1, speed: 5,   kind: 'foot' },
  path:          { width: 2,  rank: 1, speed: 5,   kind: 'foot' },
  steps:         { width: 2,  rank: 1, speed: 3,   kind: 'foot' },
  cycleway:      { width: 2.5,rank: 2, speed: 18,  kind: 'foot' },
  bridleway:     { width: 2,  rank: 1, speed: 8,   kind: 'foot' },
};

export function roadInfo(tags) {
  const c = ROAD_CLASS[tags.highway];
  if (!c) return null;
  // An explicit width tag always beats our per-class default.
  const tagged = parseLength(tags.width);
  const lanes = parseFloat(tags.lanes);
  let width = tagged ?? (Number.isFinite(lanes) && lanes > 0 ? Math.max(c.width, lanes * 3.4) : c.width);
  return {
    cls: tags.highway,
    kind: c.kind,
    width,
    rank: c.rank,
    speed: c.speed,
    oneway: tags.oneway === 'yes' || tags.oneway === '1' || tags.oneway === '-1',
    bridge: !!tags.bridge && tags.bridge !== 'no',
    tunnel: !!tags.tunnel && tags.tunnel !== 'no',
    layer: parseInt(tags.layer ?? '0', 10) || 0,
    name: tags.name || null,
  };
}

// ─── areas (water / green / other landuse) ──────────────────────────────────

/**
 * Classify an area way into a surface the game paints and reasons about.
 * Returns null for areas we don't care about.
 */
export function areaKind(tags) {
  if (tags.natural === 'water' || tags.landuse === 'reservoir' || tags.landuse === 'basin'
      || tags.waterway === 'riverbank' || tags.natural === 'wetland') return 'water';
  if (tags.leisure === 'park' || tags.leisure === 'garden' || tags.leisure === 'common'
      || tags.landuse === 'grass' || tags.landuse === 'village_green'
      || tags.landuse === 'recreation_ground' || tags.landuse === 'meadow') return 'park';
  if (tags.natural === 'wood' || tags.landuse === 'forest') return 'wood';
  if (tags.landuse === 'cemetery' || tags.amenity === 'grave_yard') return 'cemetery';
  if (tags.leisure === 'pitch' || tags.leisure === 'sports_centre'
      || tags.leisure === 'playground' || tags.leisure === 'golf_course') return 'sport';
  if (tags.amenity === 'parking' || tags.landuse === 'garages') return 'parking';
  if (tags.natural === 'sand' || tags.natural === 'beach') return 'sand';
  if (tags.natural === 'bare_rock' || tags.natural === 'scree') return 'rock';
  if (tags.landuse === 'farmland' || tags.landuse === 'orchard'
      || tags.landuse === 'vineyard' || tags.landuse === 'allotments') return 'farm';
  if (tags.landuse === 'industrial' || tags.landuse === 'quarry') return 'industrial';
  if (tags.landuse === 'commercial' || tags.landuse === 'retail') return 'commercial';
  if (tags.landuse === 'residential') return 'residential';
  return null;
}

/** Linear water (rivers, streams) that are drawn as ribbons, not polygons. */
export function waterwayInfo(tags) {
  const w = tags.waterway;
  if (!w) return null;
  const widths = { river: 18, canal: 12, stream: 4, ditch: 2, drain: 2 };
  if (!(w in widths)) return null;
  return { cls: w, width: parseLength(tags.width) ?? widths[w], name: tags.name || null };
}

/** Point features worth keeping as landmarks / services. */
export function poiKind(tags) {
  const a = tags.amenity, s = tags.shop, t = tags.tourism, l = tags.leisure;
  if (a === 'school' || a === 'college' || a === 'university' || a === 'kindergarten') return 'education';
  if (a === 'hospital' || a === 'clinic' || a === 'doctors' || a === 'pharmacy') return 'health';
  if (a === 'fire_station') return 'fire';
  if (a === 'police') return 'police';
  if (a === 'place_of_worship') return 'worship';
  if (a === 'restaurant' || a === 'cafe' || a === 'fast_food' || a === 'bar' || a === 'pub') return 'food';
  if (a === 'bank' || a === 'atm') return 'money';
  if (a === 'fuel' || a === 'charging_station') return 'fuel';
  if (a === 'townhall' || a === 'courthouse' || a === 'post_office') return 'civic';
  if (s) return 'shop';
  if (t === 'hotel' || t === 'motel' || t === 'hostel') return 'lodging';
  if (t === 'museum' || t === 'attraction' || t === 'viewpoint') return 'attraction';
  if (l === 'park' || l === 'playground') return 'park';
  return null;
}
