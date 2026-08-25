// main.js — boot, input, and the frame loop.

import { World } from './world.js';
import { View } from './view.js';
import { UI } from './ui.js';
import { RoadGraph } from './graph.js';
import { Sim } from './sim.js';
import { Game } from './game.js';

const canvas = document.getElementById('c');
const bootEl = document.getElementById('boot');
const bootMsg = document.getElementById('boot-msg');

let world = null, view = null, ui = null, graph = null, sim = null, game = null;
const keys = Object.create(null);

// ─── boot ─────────────────────────────────────────────────────────────────

async function listWorlds() {
  try {
    const r = await fetch('./worlds/index.json');
    if (r.ok) return await r.json();
  } catch { /* fall through */ }
  return [{ name: 'russian-hill', label: 'Russian Hill, San Francisco' }];
}

async function loadWorld(name) {
  bootEl.classList.remove('gone');
  bootMsg.textContent = `reading ${name.replace(/-/g, ' ')}…`;

  world = await World.load(`./worlds/${name}.json`);

  if (view) {
    view.renderer.dispose();
    view.scene.clear();
  }
  bootMsg.textContent = 'building the town…';
  await yieldToPaint();                // let the message paint before we block

  view = new View(canvas, world);
  const ms = view.build();
  console.log(`[hometown] built ${world.name} in ${ms.toFixed(0)} ms`,
    world.stats());

  // Start looking at the middle of the built-up area, not the empty corner.
  const c = centreOfMass(world);
  view.cam.fx = c.x; view.cam.fz = c.z;

  ui = ui || new UI(world);
  ui.setWorld(world);
  syncOptions();

  // the play layer
  graph = new RoadGraph(world);
  sim = new Sim(world, graph, { seed: 20260825 });
  game = new Game(sim, view, ui);
  console.log('[hometown] street graph', graph.stats());

  bootEl.classList.add('gone');
  window.__ht = { world, view, ui, graph, sim, game };   // console handle for verification
}

/** Where the buildings actually are — a better opening shot than (0,0). */
function centreOfMass(w) {
  let sx = 0, sz = 0, sa = 0;
  for (const b of w.buildings) { sx += b.c[0] * b.a; sz += b.c[1] * b.a; sa += b.a; }
  return sa > 0 ? { x: sx / sa, z: sz / sa } : { x: 0, z: 0 };
}

/**
 * Yield to the browser so a pending paint lands before we block on geometry.
 *
 * ⚠️ Deliberately NOT requestAnimationFrame: a backgrounded or non-compositing
 * tab suspends rAF entirely, and boot would hang forever waiting for a frame
 * that never comes. A MessageChannel macrotask is not throttled, so this
 * resolves in every tab state.
 */
const yieldToPaint = () => new Promise(r => {
  const ch = new MessageChannel();
  ch.port1.onmessage = () => { ch.port1.close(); r(); };
  ch.port2.postMessage(0);
});

// ─── input ────────────────────────────────────────────────────────────────

let drag = null;

canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, button: e.button, x0: e.clientX, y0: e.clientY, moved: 0 };
  canvas.classList.add('dragging');
});

canvas.addEventListener('pointerup', e => {
  // A click selects; a drag pans. Distinguish by how far the pointer travelled,
  // so a small wobble while clicking does not silently become a camera move.
  if (drag && drag.button === 0 && drag.moved < 5 && game && view) {
    const r = canvas.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = -((e.clientY - r.top) / r.height) * 2 + 1;
    try {
      const hit = view.pick(nx, ny);
      game.select(hit && hit.building ? hit.index : -1, e.shiftKey);
    } catch (err) { console.warn('pick failed', err); }
  }
  drag = null;
  canvas.classList.remove('dragging');
});

canvas.addEventListener('pointermove', e => {
  if (!view) return;

  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    const c = view.cam;

    if (drag.button === 2 || e.shiftKey) {
      c.yaw -= dx * 0.005;
      c.pitch -= dy * 0.004;
    } else {
      // Pan in the camera's ground frame, scaled so a drag moves the same
      // number of PIXELS of map regardless of zoom.
      const s = c.dist * 0.0016;
      const sin = Math.sin(c.yaw), cos = Math.cos(c.yaw);
      c.fx -= (dx * cos - dy * sin) * s;
      c.fz += (dx * sin + dy * cos) * s;
    }
    return;
  }

  // hover probe — cheap enough to run per move, but throttled to a frame
  if (hoverPending) return;
  hoverPending = true;
  requestAnimationFrame(() => {
    hoverPending = false;
    const r = canvas.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = -((e.clientY - r.top) / r.height) * 2 + 1;
    try { ui?.showProbe(view.pick(nx, ny)); } catch { /* a probe must never break the frame */ }
  });
});
let hoverPending = false;

canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('wheel', e => {
  if (!view) return;
  e.preventDefault();
  view.cam.dist *= Math.exp(Math.sign(e.deltaY) * 0.12);
}, { passive: false });

addEventListener('keydown', e => {
  keys[e.key.toLowerCase()] = true;
  if (e.key === 'Tab') e.preventDefault();
  if (!game) return;
  if (e.key === 'Escape') game.clearSelection();
  if (e.key === ' ') { e.preventDefault(); game.setSpeed(game.speed === 0 ? 1 : 0); }
  if (e.key >= '1' && e.key <= '4') game.setSpeed(+e.key - 1);
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
addEventListener('resize', () => view?.resize());

function pollKeys(dt) {
  if (!view) return;
  const c = view.cam;
  const speed = c.dist * 0.85 * dt;
  let fx = 0, fz = 0;
  if (keys.w || keys.arrowup) fz -= 1;
  if (keys.s || keys.arrowdown) fz += 1;
  if (keys.a || keys.arrowleft) fx -= 1;
  if (keys.d || keys.arrowright) fx += 1;
  if (fx || fz) {
    const sin = Math.sin(c.yaw), cos = Math.cos(c.yaw);
    c.fx += (fx * cos + fz * sin) * speed;
    c.fz += (-fx * sin + fz * cos) * speed;
  }
  if (keys.q) c.yaw += 1.4 * dt;
  if (keys.e) c.yaw -= 1.4 * dt;
  if (keys.r) c.dist *= Math.exp(-1.2 * dt);
  if (keys.f) c.dist *= Math.exp(1.2 * dt);
}

// ─── options ──────────────────────────────────────────────────────────────

function syncOptions() {
  const g = document.getElementById('opt-guessed');
  const s = document.getElementById('opt-shadows');
  view.showGuessed = g.checked;
  view.applyGuessedShading();
  view.renderer.shadowMap.enabled = s.checked;
}

document.getElementById('opt-guessed').addEventListener('change', e => {
  if (!view) return;
  view.showGuessed = e.target.checked;
  view.applyGuessedShading();
});

document.getElementById('opt-shadows').addEventListener('change', e => {
  if (!view) return;
  view.renderer.shadowMap.enabled = e.target.checked;
  // three.js caches compiled programs against shadow state; force a rebuild.
  view.scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
});

// ─── loop ─────────────────────────────────────────────────────────────────

let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!view) return;
  pollKeys(dt);
  if (game) game.update(dt);
  view.render();
}

// ─── go ───────────────────────────────────────────────────────────────────

(async () => {
  try {
    const worlds = await listWorlds();
    const pick = document.getElementById('world-pick');
    pick.innerHTML = worlds
      .map(w => `<option value="${w.name}">${w.label || w.name}</option>`).join('');
    pick.addEventListener('change', () => loadWorld(pick.value).catch(showError));

    const params = new URLSearchParams(location.search);
    const want = params.get('world') || worlds[0].name;
    pick.value = worlds.some(w => w.name === want) ? want : worlds[0].name;

    await loadWorld(pick.value);
    requestAnimationFrame(loop);
  } catch (e) { showError(e); }
})();

/**
 * Photograph the canvas and POST it to tools/shot.mjs.
 *
 * ⚠️ The render and the toDataURL MUST stay in one synchronous task: a WebGL
 * drawing buffer is cleared on composite, so any await between them returns a
 * blank image. This is also why we size the renderer by hand — a pane that
 * never composites leaves the canvas at 0×0.
 */
window.__htShot = function (name = 'shot', w = 1600, h = 900, port = 8398) {
  if (!view) return 'no view';
  const r = view.renderer;
  const prevW = r.domElement.width, prevH = r.domElement.height;
  r.setSize(w, h, false);
  view.camera.aspect = w / h;
  view.camera.updateProjectionMatrix();
  view.render();                                        // same task…
  const url = r.domElement.toDataURL('image/png');      // …as this
  r.setSize(prevW || w, prevH || h, false);
  view.camera.aspect = (prevW || w) / (prevH || h);
  view.camera.updateProjectionMatrix();
  fetch(`http://localhost:${port}/shot?name=${encodeURIComponent(name)}`,
    { method: 'POST', body: url }).catch(e => console.warn('shot receiver down?', e.message));
  return `${name}: ${(url.length / 1024).toFixed(0)} KB posted`;
};

function showError(e) {
  console.error(e);
  bootEl.classList.remove('gone');
  bootEl.querySelector('.inner').innerHTML =
    `<h2>HOMETOWN</h2><p class="err">${e.message}<br><br>` +
    `If no world has been baked yet, run:<br>` +
    `<code>node tools/bake.mjs --place "your town" --radius 1200 --name yourtown</code></p>`;
}
