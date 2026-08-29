'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Room } = require('./game');
const { CONST } = require('../shared/weapons');

const PORT = process.env.PORT || 4180;
const app = express();

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
// three.js is served from node_modules: the whole build dir, because the module
// entry point imports ./three.core.min.js as a sibling.
app.use('/vendor', express.static(path.join(__dirname, '..', 'node_modules', 'three', 'build'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=86400')
}));

app.get('/api/rooms', (_req, res) => {
  res.json([...rooms.entries()].map(([code, r]) => ({
    code, players: r.players.size, round: r.round, phase: r.phase
  })));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** @type {Map<string, Room>} */
const rooms = new Map();
let nextId = 1;

function getRoom(code) {
  const key = (code || 'ALPHA').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'ALPHA';
  if (!rooms.has(key)) rooms.set(key, new Room(key));
  return rooms.get(key);
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let room = null;
  let player = null;
  const id = nextId++;

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'join') {
      if (player) return;
      room = getRoom(msg.room);
      const name = String(msg.name || 'OPERATOR').replace(/[^\w \-\.]/g, '').slice(0, 14).toUpperCase() || 'OPERATOR';
      player = room.addPlayer(id, name);
      ws.roomCode = room.code;
      ws.pid = id;
      send(ws, { t: 'init', you: id, room: room.code, map: room.mapPayload(), state: room.stateFor() });
      return;
    }

    if (!room || !player) return;

    switch (msg.t) {
      case 'in': {
        if (typeof msg.x === 'number' && isFinite(msg.x)) {
          // Loose sanity clamp: teleporting is possible but bounded to the map.
          player.x = Math.max(0.3, Math.min(room.map.w - 0.3, msg.x));
          player.y = Math.max(0.3, Math.min(room.map.h - 0.3, msg.y));
          player.a = +msg.a || 0;
          player.slot = msg.s | 0;
        }
        break;
      }
      case 'fire':   room.handleFire(player, msg); break;
      case 'nade':   room.handleGrenade(player, msg); break;
      case 'act':    room.interact(player, msg); break;
      case 'rev': {
        const tgt = room.players.get(msg.id);
        if (tgt && tgt.downed && Math.hypot(tgt.x - player.x, tgt.y - player.y) < 2.0) tgt.reviveBy = player.id;
        break;
      }
      case 'revstop': {
        for (const p of room.players.values()) if (p.reviveBy === player.id) p.reviveBy = null;
        break;
      }
      case 'chat': {
        const text = String(msg.text || '').slice(0, 90);
        if (text.trim()) room.pushEvent({ kind: 'chat', from: player.name, text });
        break;
      }
      case 'ping': send(ws, { t: 'pong', c: msg.c }); break;
    }
  });

  ws.on('close', () => {
    if (room && player) room.removePlayer(player.id);
  });
  ws.on('error', () => {});
});

// ---------------------------------------------------------------- main loop
const TICK_MS = 1000 / 60;
let last = Date.now();
let netAcc = 0;
const NET_MS = 1000 / CONST.NET_HZ;

setInterval(() => {
  const now = Date.now();
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;

  for (const room of rooms.values()) {
    room.tickN++;
    room.step(dt);
  }

  netAcc += dt * 1000;
  if (netAcc < NET_MS) return;
  netAcc = 0;

  const payloads = new Map();
  for (const [code, room] of rooms) {
    payloads.set(code, JSON.stringify(room.stateFor()));
  }

  for (const ws of wss.clients) {
    if (ws.readyState !== 1 || !ws.roomCode) continue;
    const p = payloads.get(ws.roomCode);
    if (p) ws.send(p);
  }

  for (const room of rooms.values()) {
    if (!room.events.length) continue;
    // A facility regen invalidates every client's copy of the map: re-init them.
    if (room.events.some(e => e.kind === 'newmap')) {
      for (const ws of wss.clients) {
        if (ws.readyState !== 1 || ws.roomCode !== room.code) continue;
        send(ws, { t: 'init', you: ws.pid, room: room.code, map: room.mapPayload(), state: room.stateFor() });
      }
    }
    for (const ev of room.events) {
      const str = JSON.stringify(ev);
      for (const ws of wss.clients) {
        if (ws.readyState !== 1 || ws.roomCode !== room.code) continue;
        if (ev.only !== undefined && ws.pid !== ev.only) continue;
        ws.send(str);
      }
    }
    room.events.length = 0;
  }
}, TICK_MS);

// drop dead sockets
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 15000);

// garbage-collect empty rooms (keep the default one warm)
setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.players.size === 0 && code !== 'ALPHA') rooms.delete(code);
  }
}, 60000);

server.listen(PORT, () => {
  console.log(`\n  PULSAR PROTOCOL // facility online`);
  console.log(`  http://localhost:${PORT}\n`);
});
