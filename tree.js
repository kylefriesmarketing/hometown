// tree.js — the upgrade tree, and what each node actually does.
//
// Pure data plus one pure function. No sim state, no DOM.
//
// Shape borrowed from Plague Inc: three parallel branches, each node cheap at
// the top and expensive at the bottom, and — the rule that makes it a game —
// EVERY node you buy raises the price of every node you have not. So a run is
// about committing to a branch, not hoovering up the lot.
//
// The other borrowed idea that matters: most nodes UNLOCK a verb rather than
// nudge a number. Transit, which already existed, is now something you earn.

export const BRANCHES = {
  movement: {
    label: 'Movement', icon: '🚇', colour: 0x4ec08a,
    blurb: 'Get people where they are going.',
  },
  density: {
    label: 'Density', icon: '🏗️', colour: 0xd8a13c,
    blurb: 'Fit more life into the same ground.',
  },
  resilience: {
    label: 'Resilience', icon: '🌊', colour: 0x63a6d8,
    blurb: 'Survive what is coming.',
  },
};

/**
 * Every node. `effect` names a flag the sim reads — nodes never contain logic,
 * so a designer can retune the whole tree without opening sim.js.
 *
 * ⚠️ `id` is the wire format (saves, share links). APPEND ONLY; never renumber.
 */
export const NODES = [
  // ── movement ──────────────────────────────────────────────────────────────
  { id: 'bus',      branch: 'movement', tier: 1, cost: 8,  icon: '🚌',
    label: 'Bus Routes',        effect: 'unlockBus',
    blurb: 'Run buses on the streets you already have.' },
  { id: 'signals',  branch: 'movement', tier: 2, cost: 12, icon: '🚦', needs: ['bus'],
    label: 'Signal Priority',   effect: 'junction1',
    blurb: 'Retime the lights. Junctions on main roads cost 40% less time.' },
  { id: 'tram',     branch: 'movement', tier: 3, cost: 18, icon: '🚊', needs: ['signals'],
    label: 'Tram Network',      effect: 'unlockTram',
    blurb: 'Faster than a bus, and it does not sit in traffic.' },
  { id: 'grade',    branch: 'movement', tier: 4, cost: 26, icon: '🌉', needs: ['tram'],
    label: 'Grade Separation',  effect: 'junction2',
    blurb: 'Flyovers and underpasses. Main-road junctions cost 70% less.' },
  { id: 'metro',    branch: 'movement', tier: 5, cost: 36, icon: '🚇', needs: ['grade'],
    label: 'Metro Engineering', effect: 'unlockMetro',
    blurb: 'Tunnels. Nothing on the surface can touch it.' },

  // ── density ───────────────────────────────────────────────────────────────
  { id: 'zoning',   branch: 'density', tier: 1, cost: 8,  icon: '📐',
    label: 'Zoning Reform',     effect: 'cheapRezone',
    blurb: 'Rezoning costs half as much.' },
  { id: 'midrise',  branch: 'density', tier: 2, cost: 14, icon: '🏢', needs: ['zoning'],
    label: 'Mid-Rise',          effect: 'capacity1',
    blurb: 'Build up a little. Every building holds 25% more.' },
  { id: 'mixed',    branch: 'density', tier: 3, cost: 20, icon: '🏬', needs: ['midrise'],
    label: 'Mixed Use',         effect: 'mixedUse',
    blurb: 'Shops below, homes above. Commercial buildings also house people.' },
  { id: 'towers',   branch: 'density', tier: 4, cost: 28, icon: '🏙️', needs: ['mixed'],
    label: 'Towers',            effect: 'capacity2',
    blurb: 'Build up properly. Another 35% on top.' },
  { id: 'tod',      branch: 'density', tier: 5, cost: 38, icon: '🚏', needs: ['towers'],
    label: 'Transit-Oriented',  effect: 'tod',
    blurb: 'Density where the trains are. Big capacity bonus near a stop.' },

  // ── resilience ────────────────────────────────────────────────────────────
  { id: 'drains',   branch: 'resilience', tier: 1, cost: 8,  icon: '🕳️',
    label: 'Storm Drains',      effect: 'flood1',
    blurb: 'The first half-metre of sea stops being a problem.' },
  { id: 'civicfund',branch: 'resilience', tier: 2, cost: 12, icon: '🏛️', needs: ['drains'],
    label: 'Civic Fund',        effect: 'cheapServices',
    blurb: 'Services cost half as much to run.' },
  { id: 'seawall',  branch: 'resilience', tier: 3, cost: 20, icon: '🧱', needs: ['civicfund'],
    label: 'Seawalls',          effect: 'flood2',
    blurb: 'Hold back another metre and a half.' },
  { id: 'emergency',branch: 'resilience', tier: 4, cost: 28, icon: '🚑', needs: ['seawall'],
    label: 'Emergency Services',effect: 'serviceReach',
    blurb: 'Every service reaches 50% further.' },
  { id: 'retreat',  branch: 'resilience', tier: 5, cost: 38, icon: '📦', needs: ['emergency'],
    label: 'Managed Retreat',   effect: 'retreat',
    blurb: 'When a block drowns, its people resettle instead of vanishing.' },
];

export const NODE_BY_ID = Object.fromEntries(NODES.map(n => [n.id, n]));

/**
 * ⚠️ THE RULE THAT MAKES IT A GAME, straight out of Plague Inc: each node you
 * already own adds this to the price of every node you do not. Early picks are
 * cheap, a fifth pick is expensive, and going wide costs more than going deep.
 */
export const COST_CREEP = 2;

/** What a node costs right now, given how many are already owned. */
export function costOf(node, ownedCount) {
  return node.cost + ownedCount * COST_CREEP;
}

/** Can it be bought? Returns {ok, reason, cost}. */
export function canBuy(node, owned, momentum) {
  if (owned.has(node.id)) return { ok: false, reason: 'already built', cost: 0 };
  for (const need of node.needs || []) {
    if (!owned.has(need)) {
      return { ok: false, reason: `needs ${NODE_BY_ID[need].label}`, cost: costOf(node, owned.size) };
    }
  }
  const cost = costOf(node, owned.size);
  if (momentum < cost) return { ok: false, reason: 'not enough momentum', cost };
  return { ok: true, cost };
}

/**
 * Collapse a set of owned ids into the flags the sim reads. One place, so a new
 * node is a data edit plus one line in sim.js, never a hunt.
 */
export function effectsOf(owned) {
  const e = {
    unlockBus: false, unlockTram: false, unlockMetro: false,
    junctionMul: 1, capacityMul: 1, mixedUse: false, tod: false,
    rezoneMul: 1, serviceUpkeepMul: 1, serviceReachMul: 1,
    floodOffset: 0, retreat: false,
  };
  for (const id of owned) {
    const n = NODE_BY_ID[id];
    if (!n) continue;
    switch (n.effect) {
      case 'unlockBus':   e.unlockBus = true; break;
      case 'unlockTram':  e.unlockTram = true; break;
      case 'unlockMetro': e.unlockMetro = true; break;
      case 'junction1':   e.junctionMul = Math.min(e.junctionMul, 0.6); break;
      case 'junction2':   e.junctionMul = Math.min(e.junctionMul, 0.3); break;
      case 'cheapRezone': e.rezoneMul = 0.5; break;
      case 'capacity1':   e.capacityMul *= 1.25; break;
      case 'capacity2':   e.capacityMul *= 1.35; break;
      case 'mixedUse':    e.mixedUse = true; break;
      case 'tod':         e.tod = true; break;
      case 'flood1':      e.floodOffset += 0.5; break;
      case 'flood2':      e.floodOffset += 1.5; break;
      case 'cheapServices': e.serviceUpkeepMul = 0.5; break;
      case 'serviceReach':  e.serviceReachMul = 1.5; break;
      case 'retreat':     e.retreat = true; break;
    }
  }
  return e;
}

// ─── momentum ───────────────────────────────────────────────────────────────

export const MOMENTUM = {
  /**
   * ⚠️ MOMENTUM IS DELIBERATELY NOT PROPORTIONAL TO CITY SIZE.
   *
   * The first version paid per thousand people served, which on a 464,000-person
   * San Francisco meant +611 a month — the entire 15-node tree costs 524, so you
   * could buy everything in the first month and nothing was ever a choice. It
   * also meant Myrtle Beach (7,000 people) and San Francisco played sixty times
   * apart on the same tree.
   *
   * So momentum is political attention, not tax revenue: a fixed monthly budget
   * scaled by how well the city is actually working. Same pace on every map.
   */
  perMonth: 1.6,
  /** Floor of the monthly payout even in a badly-run city. */
  floorShare: 0.35,
  /** Commute above this eats into the payout. */
  commuteTarget: 8,
  commutePenalty: 0.05,

  /** Clicking a problem. The ACTIVE half of the loop, as in Plague Inc. */
  bubbleBase: 2,
  bubbleMax: 6,
  /** How many problems are surfaced at once, and how long a claimed one stays gone. */
  maxBubbles: 5,
  bubbleCooldownDays: 180,

  startingMomentum: 10,
};
