'use strict';
/*
 * Scalability benchmark: how many 4-player lobbies fit on one server process?
 *
 * The server runs every room in a single 60Hz loop, so the hard limit is the
 * total simulation cost per tick against a 16.67ms budget. This measures that
 * directly, plus serialisation cost, memory and outbound bandwidth.
 *
 *   node test/bench.js [playersPerRoom] [roomCounts...]
 */

const { Room } = require('../server/game');
const { CONST } = require('../shared/weapons');

const PLAYERS = Number(process.argv[2]) || 4;
const COUNTS = process.argv.slice(3).map(Number).filter(Boolean);
const ROOM_COUNTS = COUNTS.length ? COUNTS : [1, 5, 10, 20, 40, 80, 120];
const TICK_MS = 1000 / 60;
const NET_HZ = CONST.NET_HZ;
const ROUND = 12;               // a busy round: robots at the concurrent cap

function buildRooms(n) {
  const rooms = [];
  for (let i = 0; i < n; i++) {
    const r = new Room('BENCH' + i);
    for (let p = 1; p <= PLAYERS; p++) r.addPlayer(p, 'P' + p);
    r.startRound(ROUND);
    rooms.push(r);
  }
  // spin up until the robot population is at steady state
  for (let i = 0; i < 900; i++) {
    for (const r of rooms) {
      r.step(1 / 60);
      for (const p of r.players.values()) { p.hp = p.maxHp; p.downed = false; p.alive = true; }
    }
  }
  return rooms;
}

function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }

function bench(n) {
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  const rooms = buildRooms(n);
  const after = process.memoryUsage().heapUsed;

  let robots = 0;
  for (const r of rooms) robots += r.robots.length;

  // --- simulation cost: one 60Hz tick across every room
  const simSamples = [];
  for (let i = 0; i < 220; i++) {
    const t0 = process.hrtime.bigint();
    for (const r of rooms) r.step(1 / 60);
    const t1 = process.hrtime.bigint();
    simSamples.push(Number(t1 - t0) / 1e6);
    for (const r of rooms) for (const p of r.players.values()) { p.hp = p.maxHp; p.downed = false; p.alive = true; }
  }

  // --- serialisation cost: what the 20Hz broadcast pass costs
  const netSamples = [];
  let bytes = 0;
  for (let i = 0; i < 60; i++) {
    const t0 = process.hrtime.bigint();
    let total = 0;
    for (const r of rooms) total += JSON.stringify(r.stateFor()).length;
    const t1 = process.hrtime.bigint();
    netSamples.push(Number(t1 - t0) / 1e6);
    bytes = total;
  }

  const sim = median(simSamples);
  const net = median(netSamples);
  // per 60Hz tick: sim every tick, serialisation on 1 tick in 3
  const perTick = sim + net * (NET_HZ / 60);
  const outKBs = (bytes * NET_HZ * PLAYERS) / 1024;

  return {
    rooms: n,
    players: n * PLAYERS,
    robots,
    simMs: sim,
    netMs: net,
    perTickMs: perTick,
    budgetPct: (perTick / TICK_MS) * 100,
    memMB: (after - before) / 1048576,
    outMBs: outKBs / 1024
  };
}

console.log(`\nPulsar Protocol — lobby scalability`);
console.log(`${PLAYERS} players per lobby, wave ${ROUND}, 60Hz tick (${TICK_MS.toFixed(2)}ms budget)`);
console.log(`node ${process.version} on ${process.platform}/${process.arch}, ${require('os').cpus()[0].model.trim()}\n`);

const head = ['lobbies', 'players', 'robots', 'sim ms', 'json ms', 'per tick', '% budget', 'mem MB', 'net MB/s'];
console.log(head.map((h, i) => h.padStart(i === 0 ? 7 : 9)).join(' '));
console.log('-'.repeat(88));

const rows = [];
for (const n of ROOM_COUNTS) {
  const r = bench(n);
  rows.push(r);
  console.log([
    String(r.rooms).padStart(7),
    String(r.players).padStart(9),
    String(r.robots).padStart(9),
    r.simMs.toFixed(2).padStart(9),
    r.netMs.toFixed(2).padStart(9),
    r.perTickMs.toFixed(2).padStart(9),
    (r.budgetPct.toFixed(0) + '%').padStart(9),
    r.memMB.toFixed(0).padStart(9),
    r.outMBs.toFixed(2).padStart(9)
  ].join(' '));
}

// extrapolate the ceiling from the largest sample that still fit
const ref = rows[rows.length - 1];
const perRoomMs = ref.perTickMs / ref.rooms;
const perRoomMem = ref.memMB / ref.rooms;
const perRoomNet = ref.outMBs / ref.rooms;

console.log('\nper lobby:');
console.log(`  cpu     ${perRoomMs.toFixed(3)} ms of each 16.67ms tick`);
console.log(`  memory  ${perRoomMem.toFixed(1)} MB`);
console.log(`  upload  ${perRoomNet.toFixed(2)} MB/s`);

const at100 = Math.floor(TICK_MS / perRoomMs);
const at70 = Math.floor((TICK_MS * 0.7) / perRoomMs);
const at50 = Math.floor((TICK_MS * 0.5) / perRoomMs);
console.log('\nceiling on one process:');
console.log(`  ${at50} lobbies (${at50 * PLAYERS} players) at 50% tick budget — comfortable`);
console.log(`  ${at70} lobbies (${at70 * PLAYERS} players) at 70% tick budget — practical limit`);
console.log(`  ${at100} lobbies (${at100 * PLAYERS} players) saturates the tick — ticks start slipping`);
console.log(`  upload at the practical limit: ${(at70 * perRoomNet).toFixed(1)} MB/s ` +
            `(${(at70 * perRoomNet * 8).toFixed(0)} Mbit/s)\n`);
