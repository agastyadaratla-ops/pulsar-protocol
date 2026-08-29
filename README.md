# Pulsar Protocol

A co-op, round-based robot survival FPS for the browser — Call of Duty Zombies structure,
but the horde is machines and everything you shoot with is a laser pulsar weapon.

Real-time 3D (WebGL via three.js), a Node + WebSocket server, and a 96 × 72 tile facility
split into 12 door-gated sectors — drawn at random from three of them each time the squad
deploys. No art assets and no CDN — every mesh, texture and machine
is generated at boot. The game is silent by design; there is no audio.

---

## Run it

```bash
npm --prefix pulsar-protocol install
```

```bash
npm --prefix pulsar-protocol start
```

Then open **http://localhost:4180**.

### Playing together

Everyone enters the same **squad code** on the deploy screen (default `ALPHA`) and lands in the
same facility. Up to 4 operators per squad; more squads just use different codes. On the same
LAN, other machines connect to `http://<your-lan-ip>:4180`. A room's map, round counter and
credit economy are all owned by the server, so joining mid-game drops you straight into the wave
in progress.

`GET /api/rooms` lists live squads, their player count and current wave.

### Tests

```bash
npm --prefix pulsar-protocol test
```

`test/smoke.js` is headless and offline: it checks map-generation invariants across all three
facilities × 60 seeds each (full reachability, all 12 sectors connected, unique sector names, no
prop or spawn port buried in geometry, door pricing bands), verifies facility selection is
random, covers all three and never repeats back to back, then runs a real `Room` through waves,
pathing, shooting, the whole purchase economy, downs and revives, a squad wipe and the reset.

`test/net.js` spawns its own server on port 4187 and drives two real WebSocket clients through
handshake, snapshot cadence, movement replication, kill credit, malformed-payload handling,
door purchases and refusal routing, chat and disconnect.

Both suites are headless: they exercise the server, not the renderer.

---

## Controls

| Input | Action |
|---|---|
| `WASD` | Move — `SHIFT` to sprint |
| Mouse | Aim (click the canvas once to capture the pointer) |
| `LMB` / `RMB` | Fire / focus (ADS) |
| `R` · `Q` · `1` `2` | Reload · quick-swap · direct slot select |
| `G` | Throw an EMP charge |
| `F` | Buy, activate, or hold to revive a downed squadmate |
| `TAB` · `ENTER` · `ESC` | Squad status · chat · pause menu |

---

## Hosting

The client is static; the server is not. Everything that makes it a game — waves,
robot pathfinding, damage, the credit economy — runs on the Node process, and the
browser is a renderer that reads snapshots. So GitHub Pages alone cannot host it.

### Both halves on one host (simplest)

Deploy the repo to anything that runs Node (Render, Railway, Fly.io). It honours
`PORT`, serves the client itself, and needs no configuration. Done.

### Client on GitHub Pages, server elsewhere

```bash
npm run build:pages     # -> dist/
npm run preview:pages   # serves dist/ at a project subpath, like Pages does
```

The build copies `shared/` and three.js into `dist/` and rewrites the absolute
`/shared` and `/vendor` paths to relative ones, because Pages serves a project
site from `user.github.io/<repo>/` where absolute paths resolve above the site
root and 404.

`.github/workflows/pages.yml` does this on every push to `main`. Point it at your
server by setting a repository variable **PP_SERVER** (Settings → Secrets and
variables → Actions → Variables) to e.g. `wss://pulsar-protocol.onrender.com`.
Without it, players can type a server on the deploy screen instead.

Two constraints worth knowing:

- **It must be `wss://`, not `ws://`.** Pages is HTTPS and browsers refuse
  insecure WebSockets from a secure page. The client detects this and says so
  rather than failing silently. Render and Fly terminate TLS for free.
- **The server must stay awake.** Free tiers that sleep on idle will make the
  first connection of the day hang for ~30 seconds.

Local testing of a Pages build, with the server on its usual port:

```bash
npm start                                    # server on :4180
npm run preview:pages                        # static client on :4181
# then open http://localhost:4181/pulsar-protocol/?server=ws://localhost:4180
```

## The three facilities

On deploy the server picks one at random — never the same one twice running — and every
operator in the squad watches the same reel land on the same answer. All three are 96 × 72
across twelve sectors; what changes is how the sectors are carved, named and lit.

| Facility | Layout | Feel |
|---|---|---|
| **The Foundry** | Wide rectangular halls with support pillars | Long fields of fire, room to train a horde in circles |
| **Cold Storage** | Parallel freight aisles separated by solid racks | Open down the aisle, blind across it |
| **The Hive** | Warrens of small chambers packed tight | Claustrophobic, every fight is around a corner |

Cold Storage runs roughly 2700–3000 walkable tiles, the Foundry 1900–2400, the Hive 1700–2100,
so they play at genuinely different densities.

## Pause menu

**ESC** opens the system menu. Escape is owned by the browser — it always releases the mouse
and cannot be intercepted — so the menu keys off *losing pointer lock* instead, which also
catches alt-tabbing away. **RESUME** re-locks the mouse; **ABORT TO LANDING** disconnects
cleanly and returns to the deploy screen.

It is not a real pause, and the menu says so plainly. This is co-op: the server keeps
simulating, and your operator is still standing in the facility while you read it. Movement,
firing and buying are disabled behind the menu, but robots do not stop walking toward you.

## How a run goes

**Credits** come from damage (10 a hit) and kills (100–300 by chassis type). They are the only
currency, and they buy everything:

- **Blast doors** (750 → 1750 by depth) open the next sector. The facility starts sealed with
  only the CRYO BAY available, so the map opens up exactly as fast as the squad can pay for it.
- **Wall mounts** sell a specific weapon at full price, or restock its ammo at half.
- **The Fabricator** (950) rolls a random pulsar weapon and relocates itself after a few pulls.
- **Main power** is a lever deep in the complex. It's free, but finding it is the run's first
  real objective — it wakes the chip sockets and the Overclock Station.
- **Chip sockets** (1500–3000, max 4) are the perk tier: Alloy Plating, Rapid Cycler, Overdrive
  Core, Nanorepair Cell, Kinetic Boost.
- **The Overclock Station** (5000) Pack-a-Punches the weapon in your active slot — roughly 4×
  damage, bigger magazine, new name.

Waves scale in count, health and speed, with a **purge wave** every 5th round that skews the
spawn table toward fast drone chassis. Robots drop powerups (resupply, EMP surge, overcharge,
double credits, field repair) on a cooldown.

Take enough damage and you go down: 42 seconds of bleedout, crawling, waiting for a squadmate to
hold `F` on you. Solo runs get one self-repair per wave, and only with the Nanorepair chip.
When the whole squad is down the run ends, the facility regenerates, and a new one is dealt.

---

## Layout of the code

```
server/
  index.js      Express static host + WebSocket transport + the 60Hz room loop
  game.js       Room: rounds, robot AI, hit resolution, credit economy, serialisation
  mapgen.js     Facility generator — three carvers, sectors, corridors, doors, props
shared/
  weapons.js    Weapon / perk / robot / powerup tables (loaded by both server and browser)
public/
  js/render3d.js  three.js scene: merged level geometry, robot rigs, weapon pass
  js/game.js      Input, client prediction, shooting, effects, frame loop
  js/sprites.js   Canvas textures for the wall-buy holograms and perk chip faces
  js/hud.js       DOM HUD + minimap
  js/net.js       WebSocket client with a snapshot buffer for interpolation
```

### Authority model

The server simulates robots, rounds, damage-to-players and the entire economy, and broadcasts
20 snapshots a second. Clients own their own movement and aiming, and report hits — a co-op PvE
game, so latency-free shooting is worth far more than anti-cheat. Hit reports are still range-
and existence-checked, and damage is clamped, so a broken client can't corrupt a room.

Remote robots and squadmates are interpolated ~110 ms behind the newest snapshot, which is what
keeps a 20Hz stream looking smooth at 60 fps.

### Rendering notes

The level is emitted once as two merged buffer geometries — one for the walls, one for the
emissive trim — with interior faces between adjacent solid tiles culled, so a 6912-tile
facility costs a handful of draw calls. Robots and operators are small mesh rigs cloned from
four prototypes, with the animated limbs resolved by name (three's `clone()` JSON-round-trips
`userData`, so mesh references cannot be stashed there).

The weapon is rendered in a second pass with its own scene, camera and lights, over a cleared
depth buffer. That is what stops it clipping into walls and keeps it from being blown out by
the player's suit lamp. Name tags, prices and damage numbers are drawn on a 2D overlay canvas
by projecting world positions through the camera, which keeps text crisp at any distance.

The renderer watches its own frame times and scales pixel ratio between 50% and 100% to hold
frame rate. Shooting does not use scene raycasting: it steps the tile grid analytically and
tests robot cylinders, with `tan(pitch)` giving the vertical slope, so the top quarter of a
chassis is a headshot.

### Tuning

Most of the feel lives in two places: the weapon / perk / robot tables in
`shared/weapons.js`, and the round-scaling maths in `Room.robotHp`, `Room.robotSpeed`,
`Room.pickKind` and `Room.startRound` in `server/game.js`. Facility size and sector count are
the constants at the top of `server/mapgen.js` — the 4 × 3 lattice of 24 × 24 sectors is what
makes the map big; raising `ZONE_COLS` / `ZONE_ROWS` makes it bigger, and the door-cost
schedule scales off graph depth from spawn automatically.
