// share.js — put a city in a URL.
//
// Pure: no three.js, no DOM. Encodes the player's COMMAND LOG, never the city
// itself. The sim is deterministic, so world + seed + this log reproduces the
// same place exactly — and a San Francisco with 291 torn-out freeways fits in a
// few hundred characters instead of nine megabytes.
//
// ⚠️⚠️ IT IS A LOG, NOT A DIFF, AND THAT DISTINCTION IS THE WHOLE FEATURE.
// The first version encoded the final state and replayed it by applying every
// edit at day 0 and then fast-forwarding. The result was *nearly* the author's
// city — population within 0.01% — but not it: the author had torn out the
// freeways at day 150, not day 0, and the city had grown differently since.
// A share link that returns a city "very like" the one you shared is a broken
// promise. Day-stamping every command makes it a genuine replay.
//
// Layout (varints unless stated):
//   magic 'HT' | version | worldName (len-prefixed utf8)
//   finalDay | entryCount
//   per entry: dayDelta | opcode | payload
//     REZONE : zone byte | count | (delta index) x N
//     ROAD   : roadOp byte | count | (delta index) x N
//     SEA    : zigzag(level*10)

import { ZONE_KINDS, ZONE_INDEX } from './data.js';

const MAGIC = [0x48, 0x54];   // 'HT'
const VERSION = 2;

const OP = { REZONE: 1, ROAD: 2, SEA: 3, TRANSIT_ADD: 4, TRANSIT_DEL: 5, TRANSIT_CLEAR: 6 };
const ROAD_OPS = ['close', 'open', 'widen', 'narrow', 'remove'];
const TRANSIT_KINDS = ['bus', 'tram', 'metro'];

export const MAX_REPLAY_DAYS = 1200;
/** A link should never carry more edits than a person plausibly made. */
export const MAX_ENTRIES = 4000;

// ─── varints ────────────────────────────────────────────────────────────────

function putVarint(out, n) {
  n = n >>> 0;
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
}
function getVarint(buf, cur) {
  let n = 0, shift = 0, b;
  do {
    if (cur.i >= buf.length) throw new Error('truncated share code');
    b = buf[cur.i++];
    n |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return n >>> 0;
}
const zig = n => (n << 1) ^ (n >> 31);
const unzig = n => (n >>> 1) ^ -(n & 1);

/** Sorted, delta-encoded id list — neighbouring ids cost one byte each. */
function putIds(out, ids) {
  const s = [...new Set(ids)].sort((a, b) => a - b);
  putVarint(out, s.length);
  let prev = 0;
  for (const i of s) { putVarint(out, i - prev); prev = i; }
}
function getIds(buf, cur) {
  const n = getVarint(buf, cur);
  const out = new Array(n);
  let prev = 0;
  for (let k = 0; k < n; k++) { prev += getVarint(buf, cur); out[k] = prev; }
  return out;
}

// ─── the log ────────────────────────────────────────────────────────────────

/**
 * Records every command a player actually issued, with the day it happened.
 * Game appends to this; nothing else may.
 */
export class CommandLog {
  constructor() { this.entries = []; }
  get length() { return this.entries.length; }
  clear() { this.entries.length = 0; }

  record(day, cmd) {
    if (this.entries.length >= MAX_ENTRIES) return false;
    this.entries.push({ day, cmd });
    return true;
  }
}

// ─── encode ─────────────────────────────────────────────────────────────────

export function encodeBytes(world, finalDay, log) {
  const out = [];
  out.push(...MAGIC, VERSION);

  const name = new TextEncoder().encode(world.name);
  putVarint(out, name.length);
  out.push(...name);

  putVarint(out, finalDay);

  const entries = log.entries.filter(e => e.day <= finalDay);
  putVarint(out, entries.length);

  let prevDay = 0;
  for (const { day, cmd } of entries) {
    putVarint(out, day - prevDay);
    prevDay = day;
    if (cmd.t === 'rezone') {
      out.push(OP.REZONE, ZONE_INDEX[cmd.zone] ?? 0);
      putIds(out, cmd.ids);
    } else if (cmd.t === 'road') {
      const oi = ROAD_OPS.indexOf(cmd.op);
      out.push(OP.ROAD, oi < 0 ? 0 : oi);
      putIds(out, cmd.ids);
    } else if (cmd.t === 'sea') {
      out.push(OP.SEA);
      putVarint(out, zig(Math.round(cmd.level * 10)));
    } else if (cmd.t === 'transit') {
      if (cmd.op === 'add') {
        out.push(OP.TRANSIT_ADD, Math.max(0, TRANSIT_KINDS.indexOf(cmd.kind)));
        putVarint(out, cmd.stops.length);
        // Stops are delta-encoded against the PREVIOUS stop: a drawn line moves
        // in short hops, so each coordinate costs a byte or two instead of four.
        let px = 0, pz = 0;
        for (const [x, z] of cmd.stops) {
          const rx = Math.round(x), rz = Math.round(z);
          putVarint(out, zig(rx - px)); putVarint(out, zig(rz - pz));
          px = rx; pz = rz;
        }
      } else if (cmd.op === 'remove') {
        out.push(OP.TRANSIT_DEL);
        putVarint(out, cmd.id);
      } else {
        out.push(OP.TRANSIT_CLEAR);
      }
    } else if (cmd.t === 'demolish') {
      // demolish is a rezone to 'none' — one opcode fewer to get wrong
      out.push(OP.REZONE, ZONE_INDEX.none);
      putIds(out, cmd.ids);
    } else {
      // Unknown command: emit a no-op rezone of nothing so the day stream stays
      // aligned rather than silently shifting every later entry.
      out.push(OP.REZONE, ZONE_INDEX.none);
      putIds(out, []);
    }
  }
  return Uint8Array.from(out);
}

export function decodeBytes(buf) {
  if (buf.length < 4 || buf[0] !== MAGIC[0] || buf[1] !== MAGIC[1]) {
    throw new Error('not a HOMETOWN share code');
  }
  if (buf[2] !== VERSION) throw new Error(`share code version ${buf[2]} is not supported`);

  const cur = { i: 3 };
  const nameLen = getVarint(buf, cur);
  if (nameLen > 128) throw new Error('bad share code');
  const world = new TextDecoder().decode(buf.subarray(cur.i, cur.i + nameLen));
  cur.i += nameLen;

  const finalDay = getVarint(buf, cur);
  const count = getVarint(buf, cur);
  if (count > MAX_ENTRIES) throw new Error('share code carries too many edits');

  const entries = [];
  let day = 0;
  for (let k = 0; k < count; k++) {
    day += getVarint(buf, cur);
    const op = buf[cur.i++];
    if (op === OP.REZONE) {
      const zone = buf[cur.i++];
      entries.push({ day, cmd: { t: 'rezone', zone: ZONE_KINDS[zone] ?? 'none', ids: getIds(buf, cur) } });
    } else if (op === OP.ROAD) {
      const oi = buf[cur.i++];
      entries.push({ day, cmd: { t: 'road', op: ROAD_OPS[oi] ?? 'close', ids: getIds(buf, cur) } });
    } else if (op === OP.SEA) {
      entries.push({ day, cmd: { t: 'sea', level: unzig(getVarint(buf, cur)) / 10 } });
    } else if (op === OP.TRANSIT_ADD) {
      const kind = TRANSIT_KINDS[buf[cur.i++]] ?? 'tram';
      const n = getVarint(buf, cur);
      if (n > 256) throw new Error('share code has an implausible transit line');
      const stops = [];
      let px = 0, pz = 0;
      for (let s = 0; s < n; s++) {
        px += unzig(getVarint(buf, cur)); pz += unzig(getVarint(buf, cur));
        stops.push([px, pz]);
      }
      entries.push({ day, cmd: { t: 'transit', op: 'add', kind, stops } });
    } else if (op === OP.TRANSIT_DEL) {
      entries.push({ day, cmd: { t: 'transit', op: 'remove', id: getVarint(buf, cur) } });
    } else if (op === OP.TRANSIT_CLEAR) {
      entries.push({ day, cmd: { t: 'transit', op: 'clear' } });
    } else {
      throw new Error(`unknown opcode ${op} in share code`);
    }
  }
  return { world, finalDay, entries };
}

// ─── base64url ──────────────────────────────────────────────────────────────

export function toBase64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa === 'function' ? btoa(s) : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  if (typeof atob === 'function') {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// ─── compression ────────────────────────────────────────────────────────────
//
// CompressionStream is in every current browser and in node 18+. If it is ever
// missing we fall back to raw bytes rather than failing — a longer link still
// works, and a link that throws does not.

async function deflate(bytes) {
  if (typeof CompressionStream !== 'function') return { raw: true, data: bytes };
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  w.write(bytes); w.close();
  const packed = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  // A small payload can GROW under deflate; keep whichever is shorter.
  return packed.length < bytes.length ? { raw: false, data: packed } : { raw: true, data: bytes };
}

async function inflate(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('this browser cannot read compressed links');
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(bytes); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

/** City -> share code. `z` prefix = deflated, `r` = raw. */
export async function encode(world, finalDay, log) {
  const { raw, data } = await deflate(encodeBytes(world, finalDay, log));
  return (raw ? 'r' : 'z') + toBase64Url(data);
}

export async function decode(code) {
  if (!code || code.length < 2) throw new Error('empty share code');
  const kind = code[0];
  const body = fromBase64Url(code.slice(1));
  if (kind === 'r') return decodeBytes(body);
  if (kind === 'z') return decodeBytes(await inflate(body));
  throw new Error('unrecognised share code');
}

// ─── replay ─────────────────────────────────────────────────────────────────

/**
 * Replay a decoded share onto a fresh sim.
 *
 * Commands go through `execCommand` — the same path a player's clicks take — so
 * a shared city can never reach a state a played one could not. Ticking to each
 * command's day before issuing it is what makes the result the author's city
 * rather than merely a city with the same edits.
 */
export function applyShare(sim, share, { onProgress } = {}) {
  const finalDay = Math.min(share.finalDay, MAX_REPLAY_DAYS);
  let applied = 0, skipped = 0;

  for (const { day, cmd } of share.entries) {
    if (day > finalDay) break;
    while (sim.day < day) sim.tick();
    const r = sim.execCommand(cmd);
    if (r && r.ok) applied++; else skipped++;
    if (onProgress) onProgress(sim.day / Math.max(1, finalDay));
  }

  // ⚠️ Capped. A share code carries a day number, and an absurd one would
  // otherwise lock the browser up on load.
  while (sim.day < finalDay) {
    sim.tick();
    if (onProgress && (sim.day & 63) === 0) onProgress(sim.day / finalDay);
  }

  return {
    applied, skipped,
    daysReplayed: sim.day,
    dayCapped: share.finalDay > MAX_REPLAY_DAYS,
  };
}
