'use strict';
/*
 * Two-client integration test over real WebSockets against a real server
 * instance. Spawns its own server on a scratch port, so it never touches a
 * dev server you have running.
 *
 *   node test/net.js
 */

const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const WebSocket = require('ws');

let PORT = 0;
const ROOT = path.join(__dirname, '..');

/* Ask the OS for a free port rather than hard-coding one: a previous run whose
   server outlived it would otherwise make this suite fail on EADDRINUSE. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`   ok   ${label}`); return true; }
  fail++;
  failures.push(label + (detail ? ` — ${detail}` : ''));
  console.log(`   FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  return false;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* A scripted client that records every state snapshot and event it receives. */
class Client {
  constructor(name) {
    this.name = name;
    this.id = null;
    this.map = null;
    this.state = null;
    this.events = [];
    this.states = 0;
  }
  connect(room) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      const timer = setTimeout(() => reject(new Error(`${this.name} join timed out`)), 8000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'join', name: this.name, room })));
      this.ws.on('message', (buf) => {
        const m = JSON.parse(buf.toString());
        if (m.t === 'init') {
          this.id = m.you; this.map = m.map; this.state = m.state;
          clearTimeout(timer); resolve(this);
        } else if (m.t === 'state') {
          this.state = m; this.states++;
        } else if (m.t === 'ev') {
          this.events.push(m);
        }
      });
      this.ws.on('error', reject);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  moveTo(x, y, a) { this.send({ t: 'in', x, y, a: a || 0, s: 0 }); }
  me() { return this.state.players.find(p => p.id === this.id); }
  close() { this.ws.close(); }
}

(async function main() {
  PORT = await freePort();
  console.log('\n── booting a scratch server on port ' + PORT);
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let booted = false, bootLog = '';
  server.stdout.on('data', d => { if (d.toString().includes('localhost')) booted = true; });
  server.stderr.on('data', d => { bootLog += d.toString(); console.log('   [server] ' + d.toString().trim()); });

  const shutdown = () => { try { server.kill(); } catch {} };
  process.on('exit', shutdown);

  for (let i = 0; i < 60 && !booted; i++) await sleep(100);
  if (!ok(booted, 'server boots and reports a listen address',
          bootLog.trim().split('\n')[0] || 'no output')) {
    server.kill();
    console.log('\n  aborting: the scratch server never came up\n');
    process.exit(1);
  }

  try {
    // ---------------------------------------------------------- handshake
    console.log('\n── handshake');
    const A = await new Client('ALPHA').connect('NETTEST');
    const B = await new Client('BRAVO').connect('NETTEST');
    ok(A.id !== null && B.id !== null, 'both clients receive an identity');
    ok(A.id !== B.id, 'identities are distinct', `${A.id} vs ${B.id}`);
    ok(A.map.seed === B.map.seed, 'both clients get the same facility');
    ok(A.map.w === 96 && A.map.h === 72, 'facility is 96x72', `${A.map.w}x${A.map.h}`);
    ok(A.map.zones.length === 12, 'facility has 12 sectors');
    ok(A.map.grid.length === 96 * 72, 'grid payload is complete');
    ok(A.map.doors.length > 0 && A.map.props.length > 0, 'doors and props are shipped to clients');

    await sleep(400);
    ok(A.state.players.length === 2, 'client A sees both operators', String(A.state.players.length));
    ok(B.state.players.some(p => p.n === 'ALPHA'), 'client B sees ALPHA by name');

    // ------------------------------------------------------- state stream
    console.log('\n── state stream');
    A.states = 0;
    await sleep(1000);
    ok(A.states >= 14 && A.states <= 26, 'snapshots arrive at roughly 20Hz', `${A.states}/s`);

    const spawn0 = A.map.spawns[0];
    A.moveTo(spawn0.x + 2, spawn0.y + 1, 1.2);
    await sleep(300);
    ok(Math.abs(A.me().x - (spawn0.x + 2)) < 0.01, 'position updates round-trip');
    const aSeenByB = B.state.players.find(p => p.id === A.id);
    ok(aSeenByB && Math.abs(aSeenByB.x - (spawn0.x + 2)) < 0.01, 'movement replicates to the other client');

    // -------------------------------------------------------------- combat
    console.log('\n── combat and economy');
    for (let i = 0; i < 90 && (!A.state.robots || A.state.robots.length === 0); i++) await sleep(100);
    ok(A.state.robots.length > 0, 'wave 1 spawns robots', String(A.state.robots.length));
    ok(A.state.round === 1, 'server reports wave 1', String(A.state.round));

    const before = A.me().pt;
    const cheapest = A.map.doors.reduce((m, d) => (d.cost < m.cost ? d : m), A.map.doors[0]);
    // Farm until the cheapest door is affordable. Waves run out and the server
    // sits in intermission for 9s, so this needs a time budget, not a try count.
    let killed = 0;
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline && A.me().pt < cheapest.cost + 60) {
      const live = A.state.robots.filter(r => r[4] === 0);
      if (!live.length) { await sleep(250); continue; }
      const r = live[0];
      A.moveTo(r[1], r[2], 0);          // stand on it so the range check passes
      await sleep(80);
      A.send({ t: 'fire', hits: [[r[0], 300000, 1]] });
      killed++;
      await sleep(110);
    }
    ok(killed > 0, 'robots were engaged', `${killed} kill reports`);
    ok(A.me().pt > before, 'kills pay credits', `${before} -> ${A.me().pt}`);
    ok(A.me().k > 0, 'kills are tracked on the player record', String(A.me().k));
    const bSeesA = B.state.players.find(p => p.id === A.id);
    ok(bSeesA.pt === A.me().pt, "credits replicate to the squad view");

    // cheating attempts are rejected
    const guard = A.me().pt;
    A.send({ t: 'fire', hits: [[123456789, 999999, 1]] });
    A.send({ t: 'fire', hits: 'garbage' });
    A.send({ t: 'act', prop: 9999 });
    A.send({ t: 'act', door: -1 });
    A.send({ t: 'nade', x: 'x', y: null });
    await sleep(400);
    ok(A.me().pt === guard, 'bogus hit reports pay nothing');
    ok(A.ws.readyState === 1, 'malformed payloads do not drop the connection');

    // ---------------------------------------------------------- purchases
    console.log('\n── purchases');
    const door = cheapest;
    A.moveTo(door.x, door.y, 0);
    await sleep(200);
    A.events.length = 0; B.events.length = 0;

    // force a refusal by draining credits below the door cost
    if (A.me().pt >= door.cost) {
      // buy it outright instead, then test refusal on a second, pricier door
      A.send({ t: 'act', door: door.id });
      await sleep(400);
      ok(A.state.doors.includes(door.id), 'affordable door opens', JSON.stringify(A.state.doors));
      ok(B.state.doors.includes(door.id), 'door state replicates to the squad');

      const pricey = A.map.doors.find(d => !A.state.doors.includes(d.id) && d.cost > A.me().pt);
      if (pricey) {
        A.moveTo(pricey.x, pricey.y, 0);
        await sleep(200);
        A.events.length = 0; B.events.length = 0;
        A.send({ t: 'act', door: pricey.id });
        await sleep(400);
        ok(A.events.some(e => e.kind === 'deny'), 'unaffordable door is refused');
        ok(!B.events.some(e => e.kind === 'deny'), 'refusal is private to the buyer');
      } else ok(true, 'no pricier door available to test refusal against');
    } else {
      A.send({ t: 'act', door: door.id });
      await sleep(400);
      ok(!A.state.doors.includes(door.id), 'unaffordable door stays shut');
      ok(A.events.some(e => e.kind === 'deny'), 'unaffordable door is refused');
      ok(!B.events.some(e => e.kind === 'deny'), 'refusal is private to the buyer');
    }

    // ------------------------------------------------------------- chat
    console.log('\n── chat and presence');
    B.events.length = 0;
    A.send({ t: 'chat', text: 'moving to the fabricator' });
    await sleep(400);
    const chat = B.events.find(e => e.kind === 'chat');
    ok(!!chat, 'chat reaches the other client');
    ok(chat && chat.from === 'ALPHA' && chat.text.includes('fabricator'), 'chat carries sender and text');

    A.events.length = 0;
    B.close();
    await sleep(600);
    ok(A.state.players.length === 1, 'disconnect removes the player from the room',
      String(A.state.players.length));
    ok(A.events.some(e => e.kind === 'msg' && /disconnect/i.test(e.text)),
      'disconnect is announced to the squad');

    A.close();
    await sleep(300);
  } catch (e) {
    fail++;
    failures.push('threw: ' + e.message);
    console.log('   FAIL exception — ' + e.message);
  }

  server.kill();
  await sleep(300);

  console.log(`\n${'─'.repeat(52)}`);
  if (fail === 0) console.log(`  ALL GREEN — ${pass} network assertions passed`);
  else {
    console.log(`  ${pass} passed, ${fail} FAILED`);
    for (const f of failures) console.log(`   x ${f}`);
  }
  console.log(`${'─'.repeat(52)}\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
