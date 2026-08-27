// palette.js — how the city is coloured. Pure data + small helpers, no three.js.
//
// The goal is a STYLISED city that reads well from the air, not a photographic
// one. Two things carry most of that read, and both were missing at first:
//   • roofs are what you actually see from above, so they get their own dark,
//     varied palette instead of a tint of the wall colour;
//   • no two neighbouring buildings should share an exact colour, so every
//     building draws from a family by a STABLE hash of its index.

/** Stable hash -> [0,1). Same building always gets the same character. */
export function hash01(i, salt = 0) {
  let h = (i + 0x9e3779b9 + salt * 0x7f4a7c15) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Wall families, chosen to look like a real mixed streetscape rather than a
// colour wheel. Each entry is a small family the hash picks from.
export const WALLS = {
  residential: [0xd8cdba, 0xc9b9a2, 0xe0d8c8, 0xbfa891, 0xd6c2ae, 0xcbb6a0,
                0xc2a68f, 0xe3dccd, 0xb9a894, 0xd0bda6],
  commercial:  [0xc4c9ce, 0xb3bcc6, 0xd2d6da, 0xa8b4c0, 0xc8ccd2, 0xbcc3cb],
  industrial:  [0xb9b0a4, 0xa89c8c, 0xc4bdb0, 0x9e9384, 0xb2a696],
  civic:       [0xe4dccb, 0xdad0bd, 0xece5d6, 0xd2c7b2],
  minor:       [0xa89f94, 0x9b9288, 0xb3aa9e],
  other:       [0xcabfae, 0xbfb3a1, 0xd3c9b9, 0xb5a897, 0xc6bbaa, 0xd8cfc0],
};

// Glass for anything tall — downtown should not look like the neighbourhoods.
export const GLASS = [0xa9bfd2, 0x97b0c6, 0xb6c8d8, 0xa2b9cd, 0xaec2d4];

// Roofs: dark, desaturated, varied. This is the single biggest change in how
// the city reads from a normal camera angle.
export const ROOFS = [0x8a8379, 0x958d80, 0x7d766c, 0x9c9488, 0x877f74,
                      0x726b62, 0x928a7e, 0x9f978a, 0x6e6860, 0xa39a8c];

// A few buildings get a real roof colour — terracotta, copper, painted tin.
export const ROOF_ACCENTS = [0xb5744f, 0xa2634a, 0x7f9c88, 0xb09763];
export const ROOF_ACCENT_CHANCE = 0.10;

/** Height above which a building starts reading as glass-and-steel. */
export const GLASS_MIN_H = 30;
/** Share of tall buildings that read as glass; the rest are concrete/stone. */
export const GLASS_CHANCE = 0.55;
/** Light concrete and stone for the tall buildings that are NOT glass. */
export const TOWER_STONE = [0xc9c3b8, 0xd3cec3, 0xbdb7ac, 0xdad4c8, 0xc2bcb1];

/**
 * Wall colour for a building.
 * `i` is its index (stable), `kind` its land use, `h` its height in metres.
 */
export function wallColour(i, kind, h) {
  if (h >= GLASS_MIN_H && kind !== 'industrial') {
    return hash01(i, 13) < GLASS_CHANCE
      ? GLASS[Math.floor(hash01(i, 3) * GLASS.length) % GLASS.length]
      : TOWER_STONE[Math.floor(hash01(i, 17) * TOWER_STONE.length) % TOWER_STONE.length];
  }
  const fam = WALLS[kind] || WALLS.other;
  return fam[Math.floor(hash01(i, 1) * fam.length) % fam.length];
}

export function roofColour(i) {
  if (hash01(i, 7) < ROOF_ACCENT_CHANCE) {
    return ROOF_ACCENTS[Math.floor(hash01(i, 11) * ROOF_ACCENTS.length) % ROOF_ACCENTS.length];
  }
  return ROOFS[Math.floor(hash01(i, 5) * ROOFS.length) % ROOFS.length];
}

// ─── ground ─────────────────────────────────────────────────────────────────

export const GROUND = {
  // low, lush -> high, dry
  lowGreen:  [0.33, 0.41, 0.26],
  highGreen: [0.42, 0.44, 0.31],
  rock:      [0.47, 0.45, 0.41],
  wet:       [0.24, 0.38, 0.47],
};

export const SKY = {
  top:     0x4d86c4,
  horizon: 0xd6e2ec,
  /**
   * ⚠️ The dome's BELOW-horizon colour. It used to be a flat grey (0x9aa3a8)
   * and that grey WAS the "empty space" past the edge of the map — with a
   * finite tile floating in it, the dome underneath is simply what you saw.
   * The surround now covers it, but it is matched to the fog anyway so that if
   * a sliver ever shows it is indistinguishable from haze rather than a void.
   */
  ground:  0xc2d2e0,
  fog:     0xc6d5e2,
};

export const SUN = {
  colour: 0xfff0d4,
  intensity: 2.6,
  /** elevation/azimuth in radians — low enough to throw readable shadows */
  elevation: 0.82,
  azimuth: -0.85,
};

/** Sunless fill from behind, so shaded faces read as shadow, not as void. */
export const FILL = {
  colour: 0xbcd0e4,
  intensity: 0.55,
};

export const AMBIENT = {
  sky: 0xa8c6e8,
  ground: 0x6b5f4e,
  intensity: 0.72,
};

// ─── trees ──────────────────────────────────────────────────────────────────

export const FOLIAGE = [0x4e7a3e, 0x5a874a, 0x456e37, 0x648f52, 0x3f6a33, 0x6f9a5c];
export const TRUNK = 0x5c4632;
/** One tree per this many m² of green area. */
export const TREE_DENSITY = 110;
