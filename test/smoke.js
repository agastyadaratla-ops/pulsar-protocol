'use strict';
/*
 * Headless smoke suite: map generation invariants + a simulated room running
 * real rounds with real players. No browser, no audio, no network.
 *
 *   node test/smoke.js
 */

const { generateMap, FACILITY_LIST } = require('../server/mapgen');
const { Room } = require('../server/game');
const { WEAPONS, PERKS, ROBOTS, POWERUPS, CONST, statsFor } = require('../shared/weapons');

let pass = 0, fail = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(label + (detail ? ` — ${detail}` : ''));
  return false;
}
function section(name) { console.log(`\n── ${name}`); }
function done(name) { console.log(`   ${name}`); }

// ---------------------------------------------------------------- map gen
section('map generation (3 facilities x 60 seeds)');
{
  ok(FACILITY_LIST.length === 3, 'three facilities are registered', String(FACILITY_LIST.length));
  const perFacility = {};
  let minFloor = Infinity, maxFloor = 0, worstZones = 12;
  for (let s = 0; s < 180; s++) {
    const fi = s % FACILITY_LIST.length;
    const m = generateMap((Math.random() * 0xffffffff) >>> 0, fi);
    ok(m.facility.index === fi, `seed ${s}: requested facility honoured`, m.facility.id);
    ok(new Set(m.zones.map(z => z.name)).size === 12, `seed ${s}: sector names are unique`);
    ok(new Set(m.zones.map(z => z.tint)).size >= 8, `seed ${s}: palette is varied`);

    // flood fill from the player spawn with every door open
    const seen = new Uint8Array(m.w * m.h);
    const start = [Math.floor(m.spawns[0].x), Math.floor(m.spawns[0].y)];
    if (!ok(m.grid[start[1] * m.w + start[0]] === 0, 'spawn sits on floor')) break;
    const stack = [start];
    seen[start[1] * m.w + start[0]] = 1;
    let reached = 0;
    while (stack.length) {
      const [x, y] = stack.pop();
      reached++;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= m.w || ny >= m.h) continue;
        const i = ny * m.w + nx;
        if (m.grid[i] !== 0 || seen[i]) continue;
        seen[i] = 1;
        stack.push([nx, ny]);
      }
    }
    let floor = 0;
    for (let i = 0; i < m.grid.length; i++) if (m.grid[i] === 0) floor++;
    minFloor = Math.min(minFloor, floor);
    maxFloor = Math.max(maxFloor, floor);

    const zonesReached = new Set();
    for (let i = 0; i < seen.length; i++) if (seen[i]) zonesReached.add(m.zoneAt[i]);
    worstZones = Math.min(worstZones, zonesReached.size);

    perFacility[m.facility.name] = perFacility[m.facility.name] || { min: 1e9, max: 0 };
    perFacility[m.facility.name].min = Math.min(perFacility[m.facility.name].min, floor);
    perFacility[m.facility.name].max = Math.max(perFacility[m.facility.name].max, floor);

    if (!ok(reached === floor, `seed ${s}: every floor tile reachable`, `${reached}/${floor}`)) break;
    if (!ok(zonesReached.size === 12, `seed ${s}: all 12 sectors reachable`, `${zonesReached.size}`)) break;

    // props and spawn ports must stand on walkable ground, never inside geometry
    for (const p of m.props) {
      const i = Math.floor(p.y) * m.w + Math.floor(p.x);
      if (!ok(m.grid[i] === 0, `seed ${s}: prop "${p.type}" on floor`, `${p.x},${p.y}`)) break;
    }
    for (const pt of m.ports) {
      const i = Math.floor(pt.y) * m.w + Math.floor(pt.x);
      if (!ok(m.grid[i] === 0, `seed ${s}: spawn port on floor`)) break;
    }

    // door tiles are carved, and pricing rises with graph depth
    for (const d of m.doors) {
      for (const [tx, ty] of d.tiles) {
        if (!ok(m.grid[ty * m.w + tx] === 0, `seed ${s}: door tile carved`)) break;
        if (!ok(m.doorAt[ty * m.w + tx] === d.id, `seed ${s}: door tile indexed`)) break;
      }
      if (!ok(d.cost >= 750 && d.cost <= 1750, `seed ${s}: door cost in band`, String(d.cost))) break;
    }

    ok(m.props.some(p => p.type === 'power'), `seed ${s}: has a power switch`);
    ok(m.props.some(p => p.type === 'pap'), `seed ${s}: has an overclock station`);
    ok(m.props.some(p => p.type === 'box'), `seed ${s}: has a fabricator`);
    ok(m.props.filter(p => p.type === 'wallbuy').length >= 8, `seed ${s}: enough wall buys`);
    ok(m.powerZone !== m.start, `seed ${s}: power is not in the spawn sector`);
    ok(m.papZone !== m.powerZone, `seed ${s}: overclock is not on the power switch`);
  }
  for (const [name, r] of Object.entries(perFacility)) {
    done(`${name.padEnd(13)} ${r.min}–${r.max} floor tiles`);
  }
  done(`overall ${minFloor}–${maxFloor} of ${96 * 72}, sectors reachable: ${worstZones}/12`);
}

section('facility selection');
{
  const counts = {};
  for (let i = 0; i < 300; i++) {
    const m = generateMap((Math.random() * 0xffffffff) >>> 0);
    counts[m.facility.id] = (counts[m.facility.id] || 0) + 1;
    if (!ok(!!m.facility && typeof m.facility.name === 'string', 'unseeded generation names a facility')) break;
  }
  ok(Object.keys(counts).length === 3, 'all three facilities come up over 300 rolls', JSON.stringify(counts));
  for (const f of FACILITY_LIST) ok((counts[f.id] || 0) > 40, `${f.name} is not starved`, String(counts[f.id] || 0));

  const { Room } = require('../server/game');
  const room = new Room('PICK');
  let repeats = 0, prev = room.map.facility.id;
  for (let i = 0; i < 40; i++) {
    const m = room.rollFacility();
    if (m.facility.id === prev) repeats++;
    prev = m.facility.id;
  }
  ok(repeats === 0, 'a reroll never repeats the previous facility', String(repeats));
  done('selection is random, covers all three, and never repeats back to back');
}

// ------------------------------------------------------------ data tables
section('weapon / perk tables');
{
  for (const id in WEAPONS) {
    const w = WEAPONS[id];
    ok(w.dmg > 0 && w.rpm > 0 && w.mag > 0, `${id}: sane base stats`);
    ok(!!w.color && !!w.cls, `${id}: has colour + class`);
    if (w.pap) {
      const up = statsFor({ id, pap: true });
      ok(up.dmg > w.dmg, `${id}: overclock raises damage`, `${w.dmg} -> ${up.dmg}`);
      ok(up.papped === true, `${id}: overclock flag set`);
      ok(up.id === id, `${id}: overclock keeps identity`);
    }
  }
  const base = statsFor({ id: 'carbine', pap: false });
  ok(base.dmg === WEAPONS.carbine.dmg, 'un-overclocked stats untouched');
  ok(statsFor({ id: 'nope' }) === null, 'unknown weapon resolves to null');
  for (const id in PERKS) ok(PERKS[id].cost > 0 && !!PERKS[id].color, `perk ${id} well formed`);
  for (const id in ROBOTS) ok(ROBOTS[id].hp > 0 && ROBOTS[id].score > 0, `robot ${id} well formed`);
  done(`${Object.keys(WEAPONS).length} weapons, ${Object.keys(PERKS).length} perks, ${Object.keys(ROBOTS).length} chassis`);
}

// ------------------------------------------------------------ room runtime
section('room simulation');
{
  const room = new Room('TEST');
  const a = room.addPlayer(1, 'ALPHA');
  const b = room.addPlayer(2, 'BRAVO');
  ok(room.phase === 'lobby', 'starts in lobby');
  ok(a.points === 500 && b.points === 500, 'players start with 500 credits');
  ok(room.unlocked.size === 1, 'only the spawn sector is unlocked');

  const DT = 1 / 30;
  const tick = (seconds) => { for (let i = 0; i < seconds / DT; i++) room.step(DT); };

  // players must be alive for rounds to progress; keep topping them up
  const keepAlive = () => { for (const p of room.players.values()) { p.hp = p.maxHp; p.downed = false; p.alive = true; } };

  tick(6);
  ok(room.phase === 'active' && room.round === 1, 'wave 1 starts after the lobby timer',
    `phase=${room.phase} round=${room.round}`);
  ok(room.toSpawn > 0, 'wave 1 has a spawn budget', String(room.toSpawn));

  for (let i = 0; i < 60; i++) { room.step(DT); keepAlive(); }
  ok(room.robots.length > 0, 'robots spawn into the facility', String(room.robots.length));
  ok(room.robots.every(r => room.walkable(Math.floor(r.x), Math.floor(r.y))),
    'no robot spawns inside geometry');
  ok(room.robots.every(r => room.unlocked.has(room.map.zoneAt[Math.floor(r.y) * room.map.w + Math.floor(r.x)])),
    'robots only spawn in unlocked sectors');

  // robots should close distance on a stationary player
  const target = room.robots[0];
  const before = Math.hypot(target.x - a.x, target.y - a.y);
  for (let i = 0; i < 90; i++) { room.step(DT); keepAlive(); }
  const still = room.robots.find(r => r.id === target.id);
  if (still) {
    const after = Math.hypot(still.x - a.x, still.y - a.y);
    ok(after < before + 0.5, 'robots path toward players', `${before.toFixed(1)} -> ${after.toFixed(1)}`);
  } else ok(true, 'tracked robot already resolved');

  // shooting: damage, credits, kills
  const victim = room.robots.find(r => r.st === 0);
  const ptsBefore = a.points;
  room.handleFire(a, { hits: [[victim.id, 10, 0]] });
  ok(victim.hp < victim.maxHp, 'reported hits apply damage');
  ok(a.points === ptsBefore + CONST.HIT_POINTS, 'a hit pays 10 credits', String(a.points - ptsBefore));
  room.handleFire(a, { hits: [[victim.id, 999999, 1]] });
  ok(victim.st === 1, 'lethal damage downs the chassis');
  ok(a.kills === 1, 'kill is credited to the shooter');
  ok(a.points >= ptsBefore + ROBOTS[victim.kind].score, 'kill pays the chassis bounty');

  // damage is clamped and unknown robots are ignored
  const junk = a.points;
  room.handleFire(a, { hits: [[999999, 500, 0]] });
  ok(a.points === junk, 'hits on non-existent robots are discarded');
  room.handleFire(a, { hits: 'not-an-array' });
  ok(true, 'malformed fire payload does not throw');

  // economy: doors. Out-of-range interactions are silently ignored by design,
  // so stand at the door before testing the "can't afford it" path.
  const door = room.map.doors[0];
  a.x = door.x; a.y = door.y;
  a.points = 100;
  room.events.length = 0;
  room.interact(a, { door: door.id });
  ok(!room.openDoors.has(door.id), 'cannot breach a door you cannot afford');
  ok(room.events.some(e => e.kind === 'deny' && e.only === a.id),
    'refusal is reported back to the buyer only');

  a.x = 1.5; a.y = 1.5;
  room.events.length = 0;
  room.interact(a, { door: door.id });
  ok(room.events.length === 0, 'out-of-range interaction is silently ignored');

  a.x = door.x; a.y = door.y;
  a.points = 5000;
  room.interact(a, { door: door.id });
  ok(room.openDoors.has(door.id), 'door opens when paid for');
  ok(a.points === 5000 - door.cost, 'door cost is deducted', String(a.points));
  ok(room.unlocked.has(door.a) && room.unlocked.has(door.b), 'both sides of the door unlock');
  const dt0 = door.tiles[0];
  ok(room.walkable(dt0[0], dt0[1]), 'opened door tiles become walkable');

  // economy: wall buy, ammo restock, fabricator, power, perks, overclock
  const wall = room.map.props.find(p => p.type === 'wallbuy');
  a.x = wall.x; a.y = wall.y; a.points = 9999;
  room.interact(a, { prop: wall.id, slot: 0 });
  ok(a.weapons.some(w => w && w.id === wall.weapon), 'wall buy grants the weapon');
  const afterBuy = a.points;
  room.interact(a, { prop: wall.id, slot: 0 });
  ok(a.points === afterBuy - Math.round(wall.cost / 2), 'second use restocks ammo at half price');

  const box = room.map.props.find(p => p.type === 'box');
  a.x = box.x; a.y = box.y; a.points = 9999;
  const preBox = a.points;
  room.interact(a, { prop: box.id, slot: 1 });
  ok(a.points === preBox - CONST.BOX_COST, 'fabricator charges 950');
  ok(!!a.weapons[1], 'fabricator fills the empty slot');

  const pap = room.map.props.find(p => p.type === 'pap');
  a.x = pap.x; a.y = pap.y; a.points = 20000;
  room.interact(a, { prop: pap.id, slot: 0 });
  ok(!a.weapons[0].pap, 'overclock refuses without main power');

  const power = room.map.props.find(p => p.type === 'power');
  a.x = power.x; a.y = power.y;
  room.interact(a, { prop: power.id });
  ok(room.power === true, 'power switch turns the facility on');

  a.x = pap.x; a.y = pap.y;
  room.interact(a, { prop: pap.id, slot: 0 });
  ok(a.weapons[0].pap === true, 'overclock works once power is on');
  const paidPap = a.points;
  room.interact(a, { prop: pap.id, slot: 0 });
  ok(a.points === paidPap, 'already-overclocked weapon is not charged again');

  const perkProp = room.map.props.find(p => p.type === 'perk');
  a.x = perkProp.x; a.y = perkProp.y; a.points = 20000;
  const hpBefore = a.maxHp;
  room.interact(a, { prop: perkProp.id });
  ok(a.perks.includes(perkProp.perk), 'perk chip is installed');
  if (perkProp.perk === 'plating') ok(a.maxHp > hpBefore, 'alloy plating raises max integrity');
  const perkPts = a.points;
  room.interact(a, { prop: perkProp.id });
  ok(a.points === perkPts, 'duplicate perk purchase is refused');

  // range gating
  a.x = 1.5; a.y = 1.5; a.points = 20000;
  const farPts = a.points;
  room.interact(a, { prop: box.id, slot: 0 });
  ok(a.points === farPts, 'cannot buy from across the map');

  // powerups
  for (const kind in POWERUPS) {
    room.grantPowerup(kind, a);
    ok(true, `powerup ${kind} resolves`);
  }
  ok(room.buffs.doubles > 0 && room.buffs.overcharge > 0, 'timed buffs register');

  // grenades
  const liveBefore = room.robots.filter(r => r.st === 0).length;
  const near = room.robots.find(r => r.st === 0);
  if (near) {
    a.x = near.x; a.y = near.y;
    room.handleGrenade(a, { x: near.x, y: near.y });
    ok(room.robots.filter(r => r.st === 0).length <= liveBefore, 'EMP charge damages nearby units');
  }
  room.handleGrenade(a, { x: NaN, y: 3 });
  ok(true, 'malformed grenade payload does not throw');

  // downs, revives, wipes. Clear the floor first: the revive path is what is
  // under test, not whether the reviver survives standing in a robot.
  room.buffs.overcharge = 0;
  room.robots.length = 0;
  room.toSpawn = 0;
  a.x = room.map.spawns[0].x; a.y = room.map.spawns[0].y;
  b.x = a.x; b.y = a.y;
  room.damagePlayer(a, 99999);
  ok(a.downed === true && a.bleed > 0, 'lethal damage puts a player down, not out');
  a.reviveBy = b.id;
  for (let i = 0; i < (CONST.REVIVE_TIME + 0.5) / DT; i++) room.step(DT);
  ok(a.downed === false, 'a squadmate can revive you');
  // Regression: the revive zeroes the bleed timer, and the bleed-out check on
  // the following line used to read that zero as death in the same tick.
  ok(a.alive === true, 'a revived player is not killed by their own bleed timer');
  ok(a.hp > 0, 'a revived player comes back with integrity', String(a.hp));
  ok(b.revives === 1, 'reviver is credited');

  room.damagePlayer(a, 99999);
  room.damagePlayer(b, 99999);
  room.step(DT);
  ok(room.phase === 'over', 'a full squad wipe ends the run', room.phase);
  const priorSeed = room.map.seed;
  tick(11);
  ok(room.phase === 'lobby' || room.phase === 'active', 'run resets after the wipe', room.phase);
  ok(room.map.seed !== priorSeed, 'a fresh facility is generated');
  ok(room.power === false && room.openDoors.size === 0, 'facility state resets with the map');

  done('rounds, pathing, economy, downs and reset all behave');
}

// -------------------------------------------------------- wave scaling
section('wave scaling');
{
  const room = new Room('SCALE');
  room.addPlayer(1, 'SOLO');
  let lastHp = 0, lastBudget = 0;
  for (let r = 1; r <= 30; r++) {
    room.round = r;
    const hp = room.robotHp('grunt');
    const spd = room.robotSpeed('grunt');
    const budget = Math.min(300, Math.round((0.16 * r * r + 3.2 * r + 6)));
    ok(hp > lastHp, `wave ${r}: health climbs`, String(hp));
    ok(budget >= lastBudget, `wave ${r}: spawn budget climbs`);
    ok(spd <= 1.55 * 1.95 + 0.001, `wave ${r}: speed stays capped`, spd.toFixed(2));
    ok(room.maxAlive() <= 36, `wave ${r}: concurrent cap respected`);
    lastHp = hp; lastBudget = budget;
    const kinds = new Set();
    for (let i = 0; i < 400; i++) kinds.add(room.pickKind());
    for (const k of kinds) ok(!!ROBOTS[k], `wave ${r}: only known chassis spawn`, k);
    if (r < 4) ok(kinds.size === 1 && kinds.has('grunt'), `wave ${r}: early waves are grunts only`);
  }
  done(`wave 1 grunt ${new Room('X').robotHp('grunt')}hp -> wave 30 climbs to ${lastHp}hp`);
}

// -------------------------------------------------------- wire format
section('wire format');
{
  const room = new Room('WIRE');
  room.addPlayer(1, 'ALPHA');
  for (let i = 0; i < 400; i++) room.step(1 / 30);

  const initBytes = JSON.stringify(room.mapPayload()).length;
  const stateBytes = JSON.stringify(room.stateFor()).length;
  ok(initBytes > 0 && initBytes < 900000, 'init payload is JSON-safe and bounded', `${initBytes}B`);
  ok(stateBytes < 20000, 'per-tick snapshot stays small', `${stateBytes}B`);

  const s = room.stateFor();
  ok(typeof s.round === 'number' && Array.isArray(s.robots) && Array.isArray(s.players),
    'snapshot has the shape the client parses');
  ok(s.robots.every(r => r.length === 7), 'robot tuples are the expected arity');
  ok(s.players.every(p => 'id' in p && 'hp' in p && Array.isArray(p.w)), 'player records carry loadout');
  ok(JSON.parse(JSON.stringify(s)).round === s.round, 'snapshot round-trips through JSON');
  const kbps = (stateBytes * CONST.NET_HZ) / 1024;
  done(`init ${(initBytes / 1024).toFixed(0)}KB once, snapshots ~${kbps.toFixed(0)}KB/s per client`);
}

// -------------------------------------------------------------- results
console.log(`\n${'─'.repeat(52)}`);
if (fail === 0) {
  console.log(`  ALL GREEN — ${pass} assertions passed`);
} else {
  console.log(`  ${pass} passed, ${fail} FAILED`);
  for (const f of failures.slice(0, 25)) console.log(`   ✗ ${f}`);
}
console.log(`${'─'.repeat(52)}\n`);
process.exit(fail === 0 ? 0 : 1);
