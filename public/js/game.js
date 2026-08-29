/* Pulsar Protocol — client sim, input, prediction, and the frame loop. */
(function () {
  'use strict';

  const S = window.SHARED;
  const C = S.CONST;
  const KIND = { g: 'grunt', d: 'drone', t: 'titan', h: 'hunter' };
  const EYE = 1.40;   // must match Renderer.EYE

  const G = {
    started: false,
    map: null, youId: null,
    cam: { x: 4, y: 4, a: 0, pitch: 0, fov: 1.22 },
    look: 0, bob: 0, bobPhase: 0, kick: 0, roll: 0, dt: 0.016,
    openDoors: new Set(), power: false, round: 0, left: 0, phase: 'lobby',
    zoneName: '', zoneDim: [],
    weapons: [null, null], slot: 0, nades: C.MAX_GRENADES,
    reloading: false, reloadT: 0, reloadTotal: 0, reloadProg: 0,
    fireCd: 0, triggerHeld: false, ads: false, adsT: 0,
    vm: { stats: null, swayX: 0, swayY: 0, tilt: 0, recoil: 0, flash: 0, reloadDip: 0 },
    time: 0, moving: false,
    robotsView: [], matesView: [], pickupsView: [], doorSigns: [],
    sparks: [], popups: [], projectiles: [],
    allPlayers: [], me: null,
    doublesT: 0, overchargeT: 0,
    robotFlash: new Map(), deathT: new Map(),
    stepDist: 0, lastHp: 100, chatOpen: false, sbOpen: false,
    denyUntil: 0, paused: false, perks: []
  };
  window.G = G;

  // ------------------------------------------------------------------ input
  const keys = Object.create(null);
  let mouseSens = 0.0022;

  function bindInput(canvas) {
    document.addEventListener('keydown', (e) => {
      if (G.chatOpen) {
        if (e.key === 'Enter') { sendChat(); e.preventDefault(); }
        else if (e.key === 'Escape') closeChat();
        return;
      }
      if (e.code === 'Enter' && G.started) { openChat(); e.preventDefault(); return; }
      keys[e.code] = true;
      if (e.code === 'Tab') { e.preventDefault(); G.sbOpen = true; HUD.scoreboard(true, G); }
      if (!G.started || G.paused) return;
      if (e.code === 'KeyR') startReload();
      if (e.code === 'KeyQ' || e.code === 'Digit1' || e.code === 'Digit2') swapWeapon(e.code);
      if (e.code === 'KeyG') throwGrenade();
      if (e.code === 'KeyF') interact();
    });
    document.addEventListener('keyup', (e) => {
      keys[e.code] = false;
      if (e.code === 'Tab') { G.sbOpen = false; HUD.scoreboard(false, G); }
      if (e.code === 'KeyF') Net.send({ t: 'revstop' });
    });
    window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; G.triggerHeld = false; });

    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === canvas) { closePause(false); return; }
      if (G.started && !G.chatOpen) openPause();
    });

    canvas.addEventListener('mousedown', (e) => {
      if (!G.started) return;
      if (document.pointerLockElement !== canvas) { closePause(true); return; }
      if (e.button === 0) G.triggerHeld = true;
      if (e.button === 2) G.ads = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) G.triggerHeld = false;
      if (e.button === 2) G.ads = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== canvas) return;
      const s = mouseSens * (G.ads ? 0.55 : 1);
      G.cam.a += e.movementX * s;
      G.look = Math.max(-1.35, Math.min(1.35, G.look - e.movementY * s));
    });
  }

  function openChat() {
    G.chatOpen = true;
    HUD.el.chatbox.classList.remove('hidden');
    HUD.el.chatInput.value = '';
    HUD.el.chatInput.focus();
  }
  function closeChat() {
    G.chatOpen = false;
    HUD.el.chatbox.classList.add('hidden');
    HUD.el.chatInput.blur();
    document.getElementById('view').requestPointerLock();
  }
  function sendChat() {
    const t = HUD.el.chatInput.value.trim();
    if (t) Net.send({ t: 'chat', text: t });
    closeChat();
  }

  // ------------------------------------------------------------------- map
  function blocked(x, y) {
    const m = G.map;
    const tx = Math.floor(x), ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return true;
    const i = ty * m.w + tx;
    if (m.grid[i] === 1) return true;
    const d = m.doorAt[i];
    if (d >= 0 && !G.openDoors.has(d)) return true;
    return false;
  }

  function collides(x, y, r) {
    return blocked(x - r, y - r) || blocked(x + r, y - r) ||
           blocked(x - r, y + r) || blocked(x + r, y + r);
  }

  /* DDA to the first solid tile; returns distance along the ray. */
  function wallDist(ox, oy, dx, dy, max) {
    let mapX = Math.floor(ox), mapY = Math.floor(oy);
    const ddx = dx === 0 ? 1e30 : Math.abs(1 / dx);
    const ddy = dy === 0 ? 1e30 : Math.abs(1 / dy);
    let stepX, stepY, sdx, sdy;
    if (dx < 0) { stepX = -1; sdx = (ox - mapX) * ddx; } else { stepX = 1; sdx = (mapX + 1 - ox) * ddx; }
    if (dy < 0) { stepY = -1; sdy = (oy - mapY) * ddy; } else { stepY = 1; sdy = (mapY + 1 - oy) * ddy; }
    let side = 0, guard = 0;
    while (guard++ < 300) {
      if (sdx < sdy) { sdx += ddx; mapX += stepX; side = 0; }
      else { sdy += ddy; mapY += stepY; side = 1; }
      const dist = side === 0 ? sdx - ddx : sdy - ddy;
      if (dist > max) return max;
      const m = G.map;
      if (mapX < 0 || mapY < 0 || mapX >= m.w || mapY >= m.h) return dist;
      const i = mapY * m.w + mapX;
      if (m.grid[i] === 1) return dist;
      const d = m.doorAt[i];
      if (d >= 0 && !G.openDoors.has(d)) return dist;
    }
    return max;
  }

  // -------------------------------------------------------------- weapons
  function makeWeapon(id, pap) {
    const stats = S.statsFor({ id, pap: !!pap });
    return { id, pap: !!pap, stats, mag: stats.mag, reserve: stats.reserve };
  }

  function currentWeapon() { return G.weapons[G.slot]; }

  /* Rebuild the viewmodel mesh only when the equipped weapon actually changes. */
  let vmKey = null;
  function syncWeaponModel() {
    const w = currentWeapon();
    if (!w) return;
    const key = w.id + (w.pap ? '+' : '');
    if (key === vmKey) return;
    vmKey = key;
    Renderer.setWeapon(w.stats);
  }

  function swapWeapon(code) {
    let target = G.slot;
    if (code === 'KeyQ') target = 1 - G.slot;
    else if (code === 'Digit1') target = 0;
    else target = 1;
    if (target === G.slot || !G.weapons[target]) return;
    G.slot = target;
    G.reloading = false;
    G.fireCd = Math.max(G.fireCd, 0.42);
    G.vm.reloadDip = 0.7;
    G.vm.stats = G.weapons[G.slot].stats;
  }

  function startReload() {
    const w = currentWeapon();
    if (!w || G.reloading) return;
    if (w.mag >= w.stats.mag || w.reserve <= 0) return;
    G.reloading = true;
    G.reloadTotal = w.stats.reload / (G.perks.includes('reload') ? 2 : 1);
    G.reloadT = G.reloadTotal;
  }

  function finishReload() {
    const w = currentWeapon();
    G.reloading = false;
    if (!w) return;
    const need = w.stats.mag - w.mag;
    const take = Math.min(need, w.reserve);
    w.mag += take; w.reserve -= take;
  }

  function fire() {
    const w = currentWeapon();
    if (!w || G.reloading || G.fireCd > 0) return;
    if (!G.me || G.me.dn || !G.me.al) return;
    if (w.mag <= 0) {
      G.fireCd = 0.35;
      startReload();
      return;
    }
    const st = w.stats;
    const rof = (60 / st.rpm) / (G.perks.includes('overdrive') ? 1.35 : 1);
    G.fireCd = rof;
    w.mag--;

    const spreadDeg = st.spread * (G.ads ? 0.35 : 1) * (G.moving ? 1.35 : 1);
    const hits = [];
    const seen = new Map();
    const muzzle = muzzleWorld();

    for (let pel = 0; pel < (st.pellets || 1); pel++) {
      const ang = G.cam.a + (Math.random() - 0.5) * spreadDeg * Math.PI / 180 * 2;
      // pitch is a real angle now: slope = tan(pitch)
      const vPitch = Math.tan(G.cam.pitch) + (Math.random() - 0.5) * spreadDeg * 0.012;
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const maxR = st.range;
      const wd = wallDist(G.cam.x, G.cam.y, dx, dy, maxR);

      // gather robots along the ray
      const cand = [];
      for (const r of G.robotsView) {
        if (r.st === 1) continue;
        const meta = S.ROBOTS[r.kind];
        const rx = r.x - G.cam.x, ry = r.y - G.cam.y;
        const t = rx * dx + ry * dy;
        if (t <= 0.2 || t > Math.min(wd, maxR)) continue;
        const perp = Math.abs(-rx * dy + ry * dx);
        const rad = meta.radius + 0.16;
        if (perp > rad) continue;
        const z = EYE + vPitch * t;
        const bodyH = meta.height;
        if (z < 0.02 || z > bodyH) continue;
        cand.push({ r, t, head: z > bodyH * 0.76, meta });
      }
      cand.sort((a, b) => a.t - b.t);

      const pierce = st.pierce || 0;
      let hitCount = 0, endT = Math.min(wd, maxR);
      for (const c of cand) {
        if (hitCount > pierce) break;
        let dmg = st.dmg * (c.head ? 1.45 : 1) * (hitCount > 0 ? 0.82 : 1);
        const prev = seen.get(c.r.id) || 0;
        seen.set(c.r.id, prev + dmg);
        hits.push([c.r.id, Math.round(dmg), c.head ? 1 : 0]);
        G.robotFlash.set(c.r.id, 0.55);
        spawnSparks(G.cam.x + dx * c.t, G.cam.y + dy * c.t, EYE + vPitch * c.t, st.color, 6);
        hitCount++;
        if (hitCount > pierce) { endT = c.t; break; }
        endT = Math.min(wd, maxR);
      }
      if (!cand.length || hitCount === 0) {
        endT = Math.min(wd, maxR);
        if (wd < maxR) spawnSparks(G.cam.x + dx * wd, G.cam.y + dy * wd, EYE + vPitch * wd, '#9fd7ff', 4);
      }

      Renderer.addTracer(
        muzzle,
        { x: G.cam.x + dx * endT, y: EYE + vPitch * endT, z: G.cam.y + dy * endT },
        st.color, st.beam, 0.075
      );

      if (st.splash) {
        const bx = G.cam.x + dx * endT, by = G.cam.y + dy * endT;
        Renderer.addBlast(bx, EYE + vPitch * endT, by, st.splash, st.color);
        Net.send({ t: 'nade', x: bx, y: by });
      }
    }

    if (hits.length) {
      Net.send({ t: 'fire', hits });
      HUD.hit(false);
    }

    G.vm.recoil = Math.min(1.4, G.vm.recoil + (st.cls === 'sniper' || st.cls === 'launcher' ? 1.1 : 0.42));
    G.vm.flash = 0.9;
    G.kick += (st.cls === 'sniper' ? 0.075 : st.cls === 'shotgun' ? 0.055 : 0.022) * (G.ads ? 0.6 : 1);
    G.cam.a += (Math.random() - 0.5) * 0.006 * st.spread;
  }

  function muzzleWorld() { return Renderer.muzzleWorld(G.cam); }

  function spawnSparks(x, y, z, color, n) {
    for (let i = 0; i < n; i++) {
      G.sparks.push({
        x, y, z, color,
        vx: (Math.random() - 0.5) * 3, vy: (Math.random() - 0.5) * 3, vz: Math.random() * 2.4,
        size: 0.5 + Math.random() * 0.9, life: 0.25 + Math.random() * 0.3, max: 0.5
      });
    }
  }

  function throwGrenade() {
    if (G.nades <= 0 || !G.me || G.me.dn) return;
    G.nades--;
    const p = Math.max(-1, Math.min(1, Math.tan(G.cam.pitch)));
    G.projectiles.push({
      x: G.cam.x, y: G.cam.y, z: EYE,
      vx: Math.cos(G.cam.a) * 11, vy: Math.sin(G.cam.a) * 11, vz: 3.0 + p * 9,
      t: 1.7
    });
  }

  // ---------------------------------------------------------- interaction
  function nearestTarget() {
    if (!G.map || !G.me) return null;
    const dirX = Math.cos(G.cam.a), dirY = Math.sin(G.cam.a);
    let best = null, bestScore = -Infinity;

    for (const d of G.map.doors) {
      if (G.openDoors.has(d.id)) continue;
      const dist = Math.hypot(d.x - G.cam.x, d.y - G.cam.y);
      if (dist > 3.2) continue;
      const dot = ((d.x - G.cam.x) * dirX + (d.y - G.cam.y) * dirY) / (dist || 1);
      if (dot < -0.2) continue;
      const sc = dot * 2 - dist * 0.2;
      if (sc > bestScore) { bestScore = sc; best = { type: 'door', door: d }; }
    }
    for (const p of G.map.props) {
      const dist = Math.hypot(p.x - G.cam.x, p.y - G.cam.y);
      if (dist > 2.5) continue;
      const dot = ((p.x - G.cam.x) * dirX + (p.y - G.cam.y) * dirY) / (dist || 1);
      if (dot < 0) continue;
      const sc = dot * 2 - dist * 0.2 + 0.4;
      if (sc > bestScore) { bestScore = sc; best = { type: 'prop', prop: p }; }
    }
    for (const m of G.matesView) {
      if (!m.dn) continue;
      const dist = Math.hypot(m.x - G.cam.x, m.y - G.cam.y);
      if (dist > 2.0) continue;
      best = { type: 'revive', mate: m };
      bestScore = 99;
    }
    return best;
  }

  function propLabel(p) {
    if (p.type === 'wallbuy') {
      const W = S.WEAPONS[p.weapon];
      const owned = G.weapons.some(w => w && w.id === p.weapon);
      return owned
        ? { text: `AMMO  [${Math.round(p.cost / 2)}]`, color: '#6cff8f' }
        : { text: `${W.name.toUpperCase()}  [${p.cost}]`, color: W.color };
    }
    if (p.type === 'perk') {
      const P = S.PERKS[p.perk];
      if (P.power && !G.power) return { text: 'NO POWER', color: '#ff4d5e' };
      return { text: `${P.name.toUpperCase()}  [${P.cost}]`, color: P.color };
    }
    if (p.type === 'box') return { text: `FABRICATOR  [${C.BOX_COST}]`, color: '#ffb648' };
    if (p.type === 'pap') return G.power
      ? { text: `OVERCLOCK  [${C.PAP_COST}]`, color: '#b98cff' }
      : { text: 'NO POWER', color: '#ff4d5e' };
    if (p.type === 'power') return G.power
      ? { text: 'POWER ONLINE', color: '#6cff8f' }
      : { text: 'ACTIVATE MAIN POWER', color: '#ff4d5e' };
    return null;
  }
  G.propLabel = propLabel;

  function interact() {
    const t = nearestTarget();
    if (!t) return;
    if (t.type === 'door') Net.send({ t: 'act', door: t.door.id });
    else if (t.type === 'prop') Net.send({ t: 'act', prop: t.prop.id, slot: G.slot });
  }

  // ------------------------------------------------------------ simulation
  function step(dt) {
    G.time += dt;
    G.dt = dt;
    syncWeaponModel();

    // --- look/aim smoothing
    G.adsT += ((G.ads && G.weapons[G.slot] ? 1 : 0) - G.adsT) * Math.min(1, dt * 12);
    const scope = G.vm.stats && G.vm.stats.scope ? G.vm.stats.scope : 1.35;
    G.cam.fov = 1.22 / (1 + (scope - 1) * G.adsT);
    G.kick *= Math.pow(0.0025, dt);
    G.vm.recoil += (0 - G.vm.recoil) * Math.min(1, dt * 11);
    G.vm.flash = Math.max(0, G.vm.flash - dt * 7);
    G.vm.reloadDip += (0 - G.vm.reloadDip) * Math.min(1, dt * 6);

    // --- movement (client-predicted)
    const me = G.me;
    const alive = me && me.al && !me.dn;
    let mx = 0, my = 0;
    if (!G.chatOpen && G.started && !G.paused) {
      if (keys.KeyW) my += 1;
      if (keys.KeyS) my -= 1;
      if (keys.KeyD) mx += 1;
      if (keys.KeyA) mx -= 1;
    }
    const len = Math.hypot(mx, my);
    G.moving = len > 0;
    const sprint = keys.ShiftLeft && my > 0 && !G.ads;
    let speed = C.PLAYER_SPEED * (G.perks.includes('kinetic') ? 1.25 : 1);
    if (sprint) speed *= C.SPRINT_MULT;
    if (G.ads) speed *= 0.55;
    if (me && me.dn) speed = C.CRAWL_SPEED;
    if (me && !me.al) speed = 0;

    if (len > 0 && (alive || (me && me.dn))) {
      mx /= len; my /= len;
      const dirX = Math.cos(G.cam.a), dirY = Math.sin(G.cam.a);
      const vx = (dirX * my - dirY * mx) * speed * dt;
      const vy = (dirY * my + dirX * mx) * speed * dt;
      const R = C.PLAYER_RADIUS;
      if (!collides(G.cam.x + vx, G.cam.y, R)) G.cam.x += vx;
      if (!collides(G.cam.x, G.cam.y + vy, R)) G.cam.y += vy;
      G.stepDist += Math.hypot(vx, vy);
      G.bobPhase += Math.hypot(vx, vy) * (sprint ? 5.2 : 4.0);
      if (G.stepDist > (sprint ? 1.7 : 2.3)) { G.stepDist = 0; }
    }
    // head bob is a world-space camera offset; pitch and kick are radians
    G.bob += ((G.moving && alive ? Math.sin(G.bobPhase) * 0.045 : 0) - G.bob) * Math.min(1, dt * 10);
    G.vm.tilt = (G.moving ? Math.sin(G.bobPhase * 0.5) * 0.02 : 0) - (keys.KeyA ? 0.03 : 0) + (keys.KeyD ? 0.03 : 0);
    G.roll += (((keys.KeyA ? 0.022 : 0) - (keys.KeyD ? 0.022 : 0)) - G.roll) * Math.min(1, dt * 8);
    G.cam.pitch = Math.max(-1.45, Math.min(1.45, G.look + G.kick));
    if (me && me.dn) G.cam.pitch = Math.max(-1.45, Math.min(1.45, G.look - 0.42));

    // --- firing
    const w = currentWeapon();
    if (w) G.vm.stats = w.stats;
    G.fireCd -= dt;
    if (G.triggerHeld && alive && !G.chatOpen && !G.paused) {
      if (w && (w.stats.auto || !G._trigLatch)) { fire(); G._trigLatch = true; }
    } else G._trigLatch = false;

    if (G.reloading) {
      G.reloadT -= dt;
      G.reloadProg = 1 - Math.max(0, G.reloadT / G.reloadTotal);
      G.vm.reloadDip = Math.max(G.vm.reloadDip, Math.sin(G.reloadProg * Math.PI) * 0.55);
      if (G.reloadT <= 0) finishReload();
    }
    if (w && w.mag === 0 && !G.reloading && w.reserve > 0) startReload();

    // --- hold-F revive
    if (keys.KeyF && alive && !G.paused) {
      const t = nearestTarget();
      if (t && t.type === 'revive') Net.send({ t: 'rev', id: t.mate.id });
    }

    // --- grenades
    for (let i = G.projectiles.length - 1; i >= 0; i--) {
      const p = G.projectiles[i];
      p.t -= dt;
      p.vz -= 14 * dt;
      const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt;
      if (blocked(nx, p.y)) p.vx *= -0.42; else p.x = nx;
      if (blocked(p.x, ny)) p.vy *= -0.42; else p.y = ny;
      p.z += p.vz * dt;
      if (p.z < 0.06) { p.z = 0.06; p.vz *= -0.4; p.vx *= 0.7; p.vy *= 0.7; }
      G.sparks.push({ x: p.x, y: p.y, z: p.z, color: '#6cff8f', vx: 0, vy: 0, vz: 0, size: 0.7, life: 0.12, max: 0.12 });
      if (p.t <= 0) {
        G.projectiles.splice(i, 1);
        Net.send({ t: 'nade', x: p.x, y: p.y });
        Renderer.addBlast(p.x, Math.max(0.3, p.z), p.y, C.GRENADE_RADIUS, '#9dffc4');
        spawnSparks(p.x, p.y, 0.4, '#c9ffe0', 22);
      }
    }

    // --- fx integration
    for (let i = G.sparks.length - 1; i >= 0; i--) {
      const s = G.sparks[i];
      s.life -= dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      s.vz -= 9 * dt;
      if (s.life <= 0) G.sparks.splice(i, 1);
    }
    for (let i = G.popups.length - 1; i >= 0; i--) {
      G.popups[i].life -= dt;
      if (G.popups[i].life <= 0) G.popups.splice(i, 1);
    }
    for (const [id, v] of G.robotFlash) {
      const n = v - dt * 3;
      if (n <= 0) G.robotFlash.delete(id); else G.robotFlash.set(id, n);
    }
    for (const [id, v] of G.deathT) {
      const n = v - dt;
      if (n <= 0) G.deathT.delete(id); else G.deathT.set(id, n);
    }
    if (G.doublesT > 0) G.doublesT -= dt;
    if (G.overchargeT > 0) G.overchargeT -= dt;
  }

  // ------------------------------------------------------- world snapshot
  function syncWorld() {
    const interp = Net.interpolated();
    const latest = Net.latest;
    if (!latest) return;

    G.round = latest.round;
    G.left = latest.left;
    G.phase = latest.phase;
    G.power = latest.power;
    G.openDoors = new Set(latest.doors);
    G.doublesT = latest.buffs.d;
    G.overchargeT = latest.buffs.o;
    G.allPlayers = latest.players;
    G.me = latest.players.find(p => p.id === G.youId) || null;
    if (G.me) G.perks = G.me.pk;

    // box relocates at runtime
    if (latest.box) {
      const box = G.map.props.find(p => p.type === 'box');
      if (box) { box.x = latest.box[0]; box.y = latest.box[1]; }
    }

    // interpolate robots
    const out = [];
    if (interp) {
      const bmap = new Map();
      for (const r of interp.b.robots) bmap.set(r[0], r);
      for (const ra of interp.a.robots) {
        const rb = bmap.get(ra[0]) || ra;
        const f = interp.f;
        out.push({
          id: ra[0],
          x: ra[1] + (rb[1] - ra[1]) * f,
          y: ra[2] + (rb[2] - ra[2]) * f,
          kind: KIND[ra[3]] || 'grunt',
          st: rb[4],
          a: ra[5],
          hpPct: rb[6],
          flash: G.robotFlash.get(ra[0]) || 0
        });
        bmap.delete(ra[0]);
      }
      for (const rb of bmap.values()) {
        out.push({
          id: rb[0], x: rb[1], y: rb[2], kind: KIND[rb[3]] || 'grunt',
          st: rb[4], a: rb[5], hpPct: rb[6], flash: G.robotFlash.get(rb[0]) || 0
        });
      }
    }

    // Death timers live on the client so the shutdown animation plays out at
    // frame rate instead of stepping with the 20Hz snapshot stream.
    const seenIds = new Set();
    for (const r of out) {
      seenIds.add(r.id);
      if (r.st === 1) {
        if (!G.deathT.has(r.id)) {
          G.deathT.set(r.id, 0.55);
          const dist = Math.hypot(r.x - G.cam.x, r.y - G.cam.y);
          if (G.robotFlash.has(r.id)) {           // we contributed damage: claim the kill
            HUD.hit(true);
            G.popups.push({
              x: r.x, y: r.y, z: S.ROBOTS[r.kind].height * 0.75, text: '+' + S.ROBOTS[r.kind].score,
              color: G.doublesT > 0 ? '#6cff8f' : '#ffb648',
              life: 0.9, max: 0.9, big: true
            });
          }
        }
        r.dieT = G.deathT.get(r.id);
      }
    }
    for (const id of G.deathT.keys()) if (!seenIds.has(id)) G.deathT.delete(id);
    G.robotsView = out;

    // interpolate squadmates
    const mates = [];
    if (interp) {
      const bm = new Map();
      for (const p of interp.b.players) bm.set(p.id, p);
      for (const pa of interp.a.players) {
        if (pa.id === G.youId) continue;
        const pb = bm.get(pa.id) || pa;
        mates.push({
          id: pa.id, n: pa.n,
          x: pa.x + (pb.x - pa.x) * interp.f,
          y: pa.y + (pb.y - pa.y) * interp.f,
          a: pb.a, hp: pb.hp, mx: pb.mx, dn: pb.dn, bl: pb.bl, rv: pb.rv
        });
      }
    }
    G.matesView = mates;
    G.pickupsView = latest.pickups.map(p => ({ id: p[0], x: p[1], y: p[2], kind: p[3] }));

    // nearby props / door signs
    G.doorSigns = [];
    for (const d of G.map.doors) {
      if (G.openDoors.has(d.id)) continue;
      if (Math.hypot(d.x - G.cam.x, d.y - G.cam.y) > 13) continue;
      G.doorSigns.push({ x: d.x, y: d.y, cost: d.cost, name: G.map.zones[d.b].name, id: d.id });
    }

    // current sector
    const tx = Math.max(0, Math.min(G.map.w - 1, Math.floor(G.cam.x)));
    const ty = Math.max(0, Math.min(G.map.h - 1, Math.floor(G.cam.y)));
    const z = G.map.zoneAt[ty * G.map.w + tx];
    G.zoneName = G.map.zones[z] ? G.map.zones[z].name : '';

    // damage feedback
    if (G.me) {
      if (G.me.hp < G.lastHp - 0.5) { HUD.damage(); }
      G.lastHp = G.me.hp;
      if (G.me.dn && !G._wasDown) { HUD.big('SYSTEMS CRITICAL', 'hold for extraction', '#ff4d5e'); }
      if (!G.me.dn && G._wasDown) { }
      G._wasDown = G.me.dn;
    }
  }

  // ---------------------------------------------------------------- events
  function onEvent(m) {
    switch (m.kind) {
      case 'round':
        HUD.big(`WAVE ${m.round}`, m.purge ? 'PURGE PROTOCOL — SWARM INBOUND' : 'hostile units inbound',
          m.purge ? '#ff4d5e' : '#ffb648');
        break;
      case 'cleared':
        HUD.big('SECTOR CLEAR', 'regroup — next wave in 9s', '#6cff8f');
        break;
      case 'door':
        HUD.feed(`${m.by} breached ${m.zone}`, 'warn');
        break;
      case 'power':
        HUD.big('MAIN POWER ONLINE', 'chip sockets + overclock station live', '#6cff8f');
        HUD.feed(`${m.by} restored main power`, 'good');
        break;
      case 'grant': {
        G.weapons[m.slot] = makeWeapon(m.weapon, m.pap);
        G.slot = m.slot;
        G.vm.stats = G.weapons[m.slot].stats;
        G.vm.reloadDip = 0.8;
        if (m.pap_fx) { HUD.big('OVERCLOCKED', G.weapons[m.slot].stats.name, '#b98cff'); }
        else if (m.box) { HUD.big(G.weapons[m.slot].stats.name, 'fabricated', '#ffb648'); }
        break;
      }
      case 'ammo': {
        const w = G.weapons[m.slot];
        if (w) { w.reserve = w.stats.reserve; w.mag = w.stats.mag; }
        HUD.feed('Ammunition restocked', 'good');
        break;
      }
      case 'perk':
        HUD.big(S.PERKS[m.perk].name.toUpperCase(), S.PERKS[m.perk].blurb, S.PERKS[m.perk].color);
        break;
      case 'deny':
        HUD.prompt(m.text, '', true);
        // Latch the prompt for a beat so the refusal is readable, then release
        // it back to the contextual prompt in the frame loop.
        G.denyUntil = performance.now() + 1200;
        break;
      case 'maxammo':
        for (const w of G.weapons) if (w) { w.mag = w.stats.mag; w.reserve = w.stats.reserve; }
        G.nades = C.MAX_GRENADES;
        break;
      case 'powerup':
        HUD.big(m.name, m.by ? `collected by ${m.by}` : '', '#ffd23f');
        break;
      case 'boxmove':
        HUD.feed(`Fabricator relocated to ${m.zone}`, 'warn');
        break;
      case 'down':
        HUD.feed(`${m.who} is down`, 'bad');
        break;
      case 'revive':
        HUD.feed(`${m.by} revived ${m.who}`, 'good');
        break;
      case 'boom':
        Renderer.addBlast(m.x, 0.7, m.y, m.r, '#9dffc4');
        break;
      case 'chat':
        HUD.feed(`${m.from}: ${m.text}`, 'info');
        break;
      case 'msg':
        HUD.feed(m.text, m.tone);
        break;
      case 'gameover':
        HUD.gameOver(true, m);
        break;
      case 'newmap':
        HUD.gameOver(false);
        break;
    }
  }

  // ------------------------------------------------------------------ boot
  // ------------------------------------------------------------ pause menu
  // Escape always drops pointer lock — the browser owns that key and it cannot
  // be intercepted. So the menu keys off losing the lock rather than off Escape,
  // which also covers alt-tabbing away.
  function openPause() {
    if (!G.started || G.paused || G.chatOpen) return;
    if (!document.getElementById('picker').classList.contains('hidden')) return;
    G.paused = true;
    G.triggerHeld = false;
    G.ads = false;
    for (const k in keys) keys[k] = false;

    const stats = document.getElementById('pauseStats');
    const me = G.me;
    stats.innerHTML =
      `<div><span>WAVE</span><b>${G.round}</b></div>` +
      `<div><span>CREDITS</span><b>${me ? me.pt : 0}</b></div>` +
      `<div><span>KILLS</span><b>${me ? me.k : 0}</b></div>` +
      `<div><span>SQUAD</span><b>${G.allPlayers.length}</b></div>` +
      `<div><span>FACILITY</span><b>${G.map && G.map.facility ? G.map.facility.name : '—'}</b></div>`;
    document.getElementById('pauseHint').textContent = '';
    document.getElementById('pause').classList.remove('hidden');
  }

  function closePause(relock) {
    if (!G.paused) return;
    G.paused = false;
    document.getElementById('pause').classList.add('hidden');
    if (relock) {
      const canvas = document.getElementById('view');
      // Chrome enforces a cooldown after an Escape-driven unlock; if we are
      // inside it the request throws, so fall back to "click to resume".
      Promise.resolve(canvas.requestPointerLock()).catch(() => {
        document.getElementById('pauseHint').textContent = 'click the view to resume';
      });
    }
  }

  /* Leave the room cleanly and return to the landing screen. */
  function abortToLanding() {
    Net.leave();
    G.started = false;
    G.paused = false;
    G.map = null;
    G.robotsView = [];
    G.matesView = [];
    G.pickupsView = [];
    G.weapons = [null, null];
    G.perks = [];
    G.me = null;
    G.allPlayers = [];
    if (document.pointerLockElement) document.exitPointerLock();
    document.getElementById('pause').classList.add('hidden');
    document.getElementById('picker').classList.add('hidden');
    HUD.gameOver(false);
    HUD.scoreboard(false, G);
    HUD.show(false);
    document.getElementById('menu').classList.remove('hidden');
    document.getElementById('connState').textContent = 'idle';
  }

  /* Facility roulette. The server has already chosen — this spins the three
     names and decelerates onto its answer, so every operator in the squad sees
     the same reveal land on the same place. */
  function playFacilityReveal(facility, roster, done) {
    const picker = document.getElementById('picker');
    const reel = document.getElementById('pickReel');
    const blurb = document.getElementById('pickBlurb');
    const meta = document.getElementById('pickMeta');

    // The reel is built from the roster the server sent, and the winner is
    // located by id. If either is missing we skip the reveal outright rather
    // than defaulting to index 0 — silently always landing on the first
    // facility is worse than showing no animation at all.
    const names = (roster && roster.length ? roster : []).map(f => f.name);
    const targetIdx = facility ? names.indexOf(facility.name) : -1;
    if (targetIdx < 0) {
      if (facility) console.warn('[pulsar] facility not in roster; skipping reveal', facility, roster);
      picker.classList.add('hidden');
      done && done();
      return;
    }

    picker.classList.remove('hidden', 'fading', 'locked');
    blurb.classList.remove('show');
    meta.classList.remove('show');
    reel.innerHTML = '';
    const rows = names.map(n => {
      const d = document.createElement('div');
      d.className = 'pick-row';
      d.textContent = n;
      reel.appendChild(d);
      return d;
    });

    let i = 0, elapsed = 0;
    const SPIN = 1500, SETTLE = 900;
    // land exactly on the server's pick: pad the step count out to a whole
    // number of cycles plus the target offset
    const steps = names.length * 5 + targetIdx;
    let step = 0;

    const highlight = (k) => rows.forEach((r, j) => r.classList.toggle('on', j === k % names.length));

    function tick() {
      if (step >= steps) {
        rows.forEach((r, j) => {
          r.classList.remove('on');
          r.classList.toggle('locked', j === targetIdx);
        });
        picker.classList.add('locked');
        blurb.textContent = facility && facility.blurb ? facility.blurb : '';
        blurb.classList.add('show');
        meta.classList.add('show');
        setTimeout(() => {
          picker.classList.add('fading');
          setTimeout(() => { picker.classList.add('hidden'); done && done(); }, 520);
        }, 1150);
        return;
      }
      highlight(step);
      step++;
      // ease out: fast at first, deliberate at the end
      const t = step / steps;
      const delay = 45 + Math.pow(t, 3) * 260;
      setTimeout(tick, delay);
    }
    tick();
  }

  function onInit(m) {
    const rejoin = G.started;
    G.youId = m.you;
    G.map = m.map;
    Renderer.setMap(m.map);
    G.zoneDim = m.map.zones.map(z => {
      const n = parseInt(z.tint.slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},.45)`;
    });
    const sp = m.map.spawns[0];
    const mine = m.state.players.find(p => p.id === m.you);
    G.cam.x = mine ? mine.x : sp.x;
    G.cam.y = mine ? mine.y : sp.y;
    G.weapons = [makeWeapon('sidearm', false), null];
    G.slot = 0;
    G.vm.stats = G.weapons[0].stats;
    G.started = true;
    G.sparks.length = G.popups.length = G.projectiles.length = 0;
    G.nades = C.MAX_GRENADES;
    document.getElementById('menu').classList.add('hidden');
    HUD.show(true);

    const fac = m.map.facility;
    HUD.feed(`${fac ? fac.name : 'FACILITY'} — squad ${m.room}, seed ${m.map.seed}`, 'info');
    if (Net.serverUrl && !Net.serverUrl.includes(location.host)) HUD.feed(`server ${Net.serverUrl}`, 'info');

    // The world renders behind the reveal, so the roulette dissolves straight
    // into the room you are standing in.
    playFacilityReveal(fac, m.map.facilities, () => {
      if (!rejoin) document.getElementById('view').requestPointerLock();
      HUD.big(fac ? fac.name : '', 'hold the line', '#7cf9ff');
    });
  }

  // ------------------------------------------------------------ main loop
  let last = performance.now();
  let netAcc = 0;

  let loopFailed = false;

  function loop(now) {
    requestAnimationFrame(loop);
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.1) dt = 0.1;

    if (!G.started || !G.map) return;

    // A throw anywhere in here used to leave a black screen with no explanation,
    // because the frame never reached the renderer. Surface it instead.
    try {
      frame(now, dt);
    } catch (err) {
      if (!loopFailed) {
        loopFailed = true;
        console.error('[pulsar] frame loop failed:', err);
        HUD.feed('Render fault: ' + err.message + ' (see console)', 'bad');
      }
    }
  }

  function frame(now, dt) {
    Renderer.autoQuality(dt);
    syncWorld();
    step(dt);

    netAcc += dt;
    if (netAcc > 1 / 20) {
      netAcc = 0;
      Net.send({ t: 'in', x: G.cam.x, y: G.cam.y, a: G.cam.a, s: G.slot });
      Net.heartbeat(now);
    }

    Renderer.draw(G);
    HUD.update(G);
    HUD.drawMinimap(G);
    HUD.tickFeed(now);

    // contextual prompt (a refusal message holds the slot briefly)
    if (now < G.denyUntil) {
      // leave the deny message on screen
    } else {
      const tgt = nearestTarget();
      if (!tgt) HUD.prompt(null);
      else if (tgt.type === 'door') {
        HUD.prompt(`BREACH ${G.map.zones[tgt.door.b].name}`, `[F]  ${tgt.door.cost} CREDITS`);
      } else if (tgt.type === 'revive') {
        HUD.prompt(`REVIVE ${tgt.mate.n}`, `[F]  ${Math.round(tgt.mate.rv * 100)}%`);
      } else {
        const l = propLabel(tgt.prop);
        const cost = l && l.text.match(/\[(\d+)\]/);
        HUD.prompt(l ? l.text.replace(/\s*\[\d+\]/, '') : 'INTERACT', cost ? `[F]  ${cost[1]} CREDITS` : '[F]');
      }
    }

    // ambient robot chatter + music tension
    if (Math.random() < 0.04 && G.robotsView.length) {
      const r = G.robotsView[(Math.random() * G.robotsView.length) | 0];
    }
  }

  // ---------------------------------------------------------------- deploy
  window.addEventListener('DOMContentLoaded', () => {
    window.buildSprites();
    HUD.init();
    const canvas = document.getElementById('view');
    Renderer.init(canvas);
    bindInput(canvas);

    const nameI = document.getElementById('nameInput');
    const roomI = document.getElementById('roomInput');
    const serverI = document.getElementById('serverInput');
    nameI.value = localStorage.getItem('pp.name') || '';
    roomI.value = localStorage.getItem('pp.room') || 'ALPHA';
    serverI.value = Net.savedServer() || (window.PP_CONFIG && window.PP_CONFIG.server) || '';

    const params = new URLSearchParams(location.search);
    if (params.get('room')) roomI.value = params.get('room');

    Net.on('init', onInit);
    Net.on('ev', onEvent);
    Net.on('close', () => {
      if (Net.leaving) return;              // we asked to leave; not an error
      HUD.feed('Link severed — reload to reconnect', 'bad');
      G.started = false;
      G.paused = false;
      document.getElementById('pause').classList.add('hidden');
      HUD.show(false);
      document.getElementById('menu').classList.remove('hidden');
      document.getElementById('connState').textContent = 'connection lost';
    });

    document.getElementById('resumeBtn').addEventListener('click', () => closePause(true));
    document.getElementById('abortBtn').addEventListener('click', abortToLanding);

    document.getElementById('deployBtn').addEventListener('click', () => {
      const name = (nameI.value || 'OPERATOR').toUpperCase();
      const room = (roomI.value || 'ALPHA').toUpperCase();
      const server = serverI.value.trim();
      localStorage.setItem('pp.name', name);
      localStorage.setItem('pp.room', room);
      Net.rememberServer(server);
      Net.connect(name, room, (s) => { document.getElementById('connState').textContent = s; }, server);
    });

    [nameI, roomI, serverI].forEach(i => i.addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('deployBtn').click();
      e.stopPropagation();
    }));

    requestAnimationFrame(loop);
  });
})();
