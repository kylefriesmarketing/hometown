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

## Status — M6: services (2026-08-27)

**M1 (map) through M6 (services) are done and verified.**
`node test.mjs && node test-sim.mjs` = **253 tests, all green**.

A **what-if sandbox**: no fail state, no score. You inherit a real town and you
break it — flood it, rezone it, close streets, tear out the freeway — and watch
the place react.

What works:
- bake any place on Earth into a playable world
- a deterministic sim on the REAL street graph and REAL terrain
- **sea level**: raise it and real streets go under. Flooded segments are CUT
  from the routing graph, so traffic reroutes around the water
- **street surgery**: click any street to close, reopen, widen, narrow or tear
  it out. One button selects every motorway and trunk road on the map
- five overlays, click-to-rezone, demolish, speed controls, live HUD
- **share links**: 🔗 Copy link puts your whole city in a URL. A Russian Hill
  with its freeways torn out, three blocks rezoned and 3.5 m of sea is a
  **97-character URL** — and it reproduces byte-identically (verified: same
  `stateHash` on both sides, not merely a similar-looking city)
- **hold ⟨C⟩ or the 👁 button** to see the real town underneath your changes
- **transit**: pick bus / tram / metro, click stops along the map, press Finish.
  Lines are laid over the real street network and people use them if — and only
  if — they are actually faster
- **services**: select buildings and make them schools, clinics, fire/police or
  shops. A service you create seeds the same coverage field the OSM points of
  interest already seed, so it serves its streets exactly the way a real one
  does. Coverage is population-weighted — how well served the PEOPLE are, not
  how many buildings are schools

**Measured on San Francisco** (476k people, 470 km of streets, 291 freeway
segments including the real Central and James Lick Freeways):

| | commute | population | stranded |
|---|---|---|---|
| as it really is | 3.5 min | 476,252 | 391 |
| **every freeway torn out** | 3.6 min | 471,964 | **14,509** |

"Stranded" is people who can no longer reach any work by road — it is the number
that actually moves, and it moves 37x.

⚠️ **Commutes read ~8 min, and that is travel time WITHIN this slice of the
city.** The flagship is a 4.4 km square; real commutes are long because they
cross a metro area, and trips that leave the map cannot be modelled. (Before
`JUNCTION_DELAY` the figure was 3.5 min, which was simply wrong.)

⚠️ **There is no pressure, deliberately.** The treasury was removed from the HUD
because in a sandbox with no fail state it only ever climbed and told the player
nothing. Mean commute replaced it.

Still unbuilt from the chosen direction: **drawing new streets** (every existing
street is fully editable; laying fresh ones is the remaining verb).

Baked worlds:

| world | area | buildings | relief | note |
|---|---|---|---|---|
| `san-francisco` ★ | 19 km² | 17,636 | 144 m | **flagship.** Downtown, SoMa, the freeways, the Bay |
| `russian-hill` | 3.2 km² | 5,857 | 121 m | small, dense; loads fast |
| `myrtle-beach` | 4.8 km² | 758 | 13 m | flat coastal sprawl; the best flood demo |

### Transit, and why mode share is not a parameter

Routing already picks the fastest path. So the only rule transit needs is: **a
trip routed over transit adds no car to the road.** Mode share then emerges —
build a line people would genuinely use and cars come off the streets by
themselves. Measured on San Francisco:

| | ridership | car load | congestion |
|---|---|---|---|
| free-flowing roads + one metro | 2.3% | −1.2% | 3.3% → 3.0% |
| **congested roads + the same metro** | **3.8%** | **−2.7%** | 4.1% → 3.9% |

Ridership rises when the roads get worse. Nothing declares that; it falls out.

⚠️ **Getting here required admitting the cars were wrong, not the transit.**
The first working version had **0 of 38,423 trips** choose a metro, and it was
right to: a car crossed San Francisco at an effective **47.5 km/h** door to
door, because crossing an intersection was free. Real core-city speeds are
20–25 km/h and the entire difference is signals, stops and turns.
`JUNCTION_DELAY` charges for them, weighted by node degree so a well-mapped
straight road is not taxed for being split into many ways. Cars now cross at
**24.8 km/h**, a metro at 26.9 km/h, and the choice becomes real. Commutes
across the flagship went from 3.5 min to about 7.8 min — the old number was
never realistic.

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

For a big flagship-sized bake, `--minArea 40` sheds sheds and garages — the
San Francisco world is 17,636 buildings and 8.8 MB raw / **2.1 MB gzipped**.

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
| `share.js` | the command log, and city↔URL | pure; the log IS the share link |
| `graph.setTransit()` | the transit layer | edges APPENDED, so road indices stay stable |
| `game.js` | play layer: HUD, overlays, selection, clock | `issue()` is the ONLY route to the sim |
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

11. **Two block sources must stay independent.** A flooded street and a
    player-closed street are different facts: draining the sea must not reopen a
    street the player shut, and reopening a street must not un-flood the map.
    `graph.blockedFlood` and `graph.blockedPlayer` are ORed into `_shut`.

12. **Zone count must scale with the map, not the metre.** At a fixed 200 m grid
    a 4.4 km city needs 484 traffic zones, and every zone is a Dijkstra over a
    7,000-node graph — a tick cost 20 ms and the fast-forward speeds became
    unreachable. Target a constant zone COUNT (`TARGET_ZONES`) plus a hard
    `maxRoutesPerTick` ceiling. 3.2x faster, same behaviour.

13. **Benchmark WARM, and force a GPU sync.** `renderer.render()` only queues
    work, so timing it measures nothing; `readPixels` stalls until the GPU is
    done. A cold first measurement made the shadow pass look like 4.1 ms of a
    5.1 ms frame when warm it is 1.15 → 0.86 ms. Real cost at 1920x1080 while
    panning is **1 ms/frame**, 2M triangles, 17 draw calls.

14. **A share link is a LOG, not a diff — and that is the whole feature.** The
    first version encoded the final state and replayed it by applying every edit
    at day 0. The result was *nearly* the author's city — population within
    0.01% — but not it: they had torn out the freeways at day 150, not day 0,
    and the city had grown differently since. Day-stamping every command makes
    it a genuine replay. `test-sim.mjs` asserts BOTH that a replay matches and
    that replaying the same edits at the wrong time does NOT, so the test cannot
    pass trivially.

15. **`game.issue()` is the only route to `sim.execCommand`.** Anything that
    bypasses it is a change that silently will not travel in a share link.

16. **State before UI builders in the Game constructor.** `_buildSeaSlider()`
    primes the slider, which routes through `issue()`, which needs the log —
    creating the log after the builders threw on construction and the game never
    booted at all. Same class as a TDZ trap: armed by content, not by syntax.

17. **A −1 sentinel meets an array index.** Transit edges carry `eroad === -1`,
    and `_applyRoads` did `roadState[-1]` → `undefined` → `undefined === 0` is
    false → **every transit edge was silently marked CLOSED**, with `capMul`
    set to NaN. The lines existed, were correctly shaped and connected, and were
    simply unreachable: 0 of 38,423 trips could use them and nothing reported an
    error. Guarded by a test that asserts no transit edge is ever shut.

18. **Transit edges are APPENDED, never interleaved.** Road edge indices stay
    stable, so every per-edge array (load, blocks, capacity) extends in place.
    But `setTransit()` reallocates them all, so the sim must re-apply road and
    flood state afterwards — laying a tram line would otherwise reopen every
    street the player closed. Order: transit, then roads, then flood.

19. **The transit node index excludes platforms.** `_buildNodeIndex` is rebuilt
    over base nodes only; if platforms entered it, a later line would snap its
    access edge to another line's platform instead of to the street, and transit
    would quietly detach from the city.

20. **A rezoned or demolished service must STOP being a service.** Otherwise its
    coverage haunts the map with nothing standing there to provide it. Coverage
    is also rebuilt on restore rather than carried in the save, so a loaded city
    can never keep a field whose schools are gone. Both are tested.

21. **A string-replace patch that does not match is a SILENT no-op.** The
    coverage HUD metric shipped as a permanent "—" because its patch anchored on
    an element removed two milestones earlier. Patch scripts assert their anchors
    now; more importantly, verify the effect rather than trusting "patch said
    ok".

22. **Reload between destructive probes.** A probe that swaps a material and
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
