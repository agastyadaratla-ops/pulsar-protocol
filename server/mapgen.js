'use strict';
/*
 * Procedural facility generator for Pulsar Protocol.
 *
 * Every facility is a 96 x 72 tile grid carved into a 4 x 3 lattice of 24 x 24
 * "sectors", joined by blast doors the squad buys open. What changes between
 * facilities is how each sector's interior is carved, plus its naming and
 * palette — enough that the three read as genuinely different places while the
 * door economy, spawn ports and prop placement stay identical.
 */

const ZONE_COLS = 4;
const ZONE_ROWS = 3;
const ZONE_W = 24;
const ZONE_H = 24;
const MAP_W = ZONE_COLS * ZONE_W; // 96
const MAP_H = ZONE_ROWS * ZONE_H; // 72

// ---------------------------------------------------------------- carvers
// Each returns a list of room rectangles for one sector. The shared pass then
// carves them, opens a hub at the sector centre and runs a 2-wide L corridor
// from every room to that hub, which is what guarantees connectivity no matter
// how exotic a carver gets. Corridors are never narrower than 2 tiles because a
// Titan chassis is 1.04 tiles across and would wedge in a 1-wide gap.

function roomsFoundry(z, ri, rnd) {
  const rooms = [];
  let guard = 0;
  while (rooms.length < ri(4, 6) && guard++ < 90) {
    const w = ri(5, 11), h = ri(5, 11);
    const x = ri(z.x0 + 2, z.x0 + ZONE_W - 3 - w);
    const y = ri(z.y0 + 2, z.y0 + ZONE_H - 3 - h);
    if (x < 1 || y < 1) continue;
    if (rooms.some(r => x - 1 < r.x + r.w + 1 && x + w + 1 > r.x - 1 &&
                        y - 1 < r.y + r.h + 1 && y + h + 1 > r.y - 1)) continue;
    rooms.push({ x, y, w, h });
  }
  return rooms;
}

/* Long parallel aisles with solid racks between them: open sightlines down the
   aisle, hard cover across it. */
function roomsColdStore(z, ri, rnd) {
  const rooms = [];
  const vertical = rnd() < 0.5;
  const count = ri(3, 4);
  const span = ZONE_W - 6;
  const pitch = Math.floor(span / count);
  for (let i = 0; i < count; i++) {
    const off = 3 + i * pitch;
    if (vertical) rooms.push({ x: z.x0 + off, y: z.y0 + 3, w: 3, h: ZONE_H - 6 });
    else rooms.push({ x: z.x0 + 3, y: z.y0 + off, w: ZONE_W - 6, h: 3 });
  }
  // one cross-cut so the aisles are not a dead-end comb
  if (vertical) rooms.push({ x: z.x0 + 3, y: z.y0 + ri(8, 14), w: ZONE_W - 6, h: 2 });
  else rooms.push({ x: z.x0 + ri(8, 14), y: z.y0 + 3, w: 2, h: ZONE_H - 6 });
  return rooms;
}

/* Many small chambers packed tight — claustrophobic, lots of corners. */
function roomsHive(z, ri, rnd) {
  const rooms = [];
  let guard = 0;
  while (rooms.length < ri(7, 10) && guard++ < 160) {
    const w = ri(4, 6), h = ri(4, 6);
    const x = ri(z.x0 + 2, z.x0 + ZONE_W - 3 - w);
    const y = ri(z.y0 + 2, z.y0 + ZONE_H - 3 - h);
    if (x < 1 || y < 1) continue;
    if (rooms.some(r => x - 2 < r.x + r.w + 2 && x + w + 2 > r.x - 2 &&
                        y - 2 < r.y + r.h + 2 && y + h + 2 > r.y - 2)) continue;
    rooms.push({ x, y, w, h });
  }
  return rooms;
}

const FACILITIES = [
  {
    id: 'foundry',
    name: 'THE FOUNDRY',
    blurb: 'Open halls, pillared floors, long fields of fire.',
    rooms: roomsFoundry,
    pillars: true,
    zoneNames: ['CRYO BAY', 'ASSEMBLY LINE', 'COOLANT LOOP', 'DRONE HANGAR',
                'MESS DECK', 'CENTRAL ATRIUM', 'SERVER SPINE', 'SMELT FLOOR',
                'HYDROPONICS', 'MAG-RAIL DEPOT', 'REACTOR ANNEX', 'CORE OVERLOOK'],
    tints: ['#2f5d7a', '#6c4a86', '#2f7a63', '#7a4a3a',
            '#3a4f8a', '#8a7a35', '#4a2f6b', '#8a3a4f',
            '#2f7a45', '#5a5a72', '#8a5a2f', '#3f7f8a']
  },
  {
    id: 'coldstore',
    name: 'COLD STORAGE',
    blurb: 'Freight aisles and blind cross-cuts. Watch the racks.',
    rooms: roomsColdStore,
    pillars: false,
    zoneNames: ['THAW DOCK', 'AISLE ONE', 'AISLE TWO', 'PALLET YARD',
                'BRINE LINE', 'SORTING FLOOR', 'CONVEYOR SPINE', 'DEEP FREEZE',
                'LOADING RAMP', 'MANIFEST OFFICE', 'CHILLER STACK', 'COLD VAULT'],
    tints: ['#2a6b86', '#38708c', '#4a7f96', '#2f5f7d',
            '#56809b', '#3f6f8f', '#2b6076', '#6a8fa6',
            '#35708a', '#4d7d94', '#2a5c74', '#79a3b8']
  },
  {
    id: 'hive',
    name: 'THE HIVE',
    blurb: 'Warrens of small cells. Nowhere is more than a corner away.',
    rooms: roomsHive,
    pillars: false,
    zoneNames: ['BROOD GATE', 'CELL BLOCK A', 'CELL BLOCK B', 'NURSERY',
                'GALLERY', 'QUEENS HOLLOW', 'TUNNEL NEXUS', 'RESIN WORKS',
                'DRONE PENS', 'HATCHERY', 'ROYAL JELLY', 'DEEP COMB'],
    tints: ['#7a5a2a', '#8a6a30', '#6b4a26', '#93773a',
            '#5f4322', '#8a5f2f', '#6f5228', '#a08040',
            '#734f24', '#87682e', '#5a3f20', '#9c8348']
  }
];

function makeRNG(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

function generateMap(seed, facilityIndex) {
  const rnd = makeRNG(seed);
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));

  const fi = Number.isInteger(facilityIndex)
    ? ((facilityIndex % FACILITIES.length) + FACILITIES.length) % FACILITIES.length
    : Math.floor(rnd() * FACILITIES.length);
  const FAC = FACILITIES[fi];
  const ZONE_NAMES = FAC.zoneNames;
  const ZONE_TINTS = FAC.tints;

  const grid = new Array(MAP_W * MAP_H).fill(1);       // 1 = solid, 0 = walkable
  const doorAt = new Array(MAP_W * MAP_H).fill(-1);    // index into doors[]
  const zoneAt = new Array(MAP_W * MAP_H).fill(0);

  const at = (x, y) => y * MAP_W + x;
  const carve = (x, y) => {
    if (x > 0 && y > 0 && x < MAP_W - 1 && y < MAP_H - 1) grid[at(x, y)] = 0;
  };

  const zones = [];
  for (let zy = 0; zy < ZONE_ROWS; zy++) {
    for (let zx = 0; zx < ZONE_COLS; zx++) {
      const i = zy * ZONE_COLS + zx;
      zones.push({
        i, zx, zy,
        x0: zx * ZONE_W, y0: zy * ZONE_H,
        cx: zx * ZONE_W + ZONE_W / 2, cy: zy * ZONE_H + ZONE_H / 2,
        name: ZONE_NAMES[i], tint: ZONE_TINTS[i],
        rooms: [], unlocked: false
      });
    }
  }

  // ---- carve rooms inside each sector -------------------------------------
  for (const z of zones) {
    z.rooms = FAC.rooms(z, ri, rnd);

    for (const r of z.rooms) {
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++) carve(x, y);
      // Support pillars in the bigger halls give the squad something to train around.
      if (FAC.pillars && r.w >= 9 && r.h >= 9) {
        grid[at(r.x + 2, r.y + 2)] = 1;
        grid[at(r.x + r.w - 3, r.y + 2)] = 1;
        grid[at(r.x + 2, r.y + r.h - 3)] = 1;
        grid[at(r.x + r.w - 3, r.y + r.h - 3)] = 1;
      }
    }

    // hub at the sector centre, plus 2-wide L corridors from every room
    for (let y = z.cy - 2; y < z.cy + 2; y++)
      for (let x = z.cx - 2; x < z.cx + 2; x++) carve(x, y);

    for (const r of z.rooms) {
      const rx = Math.floor(r.x + r.w / 2), ry = Math.floor(r.y + r.h / 2);
      const tx = Math.floor(z.cx), ty = Math.floor(z.cy);
      for (let x = Math.min(rx, tx); x <= Math.max(rx, tx); x++) { carve(x, ry); carve(x, ry + 1); }
      for (let y = Math.min(ry, ty); y <= Math.max(ry, ty); y++) { carve(tx, y); carve(tx + 1, y); }
    }
  }

  // ---- connect sectors: spanning tree + a few loop-back edges --------------
  const candidates = [];
  for (const z of zones) {
    if (z.zx < ZONE_COLS - 1) candidates.push({ a: z.i, b: z.i + 1, dir: 'h' });
    if (z.zy < ZONE_ROWS - 1) candidates.push({ a: z.i, b: z.i + ZONE_COLS, dir: 'v' });
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const parent = zones.map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const edges = [];
  for (const c of candidates) {
    const ra = find(c.a), rb = find(c.b);
    if (ra !== rb) { parent[ra] = rb; edges.push(c); }
  }
  // three extra links so the facility has loops instead of being a pure tree
  let extra = 3;
  for (const c of candidates) {
    if (extra <= 0) break;
    if (edges.includes(c)) continue;
    edges.push(c); extra--;
  }

  const doors = [];
  for (const e of edges) {
    const A = zones[e.a], B = zones[e.b];
    const door = { id: doors.length, a: A.i, b: B.i, open: false, cost: 750, tiles: [], x: 0, y: 0 };

    if (e.dir === 'h') {
      const y = Math.floor(A.cy);
      for (let x = Math.floor(A.cx); x <= Math.floor(B.cx); x++) { carve(x, y); carve(x, y + 1); }
      const bx = B.x0; // shared border column
      door.tiles = [[bx - 1, y], [bx - 1, y + 1], [bx, y], [bx, y + 1]];
      door.x = bx + 0.0; door.y = y + 1.0;
    } else {
      const x = Math.floor(A.cx);
      for (let y = Math.floor(A.cy); y <= Math.floor(B.cy); y++) { carve(x, y); carve(x + 1, y); }
      const by = B.y0;
      door.tiles = [[x, by - 1], [x + 1, by - 1], [x, by], [x + 1, by]];
      door.x = x + 1.0; door.y = by + 0.0;
    }
    for (const [tx, ty] of door.tiles) { grid[at(tx, ty)] = 0; doorAt[at(tx, ty)] = door.id; }
    doors.push(door);
  }

  // sector ownership per tile
  for (let y = 0; y < MAP_H; y++)
    for (let x = 0; x < MAP_W; x++)
      zoneAt[at(x, y)] = Math.min(ZONE_ROWS - 1, Math.floor(y / ZONE_H)) * ZONE_COLS +
                         Math.min(ZONE_COLS - 1, Math.floor(x / ZONE_W));

  // ---- sector graph distance from spawn, used to price doors --------------
  const START = 0; // CRYO BAY, top-left
  const adj = zones.map(() => []);
  for (const d of doors) { adj[d.a].push({ z: d.b, d: d.id }); adj[d.b].push({ z: d.a, d: d.id }); }
  const depth = zones.map(() => -1);
  depth[START] = 0;
  const q = [START];
  while (q.length) {
    const cur = q.shift();
    for (const n of adj[cur]) if (depth[n.z] < 0) { depth[n.z] = depth[cur] + 1; q.push(n.z); }
  }
  for (const d of doors) {
    const step = Math.min(depth[d.a], depth[d.b]);
    d.cost = [750, 1000, 1250, 1500, 1750][Math.min(4, step)];
  }

  let deepest = START;
  for (let i = 0; i < zones.length; i++) if (depth[i] > depth[deepest]) deepest = i;
  const sorted = zones.map(z => z.i).sort((a, b) => depth[b] - depth[a]);
  const POWER_ZONE = sorted[0];
  const PAP_ZONE = sorted.find(i => i !== POWER_ZONE);

  // ---- pick wall-adjacent floor tiles for props ---------------------------
  const isFloor = (x, y) => grid[at(x, y)] === 0;
  const wallSpots = zones.map(() => []);
  const openSpots = zones.map(() => []);
  for (let y = 1; y < MAP_H - 1; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      if (!isFloor(x, y) || doorAt[at(x, y)] >= 0) continue;
      const z = zoneAt[at(x, y)];
      const dirs = [[0, -1, 0], [1, 0, 1], [0, 1, 2], [-1, 0, 3]];
      let mounted = null;
      for (const [dx, dy, face] of dirs) if (grid[at(x + dx, y + dy)] === 1) { mounted = face; break; }
      if (mounted !== null) wallSpots[z].push({ x: x + 0.5, y: y + 0.5, face: mounted });
      else openSpots[z].push({ x: x + 0.5, y: y + 0.5 });
    }
  }
  const pick = (arr) => arr.length ? arr.splice(Math.floor(rnd() * arr.length), 1)[0] : null;
  const pickFar = (arr, others, minD) => {
    for (let tries = 0; tries < 40; tries++) {
      if (!arr.length) return null;
      const i = Math.floor(rnd() * arr.length);
      const c = arr[i];
      if (others.every(o => Math.hypot(o.x - c.x, o.y - c.y) > minD)) { arr.splice(i, 1); return c; }
    }
    return pick(arr);
  };

  const props = [];
  const addProp = (p) => { p.id = props.length; props.push(p); return p; };
  const placedInZone = zones.map(() => []);

  // Wall-buy guns: sidearm ammo + carbine in spawn, everything else spread out.
  const wallPlan = [
    { zone: START,   weapon: 'carbine',   cost: 1200 },
    { zone: START,   weapon: 'scatter',   cost: 1500 },
    { zone: 1,       weapon: 'repeater',  cost: 1300 },
    { zone: 2,       weapon: 'railgun',   cost: 1800 },
    { zone: 4,       weapon: 'carbine',   cost: 1200 },
    { zone: 5,       weapon: 'scatter',   cost: 1500 },
    { zone: 6,       weapon: 'ionstorm',  cost: 2200 },
    { zone: 7,       weapon: 'repeater',  cost: 1300 },
    { zone: 8,       weapon: 'railgun',   cost: 1800 },
    { zone: 9,       weapon: 'lance',     cost: 2400 },
    { zone: 10,      weapon: 'ionstorm',  cost: 2200 },
    { zone: 11,      weapon: 'lance',     cost: 2400 }
  ];
  for (const w of wallPlan) {
    const s = pickFar(wallSpots[w.zone], placedInZone[w.zone], 6);
    if (!s) continue;
    placedInZone[w.zone].push(s);
    addProp({ type: 'wallbuy', zone: w.zone, x: s.x, y: s.y, face: s.face, weapon: w.weapon, cost: w.cost });
  }

  // Perk stations, one per sector, avoiding spawn hoarding.
  const perkPlan = [
    { zone: START, perk: 'nano' },
    { zone: 3, perk: 'plating' },
    { zone: 5, perk: 'overdrive' },
    { zone: 6, perk: 'reload' },
    { zone: 9, perk: 'kinetic' },
    { zone: 10, perk: 'plating' }
  ];
  for (const p of perkPlan) {
    const s = pickFar(wallSpots[p.zone], placedInZone[p.zone], 6);
    if (!s) continue;
    placedInZone[p.zone].push(s);
    addProp({ type: 'perk', zone: p.zone, x: s.x, y: s.y, face: s.face, perk: p.perk });
  }

  // Fabricator (mystery box) rotates between four bays.
  const boxZones = [START, 4, 7, 9].filter((v, i, a) => a.indexOf(v) === i);
  const boxBays = [];
  for (const z of boxZones) {
    const s = pickFar(openSpots[z], placedInZone[z], 4) || pick(wallSpots[z]);
    if (s) { placedInZone[z].push(s); boxBays.push({ zone: z, x: s.x, y: s.y }); }
  }
  if (!boxBays.length) boxBays.push({ zone: START, x: zones[START].cx, y: zones[START].cy });
  addProp({ type: 'box', zone: boxBays[0].zone, x: boxBays[0].x, y: boxBays[0].y, bays: boxBays, bay: 0, cost: 950 });

  // Power switch + Overclock Station in the deep sectors.
  const ps = pickFar(wallSpots[POWER_ZONE], placedInZone[POWER_ZONE], 5);
  if (ps) addProp({ type: 'power', zone: POWER_ZONE, x: ps.x, y: ps.y, face: ps.face });
  const pp = pickFar(openSpots[PAP_ZONE], placedInZone[PAP_ZONE], 5) || pick(wallSpots[PAP_ZONE]);
  if (pp) addProp({ type: 'pap', zone: PAP_ZONE, x: pp.x, y: pp.y, cost: 5000 });

  // ---- robot spawn ports ---------------------------------------------------
  const ports = [];
  for (const z of zones) {
    const pool = wallSpots[z.i];
    for (let k = 0; k < 6 && pool.length; k++) {
      const s = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
      ports.push({ zone: z.i, x: s.x, y: s.y });
    }
  }

  // ---- player spawn points in the start sector ----------------------------
  const spawns = [];
  const sz = zones[START];
  for (let k = 0; k < 4; k++) {
    spawns.push({ x: sz.cx + (k % 2 ? 1.2 : -1.2), y: sz.cy + (k < 2 ? -1.2 : 1.2) });
  }

  return {
    seed,
    facility: { index: fi, id: FAC.id, name: FAC.name, blurb: FAC.blurb },
    w: MAP_W, h: MAP_H, zoneCols: ZONE_COLS, zoneRows: ZONE_ROWS,
    zoneW: ZONE_W, zoneH: ZONE_H,
    grid, doorAt, zoneAt,
    zones: zones.map(z => ({ i: z.i, name: z.name, tint: z.tint, cx: z.cx, cy: z.cy, depth: depth[z.i] })),
    doors: doors.map(d => ({ id: d.id, a: d.a, b: d.b, cost: d.cost, tiles: d.tiles, x: d.x, y: d.y })),
    props, ports, spawns, start: START, powerZone: POWER_ZONE, papZone: PAP_ZONE
  };
}

module.exports = {
  generateMap, FACILITIES,
  FACILITY_LIST: FACILITIES.map(f => ({ id: f.id, name: f.name, blurb: f.blurb })),
  MAP_W, MAP_H, ZONE_COLS, ZONE_ROWS, ZONE_W, ZONE_H
};
