'use strict';
/*
 * Authoritative game room. The server owns the facility, the robots, the round
 * counter and the credit economy. Clients own their own aim/movement and report
 * hits, which the server sanity-checks before applying (co-op PvE, so trust is
 * cheap and latency-free shooting matters more than anti-cheat).
 */

const { generateMap, FACILITIES, FACILITY_LIST } = require('./mapgen');
const { WEAPONS, BOX_POOL, PERKS, ROBOTS, POWERUPS, CONST, statsFor } = require('../shared/weapons');

let nextRobotId = 1;
let nextPickupId = 1;

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();
    this.lastFacility = -1;
    this.map = this.rollFacility();
    this.reset(true);
    this.tickN = 0;
    this.acc = 0;
    this.lastNet = 0;
  }

  /* Pick a facility at random, never the same one twice running. */
  rollFacility() {
    let idx = Math.floor(Math.random() * FACILITIES.length);
    if (FACILITIES.length > 1 && idx === this.lastFacility) {
      idx = (idx + 1 + Math.floor(Math.random() * (FACILITIES.length - 1))) % FACILITIES.length;
    }
    this.lastFacility = idx;
    return generateMap((Math.random() * 0xffffffff) >>> 0, idx);
  }

  reset(initial) {
    if (!initial) this.map = this.rollFacility();
    const m = this.map;
    this.robots = [];
    this.pickups = [];
    this.round = 0;
    this.phase = 'lobby';          // lobby | intermission | active | over
    this.phaseT = 0;
    this.toSpawn = 0;
    this.spawnTimer = 0;
    this.roundKills = 0;
    this.power = false;
    this.unlocked = new Set([m.start]);
    this.openDoors = new Set();
    this.buffs = { doubles: 0, overcharge: 0 };
    this.dropsThisRound = 0;
    this.lastDrop = 0;
    this.boxUses = 0;
    this.events = [];
    this.flow = new Map();
    this.flowTimer = 0;
    this.startedAt = Date.now();
    this.totalKills = 0;
    for (const p of this.players.values()) this.spawnPlayer(p);
  }

  // ---------------------------------------------------------------- players
  addPlayer(id, name) {
    const m = this.map;
    const idx = this.players.size % m.spawns.length;
    const p = {
      id, name: name || 'OPERATOR', idx,
      x: m.spawns[idx].x, y: m.spawns[idx].y, a: 0,
      hp: CONST.BASE_HP, maxHp: CONST.BASE_HP,
      points: 500, earned: 500, kills: 0, downs: 0, revives: 0,
      alive: true, downed: false, bleed: 0, revProg: 0, reviveBy: null,
      perks: [], weapons: [{ id: 'sidearm', pap: false }, null], slot: 0,
      lastHurt: 0, atkCd: 0, selfRevUsed: false, ready: false,
      connected: true, joinedRound: 0
    };
    this.players.set(id, p);
    this.pushEvent({ kind: 'msg', text: `${p.name} linked in`, tone: 'info' });
    if (this.phase !== 'lobby') { p.joinedRound = this.round; p.points = Math.max(500, 500 + this.round * 100); }
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.pushEvent({ kind: 'msg', text: `${p.name} disconnected`, tone: 'warn' });
    if (this.players.size === 0) this.reset(false);
  }

  spawnPlayer(p) {
    const m = this.map;
    const s = m.spawns[p.idx % m.spawns.length];
    p.x = s.x; p.y = s.y;
    p.hp = p.maxHp = CONST.BASE_HP * (p.perks.includes('plating') ? 2.5 : 1);
    p.alive = true; p.downed = false; p.bleed = 0; p.revProg = 0;
    p.selfRevUsed = false;
  }

  pushEvent(ev) { ev.t = 'ev'; this.events.push(ev); }

  // ------------------------------------------------------------------- map
  idx(x, y) { return y * this.map.w + x; }

  walkable(tx, ty) {
    const m = this.map;
    if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return false;
    const i = ty * m.w + tx;
    if (m.grid[i] !== 0) return false;
    const d = m.doorAt[i];
    if (d >= 0 && !this.openDoors.has(d)) return false;
    return true;
  }

  solidAt(x, y) { return !this.walkable(Math.floor(x), Math.floor(y)); }

  lineClear(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const steps = Math.ceil(Math.hypot(dx, dy) * 4);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (this.solidAt(x0 + dx * t, y0 + dy * t)) return false;
    }
    return true;
  }

  // -------------------------------------------------------------- pathfind
  rebuildFlow() {
    const m = this.map;
    this.flow.clear();
    for (const p of this.players.values()) {
      if (!p.alive || p.downed) continue;
      const dist = new Int32Array(m.w * m.h).fill(-1);
      const sx = Math.floor(p.x), sy = Math.floor(p.y);
      if (!this.walkable(sx, sy)) continue;
      const q = new Int32Array(m.w * m.h);
      let head = 0, tail = 0;
      dist[sy * m.w + sx] = 0;
      q[tail++] = sy * m.w + sx;
      while (head < tail) {
        const cur = q[head++];
        const cx = cur % m.w, cy = (cur / m.w) | 0;
        const d = dist[cur] + 1;
        if (d > 220) continue;
        for (let k = 0; k < 4; k++) {
          const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0);
          const ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (!this.walkable(nx, ny)) continue;
          const ni = ny * m.w + nx;
          if (dist[ni] >= 0) continue;
          dist[ni] = d;
          q[tail++] = ni;
        }
      }
      this.flow.set(p.id, dist);
    }
  }

  // ---------------------------------------------------------------- rounds
  livePlayers() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected && p.alive && !p.downed) n++;
    return n;
  }

  activeCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  startRound(n) {
    this.round = n;
    this.phase = 'active';
    this.roundKills = 0;
    this.dropsThisRound = 0;
    const pc = Math.max(1, this.activeCount());
    const base = 0.16 * n * n + 3.2 * n + 6;
    this.toSpawn = Math.min(300, Math.round(base * (1 + 0.5 * (pc - 1))));
    this.spawnTimer = 0.6;
    for (const p of this.players.values()) p.selfRevUsed = false;
    this.pushEvent({ kind: 'round', round: n, purge: n % 5 === 0 });
  }

  robotHp(kind) {
    const n = this.round;
    let base = n <= 9 ? 60 + 40 * (n - 1) : 420 * Math.pow(1.13, n - 9);
    return Math.round(base * ROBOTS[kind].hp);
  }

  robotSpeed(kind) {
    const spd = Math.min(1.95, 0.82 + this.round * 0.05);
    return 1.55 * spd * ROBOTS[kind].speed;
  }

  pickKind() {
    const n = this.round, r = Math.random();
    if (n % 5 === 0 && r < 0.34) return 'drone';
    if (n >= 10 && r < 0.12) return 'hunter';
    if (n >= 6 && r < 0.20) return 'titan';
    if (n >= 4 && r < 0.34) return 'drone';
    return 'grunt';
  }

  maxAlive() {
    return Math.min(36, 9 + Math.max(1, this.activeCount()) * 5 + Math.floor(this.round / 3));
  }

  spawnRobot() {
    const m = this.map;
    const targets = [...this.players.values()].filter(p => p.connected && p.alive && !p.downed);
    if (!targets.length) return;
    const ports = m.ports.filter(pt => this.unlocked.has(pt.zone));
    if (!ports.length) return;

    let best = null, bestScore = -Infinity;
    for (let i = 0; i < 14; i++) {
      const pt = ports[(Math.random() * ports.length) | 0];
      let near = Infinity;
      for (const t of targets) near = Math.min(near, Math.hypot(t.x - pt.x, t.y - pt.y));
      // Sweet spot: out of sight but still in the fight.
      const score = -Math.abs(near - 14) + (near > 6 ? 4 : -20) + Math.random() * 2;
      if (score > bestScore) { bestScore = score; best = pt; }
    }
    if (!best) return;

    const kind = this.pickKind();
    this.robots.push({
      id: nextRobotId++, kind,
      x: best.x, y: best.y, a: 0,
      hp: this.robotHp(kind), maxHp: this.robotHp(kind),
      speed: this.robotSpeed(kind), atkCd: 0, st: 0, dieT: 0,
      target: null, retarget: 0, stun: 0, wobble: Math.random() * 6.28
    });
    this.toSpawn--;
  }

  // ----------------------------------------------------------------- damage
  hurtRobot(r, dmg, byPlayer, headshot) {
    if (r.st !== 0) return 0;
    if (this.buffs.overcharge > 0) dmg = 1e9;
    r.hp -= dmg;
    r.stun = Math.max(r.stun, 0.06);
    let pts = CONST.HIT_POINTS;
    if (r.hp <= 0) {
      r.st = 1; r.dieT = 0.55;
      pts = ROBOTS[r.kind].score;
      if (headshot) pts += 30;
      this.roundKills++;
      this.totalKills++;
      if (byPlayer) byPlayer.kills++;
      this.maybeDrop(r);
    }
    if (byPlayer) {
      const mult = this.buffs.doubles > 0 ? 2 : 1;
      byPlayer.points += pts * mult;
      byPlayer.earned += pts * mult;
    }
    return pts;
  }

  maybeDrop(r) {
    const now = Date.now() / 1000;
    if (this.dropsThisRound >= 4) return;
    if (now - this.lastDrop < 10) return;
    if (Math.random() > 0.035) return;
    const keys = Object.keys(POWERUPS);
    const kind = keys[(Math.random() * keys.length) | 0];
    this.dropsThisRound++;
    this.lastDrop = now;
    this.pickups.push({ id: nextPickupId++, kind, x: r.x, y: r.y, life: 25 });
  }

  grantPowerup(kind, by) {
    const P = POWERUPS[kind];
    this.pushEvent({ kind: 'powerup', power: kind, name: P.name, by: by ? by.name : '' });
    if (kind === 'maxammo') {
      this.pushEvent({ kind: 'maxammo' });
    } else if (kind === 'emp') {
      let n = 0;
      for (const r of this.robots) {
        if (r.st === 0) { r.st = 1; r.dieT = 0.4; r.hp = 0; n++; this.roundKills++; this.totalKills++; }
      }
      if (by) { by.points += 400; by.earned += 400; }
      this.pushEvent({ kind: 'msg', text: `EMP SURGE — ${n} units fried`, tone: 'good' });
    } else if (kind === 'overcharge') {
      this.buffs.overcharge = 30;
    } else if (kind === 'doubles') {
      this.buffs.doubles = 30;
    } else if (kind === 'repair') {
      for (const p of this.players.values()) if (p.alive && !p.downed) p.hp = p.maxHp;
    }
  }

  // ---------------------------------------------------------------- economy
  recomputeMaxHp(p) {
    const wasPct = p.hp / p.maxHp;
    p.maxHp = CONST.BASE_HP * (p.perks.includes('plating') ? 2.5 : 1);
    p.hp = Math.min(p.maxHp, Math.max(1, p.maxHp * wasPct));
  }

  interact(p, msg) {
    if (!p.alive || p.downed) return;

    if (msg.door !== undefined) {
      const d = this.map.doors[msg.door];
      if (!d || this.openDoors.has(d.id)) return;
      const near = Math.hypot(p.x - d.x, p.y - d.y) < 3.2;
      if (!near) return;
      if (p.points < d.cost) { this.toPlayer(p, { kind: 'deny', text: `NEED ${d.cost} CREDITS` }); return; }
      p.points -= d.cost;
      this.openDoors.add(d.id);
      this.unlocked.add(d.a); this.unlocked.add(d.b);
      this.flowTimer = 0;
      this.pushEvent({ kind: 'door', id: d.id, by: p.name, zone: this.map.zones[d.b].name });
      return;
    }

    const prop = this.map.props[msg.prop];
    if (!prop) return;
    if (Math.hypot(p.x - prop.x, p.y - prop.y) > 2.6) return;

    if (prop.type === 'power') {
      if (this.power) return;
      this.power = true;
      this.pushEvent({ kind: 'power', by: p.name });
      return;
    }

    if (prop.type === 'wallbuy') {
      const slot = Math.max(0, Math.min(1, msg.slot | 0));
      const owned = p.weapons.findIndex(w => w && w.id === prop.weapon);
      if (owned >= 0) {
        const cost = Math.round(prop.cost / 2);
        if (p.points < cost) { this.toPlayer(p, { kind: 'deny', text: `NEED ${cost} CREDITS` }); return; }
        p.points -= cost;
        this.toPlayer(p, { kind: 'ammo', slot: owned });
      } else {
        if (p.points < prop.cost) { this.toPlayer(p, { kind: 'deny', text: `NEED ${prop.cost} CREDITS` }); return; }
        p.points -= prop.cost;
        const target = p.weapons[1] === null ? 1 : slot;
        p.weapons[target] = { id: prop.weapon, pap: false };
        this.toPlayer(p, { kind: 'grant', slot: target, weapon: prop.weapon, pap: false });
      }
      return;
    }

    if (prop.type === 'box') {
      if (p.points < CONST.BOX_COST) { this.toPlayer(p, { kind: 'deny', text: `NEED ${CONST.BOX_COST} CREDITS` }); return; }
      p.points -= CONST.BOX_COST;
      const roll = BOX_POOL[(Math.random() * BOX_POOL.length) | 0];
      const target = p.weapons[1] === null ? 1 : Math.max(0, Math.min(1, msg.slot | 0));
      p.weapons[target] = { id: roll, pap: false };
      this.toPlayer(p, { kind: 'grant', slot: target, weapon: roll, pap: false, box: true });
      this.pushEvent({ kind: 'msg', text: `${p.name} pulled ${WEAPONS[roll].name}`, tone: 'info' });
      this.boxUses++;
      if (this.boxUses >= 4 + ((Math.random() * 3) | 0) && prop.bays.length > 1) {
        this.boxUses = 0;
        prop.bay = (prop.bay + 1 + ((Math.random() * (prop.bays.length - 1)) | 0)) % prop.bays.length;
        prop.x = prop.bays[prop.bay].x; prop.y = prop.bays[prop.bay].y; prop.zone = prop.bays[prop.bay].zone;
        this.pushEvent({ kind: 'boxmove', x: prop.x, y: prop.y, zone: this.map.zones[prop.zone].name });
      }
      return;
    }

    if (prop.type === 'pap') {
      if (!this.power) { this.toPlayer(p, { kind: 'deny', text: 'MAIN POWER OFFLINE' }); return; }
      const slot = Math.max(0, Math.min(1, msg.slot | 0));
      const w = p.weapons[slot];
      if (!w) return;
      if (w.pap) { this.toPlayer(p, { kind: 'deny', text: 'ALREADY OVERCLOCKED' }); return; }
      if (p.points < CONST.PAP_COST) { this.toPlayer(p, { kind: 'deny', text: `NEED ${CONST.PAP_COST} CREDITS` }); return; }
      p.points -= CONST.PAP_COST;
      w.pap = true;
      this.toPlayer(p, { kind: 'grant', slot, weapon: w.id, pap: true, pap_fx: true });
      this.pushEvent({ kind: 'msg', text: `${p.name} overclocked a weapon`, tone: 'good' });
      return;
    }

    if (prop.type === 'perk') {
      const perk = PERKS[prop.perk];
      if (!perk) return;
      if (perk.power && !this.power) { this.toPlayer(p, { kind: 'deny', text: 'MAIN POWER OFFLINE' }); return; }
      if (p.perks.includes(perk.id)) { this.toPlayer(p, { kind: 'deny', text: 'CHIP ALREADY INSTALLED' }); return; }
      if (p.perks.length >= 4) { this.toPlayer(p, { kind: 'deny', text: 'SOCKETS FULL' }); return; }
      if (p.points < perk.cost) { this.toPlayer(p, { kind: 'deny', text: `NEED ${perk.cost} CREDITS` }); return; }
      p.points -= perk.cost;
      p.perks.push(perk.id);
      if (perk.id === 'plating') this.recomputeMaxHp(p);
      this.toPlayer(p, { kind: 'perk', perk: perk.id });
      return;
    }
  }

  toPlayer(p, ev) { ev.t = 'ev'; ev.only = p.id; this.events.push(ev); }

  // ------------------------------------------------------------------ tick
  step(dt) {
    // powerup timers
    if (this.buffs.doubles > 0) this.buffs.doubles -= dt;
    if (this.buffs.overcharge > 0) this.buffs.overcharge -= dt;

    // ---- phase machine
    if (this.phase === 'lobby') {
      if (this.activeCount() > 0) {
        this.phaseT += dt;
        if (this.phaseT > 5) { this.phaseT = 0; this.startRound(1); }
      } else this.phaseT = 0;
    } else if (this.phase === 'intermission') {
      this.phaseT -= dt;
      if (this.phaseT <= 0) this.startRound(this.round + 1);
    } else if (this.phase === 'active') {
      const aliveRobots = this.robots.filter(r => r.st === 0).length;
      if (this.toSpawn > 0) {
        this.spawnTimer -= dt;
        const interval = Math.max(0.22, 1.5 - this.round * 0.05) / Math.max(1, Math.min(4, this.activeCount()));
        if (this.spawnTimer <= 0 && aliveRobots < this.maxAlive()) {
          this.spawnRobot();
          this.spawnTimer = interval;
        }
      } else if (aliveRobots === 0 && this.robots.length === 0) {
        this.phase = 'intermission';
        this.phaseT = 9;
        this.pushEvent({ kind: 'cleared', round: this.round });
      }
    } else if (this.phase === 'over') {
      this.phaseT -= dt;
      if (this.phaseT <= 0) {
        for (const p of this.players.values()) {
          p.points = 500; p.earned = 500; p.kills = 0; p.downs = 0;
          p.perks = []; p.weapons = [{ id: 'sidearm', pap: false }, null];
        }
        this.reset(false);
        this.pushEvent({ kind: 'newmap' });
      }
    }

    // ---- squad wipe. Checked outside the phase machine so a player bleeding
    // out after the last robot dies still ends the run.
    if ((this.phase === 'active' || this.phase === 'intermission') &&
        this.activeCount() > 0 && this.livePlayers() === 0) {
      this.phase = 'over';
      this.phaseT = 10;
      this.pushEvent({
        kind: 'gameover', round: this.round, kills: this.totalKills,
        time: Math.round((Date.now() - this.startedAt) / 1000)
      });
    }

    // ---- flow field refresh
    this.flowTimer -= dt;
    if (this.flowTimer <= 0) { this.rebuildFlow(); this.flowTimer = 0.35; }

    // ---- players
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      if (p.downed) {
        p.bleed -= dt;
        // nearby squadmates reviving
        if (p.reviveBy) {
          const r = this.players.get(p.reviveBy);
          const ok = r && r.alive && !r.downed && Math.hypot(r.x - p.x, r.y - p.y) < 2.0;
          if (ok) {
            const speed = r.perks.includes('nano') ? 1.9 : 1;
            p.revProg += (dt / CONST.REVIVE_TIME) * speed;
            if (p.revProg >= 1) {
              p.downed = false; p.revProg = 0; p.bleed = 0;
              p.hp = p.maxHp * 0.6;
              r.revives++; r.points += 200; r.earned += 200;
              this.pushEvent({ kind: 'revive', who: p.name, by: r.name });
            }
          } else { p.reviveBy = null; p.revProg = Math.max(0, p.revProg - dt * 0.35); }
        } else if (p.revProg > 0) p.revProg = Math.max(0, p.revProg - dt * 0.35);

        // solo self-revive via Nanorepair
        if (this.activeCount() === 1 && p.perks.includes('nano') && !p.selfRevUsed && p.bleed < CONST.BLEEDOUT - 5) {
          p.selfRevUsed = true;
          p.downed = false; p.hp = p.maxHp * 0.5; p.bleed = 0; p.revProg = 0;
          this.pushEvent({ kind: 'msg', text: `${p.name} self-repaired`, tone: 'good' });
        }
        // Only a still-downed player can bleed out. A revive earlier in this
        // same tick zeroes the timer on purpose, and must not be read as death.
        if (p.downed && p.bleed <= 0) { p.bleed = 0; p.alive = false; }
        continue;
      }
      if (!p.alive) continue;
      if (p.hp < p.maxHp && (Date.now() / 1000 - p.lastHurt) > CONST.REGEN_DELAY) {
        p.hp = Math.min(p.maxHp, p.hp + CONST.REGEN_RATE * dt);
      }
    }

    // ---- pickups
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pk = this.pickups[i];
      pk.life -= dt;
      let taken = null;
      for (const p of this.players.values()) {
        if (!p.alive || p.downed) continue;
        if (Math.hypot(p.x - pk.x, p.y - pk.y) < 1.3) { taken = p; break; }
      }
      if (taken) { this.grantPowerup(pk.kind, taken); this.pickups.splice(i, 1); }
      else if (pk.life <= 0) this.pickups.splice(i, 1);
    }

    // ---- robots
    const targets = [...this.players.values()].filter(p => p.connected && p.alive && !p.downed);
    for (let i = this.robots.length - 1; i >= 0; i--) {
      const r = this.robots[i];
      if (r.st === 1) {
        r.dieT -= dt;
        if (r.dieT <= 0) this.robots.splice(i, 1);
        continue;
      }
      if (r.stun > 0) r.stun -= dt;
      r.atkCd -= dt;
      r.retarget -= dt;

      if (!r.target || r.retarget <= 0 || !targets.some(t => t.id === r.target)) {
        let best = null, bd = Infinity;
        for (const t of targets) {
          const d = Math.hypot(t.x - r.x, t.y - r.y);
          if (d < bd) { bd = d; best = t; }
        }
        r.target = best ? best.id : null;
        r.retarget = 1.5 + Math.random();
      }
      const tgt = r.target ? this.players.get(r.target) : null;
      if (!tgt || !tgt.alive || tgt.downed) continue;

      const dToT = Math.hypot(tgt.x - r.x, tgt.y - r.y);
      let dx = 0, dy = 0;

      if (dToT < 12 && this.lineClear(r.x, r.y, tgt.x, tgt.y)) {
        dx = tgt.x - r.x; dy = tgt.y - r.y;
      } else {
        const field = this.flow.get(tgt.id);
        const m = this.map;
        const cx = Math.floor(r.x), cy = Math.floor(r.y);
        if (field) {
          let bestD = Infinity, bx = 0, by = 0;
          for (let k = 0; k < 8; k++) {
            const ox = [1, -1, 0, 0, 1, 1, -1, -1][k];
            const oy = [0, 0, 1, -1, 1, -1, 1, -1][k];
            const nx = cx + ox, ny = cy + oy;
            if (!this.walkable(nx, ny)) continue;
            if (ox && oy && (!this.walkable(cx + ox, cy) || !this.walkable(cx, cy + oy))) continue;
            const v = field[ny * m.w + nx];
            if (v < 0) continue;
            if (v < bestD) { bestD = v; bx = nx; by = ny; }
          }
          if (bestD < Infinity) { dx = (bx + 0.5) - r.x; dy = (by + 0.5) - r.y; }
          else { dx = tgt.x - r.x; dy = tgt.y - r.y; }
        } else { dx = tgt.x - r.x; dy = tgt.y - r.y; }
      }

      let len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;

      // separation so packs flow around each other instead of stacking
      let sx = 0, sy = 0;
      for (const o of this.robots) {
        if (o === r || o.st !== 0) continue;
        const ddx = r.x - o.x, ddy = r.y - o.y;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 > 0.0001 && d2 < 1.1) { const d = Math.sqrt(d2); sx += ddx / d / d; sy += ddy / d / d; }
      }
      dx += sx * 0.30; dy += sy * 0.30;
      r.wobble += dt * 4;
      len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;

      const spd = r.speed * (r.stun > 0 ? 0.45 : 1) * dt;
      const rad = ROBOTS[r.kind].radius;
      const nx = r.x + dx * spd, ny = r.y + dy * spd;
      if (!this.collides(nx, r.y, rad)) r.x = nx;
      if (!this.collides(r.x, ny, rad)) r.y = ny;
      r.a = Math.atan2(dy, dx);

      if (dToT < rad + CONST.PLAYER_RADIUS + 0.42 && r.atkCd <= 0) {
        r.atkCd = 0.85;
        this.damagePlayer(tgt, ROBOTS[r.kind].dmg * (1 + this.round * 0.012));
      }
    }
  }

  collides(x, y, rad) {
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const tx = Math.floor(x + ox * rad), ty = Math.floor(y + oy * rad);
        if (!this.walkable(tx, ty)) return true;
      }
    }
    return false;
  }

  damagePlayer(p, dmg) {
    if (!p.alive || p.downed) return;
    p.hp -= dmg;
    p.lastHurt = Date.now() / 1000;
    if (p.hp <= 0) {
      p.hp = 0;
      p.downed = true;
      p.downs++;
      p.bleed = CONST.BLEEDOUT;
      p.revProg = 0;
      p.points = Math.max(0, Math.round(p.points * 0.7));
      this.pushEvent({ kind: 'down', who: p.name, id: p.id });
    }
  }

  // --------------------------------------------------------------- shooting
  handleFire(p, msg) {
    if (!p.alive || p.downed) return;
    const hits = Array.isArray(msg.hits) ? msg.hits.slice(0, 24) : [];
    for (const h of hits) {
      const r = this.robots.find(rr => rr.id === h[0]);
      if (!r || r.st !== 0) continue;
      if (Math.hypot(r.x - p.x, r.y - p.y) > 95) continue;
      const dmg = Math.max(0, Math.min(300000, +h[1] || 0));
      this.hurtRobot(r, dmg, p, !!h[2]);
    }
  }

  handleGrenade(p, msg) {
    if (!p.alive || p.downed) return;
    const gx = +msg.x, gy = +msg.y;
    if (!isFinite(gx) || !isFinite(gy)) return;
    if (Math.hypot(gx - p.x, gy - p.y) > 30) return;
    this.pushEvent({ kind: 'boom', x: gx, y: gy, r: CONST.GRENADE_RADIUS });
    for (const r of this.robots) {
      if (r.st !== 0) continue;
      const d = Math.hypot(r.x - gx, r.y - gy);
      if (d > CONST.GRENADE_RADIUS) continue;
      const fall = 1 - (d / CONST.GRENADE_RADIUS) * 0.65;
      this.hurtRobot(r, CONST.GRENADE_DMG * fall * (1 + this.round * 0.16), p, false);
    }
  }

  // ------------------------------------------------------------ serialisation
  mapPayload() {
    const m = this.map;
    return {
      seed: m.seed, facility: m.facility, facilities: FACILITY_LIST, w: m.w, h: m.h,
      zoneCols: m.zoneCols, zoneRows: m.zoneRows, zoneW: m.zoneW, zoneH: m.zoneH,
      grid: m.grid, doorAt: m.doorAt, zoneAt: m.zoneAt,
      zones: m.zones, doors: m.doors, props: m.props, spawns: m.spawns,
      start: m.start, powerZone: m.powerZone, papZone: m.papZone
    };
  }

  stateFor() {
    const robots = [];
    for (const r of this.robots) {
      robots.push([r.id, +r.x.toFixed(2), +r.y.toFixed(2), r.kind[0], r.st, +r.a.toFixed(2),
        Math.max(0, Math.round((r.hp / r.maxHp) * 100))]);
    }
    const players = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id, n: p.name, x: +p.x.toFixed(2), y: +p.y.toFixed(2), a: +p.a.toFixed(2),
        hp: Math.round(p.hp), mx: Math.round(p.maxHp), pt: p.points, k: p.kills,
        dn: p.downed ? 1 : 0, al: p.alive ? 1 : 0, bl: +p.bleed.toFixed(1),
        rv: +p.revProg.toFixed(2), pk: p.perks, w: p.weapons, d: p.downs
      });
    }
    return {
      t: 'state',
      tick: this.tickN,
      round: this.round, phase: this.phase, phaseT: +this.phaseT.toFixed(1),
      left: this.robots.filter(r => r.st === 0).length + Math.max(0, this.toSpawn),
      power: this.power,
      doors: [...this.openDoors],
      box: (() => { const b = this.map.props.find(pr => pr.type === 'box'); return b ? [b.x, b.y] : null; })(),
      buffs: { d: Math.max(0, +this.buffs.doubles.toFixed(1)), o: Math.max(0, +this.buffs.overcharge.toFixed(1)) },
      pickups: this.pickups.map(p => [p.id, +p.x.toFixed(2), +p.y.toFixed(2), p.kind]),
      robots, players
    };
  }
}

module.exports = { Room };
