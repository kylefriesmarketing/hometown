# HOMETOWN

A city builder played on **real places**. You pick a spot on Earth, the baker pulls
the actual streets, buildings and terrain, and that becomes the board.

Two free, key-less data sources — no Google, no API key, no per-request bill:

| layer | source | licence |
|---|---|---|
| streets, buildings, land use, water, POIs | **OpenStreetMap** via Overpass API | ODbL — attribution required, and shown in-game |
| elevation | **AWS Terrain Tiles** (terrarium PNG, SRTM/Copernicus/NED derived) | public domain / open |

**This README is the milestone authority.** Trust it over anything else in the repo.

---

## Status — M2: it is a playable what-if sandbox (2026-08-25)

**M1 (the map) and M2 (the simulation) are both done and verified.**
`node test.mjs && node test-sim.mjs` = **150 tests, all green**.

The design is a **what-if sandbox**: no fail state, no score. You inherit a real
town and you break it — flood it, rezone it, tear things out — and watch the
place react. San Francisco is the flagship.

What works:
- bake any place on Earth into a playable world
- a deterministic city sim on the REAL street graph and REAL terrain: capacity
  from actual floor area, desirability from actual grade, road access, job
  reach, parks, services and industrial nuisance
- gravity commuting with BPR congestion over a routable OSM street network
- **sea level**: raise it and watch which real streets go under. Buildings drown,
  people are displaced, and flooded street segments are CUT from the network so
  traffic genuinely reroutes around the water
- five overlays (zoning, occupancy, desirability, job access, congestion)
- click to select, rezone, demolish; speed controls; a live HUD

⚠️ **There is no pressure yet, by design and by omission.** Measured over one
simulated year of San Francisco: population 62k → 88k, treasury $25k → $1.96M,
unemployment 0.0%, congestion 1%. The city fixes itself and prints money. That is
fine for a sandbox and fatal for a game with goals — if this ever grows a
scenario mode, money must be able to run out and people must be able to leave.

Still to build from the chosen direction: **roads & transit** (draw, widen,
pedestrianise, run a line — the graph already supports it), **services**
(coverage fields already exist, mostly UI), and the **before/after slider +
share link**.

Baked worlds:

| world | area | buildings | relief | note |
|---|---|---|---|---|
| `russian-hill` | 3.2 km² | 5,857 | 121 m | flagship. Dense SF; 70% of heights are real OSM data |
| `myrtle-beach` | 4.8 km² | 758 | 13 m | flat coastal sprawl; the best flood demo |

---

## Run it

```bash
node serve.mjs 8469
```

Live: **https://kylefriesmarketing.github.io/hometown/**

Then open `http://localhost:8469`. Add `?world=russian-hill` to pick one.

```bash
node test.mjs && node test-sim.mjs
```

## Bake your own town

```bash
node tools/bake.mjs --place "Asheville, North Carolina" --radius 1200 --name asheville
```

Also accepts `--center 37.8005,-122.4130 --radius 900` or an explicit
`--bbox s,w,n,e`. Options: `--zoom` (terrain tile zoom, default 14) and `--cell`
(heightmap grid metres, default 10). A bake writes `worlds/<name>.json` and adds
itself to `worlds/index.json`, so it appears in the picker with no extra step.

Radius is metres, so `--radius 1200` is a 2.4 km square. Dense cities get big
fast: Russian Hill at 900 m is 2.3 MB raw / **595 KB gzipped**.

---

## Architecture

Strict separation, so the sim can arrive without touching the renderer:

| file | role | rules |
|---|---|---|
| `geo.js` | projection + tile maths | pure; shared by baker AND runtime |
| `geom.js` | triangulation, ribbons, simplification | pure, no three.js |
| `world.js` | the baked place + every query about it | pure. No three.js, no DOM, **no randomness** |
| `view.js` | all rendering | view-only. `Math.random` is allowed HERE and nowhere else |
| `ui.js` | DOM panels | reads only; writes no state |
| `graph.js` | routable street network + Dijkstra | pure; topology from coordinate identity |
| `field.js` | distance fields, flood fill | pure |
| `sim.js` | the deterministic city simulation | **no `Math.random`, no DOM, no Date.** `execCommand` is the only mutation path |
| `data.js` | ALL tuning | balance changes go here and nowhere else |
| `palette.js` | how the city is coloured | pure data |
| `game.js` | play layer: HUD, overlays, selection, clock | issues commands; never writes sim state |
| `main.js` | boot, input, frame loop | — |
| `tools/bake.mjs` | the pipeline | bake-time only |
| `tools/osm.js` | OSM tags → game features | bake-time only; the runtime never sees a raw tag |

**Axis convention, stated once:** `+x` east, `+y` up, `+z` **south** — so north is
`-z`. Every sign error traces back to forgetting the z flip.

---

## ⚠️ Traps — read before changing rendering

1. **Face winding is NOT "counter-clockwise in xz".** Treating z as a maths
   y-axis flips handedness, so the intuitive winding produces **downward**
   normals and every surface is backface-culled into invisibility. This shipped
   once: roads, parks and every building roof were being culled. It reads as a
   colour or depth bug and is neither. `test.mjs` guards it — those tests fail
   loudly if the emission order in `geom.triangulate()` or the ribbon order in
   `view.buildRoads()` is reverted. Verified by reintroducing the bug.

2. **`world.heightAt()` is piecewise-linear over the terrain mesh's own triangle
   split — deliberately not bilinear.** A cell drawn as two triangles is a
   different surface from the bilinear patch through its corners; measured on
   real SF terrain they disagree by up to **0.28 m**, which is more than the
   offset roads drape at, so every road sank into the ground. Sampler and mesh
   now agree to the float (verified: worst disagreement 0.000 across 394 road
   vertices). Do not "simplify" it back to bilinear.

3. **The shadow frustum must track zoom.** Anything outside the shadow camera
   samples past the shadow map and renders **fully black**. A fixed box turned
   every distant building solid black at wide zoom. `_fitShadow(dist)` owns this.

4. **Regional Overpass mirrors answer 200 OK with zero elements.**
   `overpass.osm.ch` is Switzerland-only and cheerfully returned an empty San
   Francisco — which bakes a silently empty world. `fetchOsm` treats a
   zero-element response as a failure and retries elsewhere. Keep that guard.

5. **Overpass is flaky, not broken.** 500/502/504 are routine and mean "try
   again" — the baker retries 12 times across 4 mirrors with backoff. It also
   needs a real `User-Agent` or you get a 406.

6. **`requestAnimationFrame` is suspended in the Browser pane.** Boot must never
   await a frame or it hangs forever; `yieldToPaint()` uses a MessageChannel
   macrotask instead. The render loop still uses rAF (correct for a real tab),
   which means motion cannot be verified headlessly — call `view.render()`
   directly instead.

7. **Screenshots: the page photographs itself.** The pane never composites a
   WebGL page, so the built-in screenshot tools time out and the canvas reports
   0×0. Run `node tools/shot.mjs 8398 <outDir>`, then call `__htShot('name')` in
   the console. The render and the `toDataURL` must stay in one synchronous
   task, or you get a blank image.

8. **Round-robin updates turn "derived" values into STATE.** Traffic load,
   desirability and zone accessibility are each refreshed a slice at a time, so
   what is stored is a mosaic of many ticks. Rebuilding them in one pass at
   restore produced a different city that hashed identically at the save and
   drifted apart 40 ticks later. They are snapshotted and hashed. If you add
   another sliced update, it belongs there too.

9. **A save must be LOSSLESS.** Arrays were quantised to 3 decimals and the
   round-trip test passed — because `stateHash` quantises to 3 decimals too, so
   both sides rounded to the same number while the floats differed by 5e-4. The
   city is a feedback loop and amplified that within one tick. Do not "tidy"
   snapshot arrays by rounding them.

10. **Flooding is a connected fill from the map edge, and strictly BELOW the
    waterline.** A simple `height <= level` test fills inland hollows the sea
    cannot reach, and `<=` drowns an entire town whose terrain sits flat at 0 m
    the moment sea level is 0 — which is the default.

11. **Reload between destructive probes.** A probe that swaps a material and
   leaves it swapped means the next measurement is measuring the probe.

---

## Data honesty

The game distinguishes what OSM actually said from what we inferred, and shows it:

- **Heights**: `height` or `building:levels` tags are real; anything else is a
  per-type default and gets flagged `g:1`. The *Mark invented heights* toggle
  desaturates those buildings, so you can see at a glance how much of a skyline
  is surveyed fact. In Russian Hill 70% is real; in Myrtle Beach 4% is.
- **Land use**: each building records `ks` — `tag` (OSM said so), `poi`
  (inferred from a business standing inside it), `landuse` (inferred from the
  zone it sits in), or `none`. The probe panel says which.
- Buildings left as `other` are genuinely bare `building=yes` in OSM. We do not
  invent a use for them.

## Known limits

- **Elevation is ~30 m native resolution.** Terrarium tiles are resampled from
  SRTM/Copernicus, so zoom past z14 buys interpolation, not detail. Hills are
  smooth; there are no curbs. For US-only worlds, USGS 3DEP (1 m) would be a
  real upgrade and is a future path.
- **Multipolygon buildings drop their holes** — a courtyard renders solid. Outer
  rings only, v1.
- Roads are drawn as flat ribbons; bridges and tunnels carry their tags but are
  not yet layered vertically, so an overpass lies on the ground.
- Building footprints are extruded prisms — no roof shapes.

---

## Next — M2, the simulation

The map already computes most of what a city builder needs to reason about:
`heightAt`, `slopeAt`, `roadDistAt` (chamfer distance to the nearest drivable
road), `buildingAt`, and per-building land use, floor area and slope span.

Intended shape, in order:
1. **`sim.js`** — deterministic, fixed-tick, seeded RNG, **no `Math.random`**,
   headless-testable, following the same sim/view split QUARRY uses.
2. **Zoning + demand** — the existing stock is what you inherit; you rezone it.
   `roadDistAt` and `slopeAt` are already the natural buildability constraints,
   and SF's 31% grades should genuinely cost you.
3. **Population, jobs, traffic** on the real street graph (roads already carry
   class, speed, oneway and lane data).
4. **Growth** — new buildings placed against real parcels.

⚠️ When `sim.js` lands, add its state to a `stateHash()` from day one and test
save round-trips — that lesson is written in blood elsewhere in this workspace.
