// data.js — ALL tuning lives here. Balance changes go in this file and nowhere
// else, so a design pass never has to read sim.js.
//
// Units are real: metres, minutes, km/h, people, jobs, and money per month.

// ─── the tick ───────────────────────────────────────────────────────────────

export const TICK = {
  daysPerTick: 1,
  ticksPerSecond: 6,        // at normal speed; a year passes in ~60 s
  daysPerMonth: 30,
  speeds: [0, 1, 3, 9],     // paused / normal / fast / very fast
};

// ─── roads ──────────────────────────────────────────────────────────────────

/** Free-flow speed in km/h by OSM highway class. */
export const ROAD_SPEED = {
  motorway: 100, motorway_link: 60, trunk: 80, trunk_link: 50,
  primary: 55, primary_link: 40, secondary: 50, secondary_link: 40,
  tertiary: 45, tertiary_link: 35,
  unclassified: 35, residential: 30, living_street: 15,
  service: 20, track: 20,
};

export const ROAD_LANES = { metresPerLane: 3.4 };

/** Vehicles per hour a single lane carries before it starts to break down. */
export const LANE_CAPACITY = 700;

/** Bureau of Public Roads volume-delay curve: t = t0 * (1 + a(v/c)^b). */
export const BPR = { alpha: 0.15, beta: 4 };

// ─── zoning ─────────────────────────────────────────────────────────────────

// Order is the wire format: `zone` is stored as an index into this array, so
// APPEND ONLY — inserting in the middle silently rewrites every saved city.
export const ZONE_KINDS = ['none', 'residential', 'commercial', 'industrial', 'civic'];
export const ZONE_INDEX = Object.fromEntries(ZONE_KINDS.map((k, i) => [k, i]));

export const ZONES = {
  none: {
    label: 'Vacant', icon: '·',
    areaPer: 0, taxPerOccupant: 0, colour: 0x8d8880,
  },
  residential: {
    label: 'Housing', icon: '🏠',
    areaPer: 45,              // m² of floor area per resident
    taxPerOccupant: 1.10,     // money / occupant / month
    colour: 0x6fae63,
    wants: 'jobs',            // residents need to reach work
  },
  commercial: {
    label: 'Commercial', icon: '🏪',
    areaPer: 30,              // m² per job
    taxPerOccupant: 1.65,
    colour: 0x4a90d9,
    wants: 'workers',
  },
  industrial: {
    label: 'Industrial', icon: '🏭',
    areaPer: 60,
    taxPerOccupant: 1.35,
    colour: 0xd0a13c,
    wants: 'workers',
    nuisance: 240,            // metres over which it depresses housing
  },
  civic: {
    label: 'Civic', icon: '🏛️',
    areaPer: 50,
    taxPerOccupant: 0,        // civic buildings cost, they do not earn
    upkeepPerOccupant: 0.9,
    colour: 0xb98cd4,
    wants: 'workers',
  },
};

/** Rezoning costs money and takes effect immediately. */
export const REZONE_COST_PER_M2 = 0.06;
export const DEMOLISH_COST_PER_M2 = 0.10;

// ─── demand & growth ────────────────────────────────────────────────────────

export const SIM = {
  startMoney: 25000,

  /** Share of residents who hold a job (the rest are children, retired, etc). */
  workforceShare: 0.52,

  /** How fast occupancy chases its target, per tick. */
  growthRate: 0.020,
  declineRate: 0.030,

  /** A building below this desirability sheds occupants. */
  desireFloor: 0.42,

  /** Buildings and zone-accessibility are refreshed round-robin over N ticks. */
  buildingSliceTicks: 24,
  zoneSliceTicks: 30,

  /** Travel time (minutes) beyond which a job may as well not exist. */
  commuteHorizon: 45,
  /** Commute time at which accessibility has fallen to half. */
  commuteHalfLife: 14,

  /** Peak-hour share of daily trips — used to turn commuters into vehicles/hour. */
  peakShare: 0.30,
  carShare: 0.72,
  occupantsPerCar: 1.15,
};

// ─── what makes a plot good ─────────────────────────────────────────────────
//
// Weights per zone kind. They are normalised at use, so these are relative
// importances, not percentages.

export const DESIRE = {
  residential: {
    roadAccess: 1.0, slope: 0.7, access: 1.6, park: 0.9,
    services: 1.2, nuisance: 1.1, congestion: 0.6,
  },
  commercial: {
    roadAccess: 1.6, slope: 0.4, access: 1.8, park: 0.2,
    services: 0.3, nuisance: 0.2, congestion: 0.9,
  },
  industrial: {
    roadAccess: 1.9, slope: 0.9, access: 0.9, park: 0.0,
    services: 0.1, nuisance: 0.0, congestion: 1.0,
  },
  civic: {
    roadAccess: 1.0, slope: 0.5, access: 1.0, park: 0.3,
    services: 0.0, nuisance: 0.3, congestion: 0.4,
  },
};

/** Distances (metres) at which each factor has decayed to half its benefit. */
export const FALLOFF = {
  road: 55,
  park: 320,
  service: 620,
  nuisance: 240,
};

/** Grade at which a plot is half as attractive to build on. 12% is steep. */
export const SLOPE_HALF = 0.12;

// ─── services ───────────────────────────────────────────────────────────────
//
// Seeded from OSM POIs and civic buildings. Coverage is a distance field, so a
// real school genuinely serves the streets around it.

export const SERVICES = {
  education: { label: 'Schools', icon: '🎓', poi: ['education'], weight: 1.0 },
  health:    { label: 'Health',  icon: '🏥', poi: ['health'],    weight: 1.0 },
  safety:    { label: 'Safety',  icon: '🚒', poi: ['fire', 'police'], weight: 0.8 },
  shops:     { label: 'Shops',   icon: '🛒', poi: ['shop', 'food'], weight: 0.7 },
};

// ─── overlays ───────────────────────────────────────────────────────────────

export const OVERLAYS = {
  none:       { label: 'Buildings', hint: 'natural colours' },
  zone:       { label: 'Zoning', hint: 'what each building is used for' },
  occupancy:  { label: 'Occupancy', hint: 'how full each building is' },
  desire:     { label: 'Desirability', hint: 'where people want to be' },
  access:     { label: 'Job access', hint: 'jobs reachable by road' },
  congestion: { label: 'Congestion', hint: 'traffic against road capacity' },
};
