/* DOM HUD + minimap. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  const HUD = {
    el: {}, feedLines: [], mmCtx: null, lastHp: 1,

    init() {
      const ids = ['hud', 'crosshair', 'hitmarker', 'dmgflash', 'roundNum', 'roundPips', 'zoneName',
        'leftNum', 'powerState', 'buffbar', 'feed', 'bigmsg', 'prompt', 'squad', 'credits',
        'healthBar', 'perkRow', 'wpnName', 'magAmmo', 'resAmmo', 'ammoRow', 'altWpn', 'nadeCount',
        'reloadBar', 'minimap', 'downedOverlay', 'bleedBar', 'scoreboard', 'sbTable', 'gameover',
        'goStats', 'chatbox', 'chatInput'];
      for (const id of ids) this.el[id] = $(id);
      this.mmCtx = this.el.minimap.getContext('2d');
    },

    show(v) { this.el.hud.classList.toggle('hidden', !v); },

    feed(text, tone) {
      const d = document.createElement('div');
      d.className = 'feedline' + (tone ? ' ' + tone : '');
      d.textContent = text;
      this.el.feed.appendChild(d);
      this.feedLines.push({ el: d, t: performance.now() });
      while (this.feedLines.length > 6) {
        const old = this.feedLines.shift();
        old.el.remove();
      }
    },

    tickFeed(now) {
      while (this.feedLines.length && now - this.feedLines[0].t > 7000) {
        this.feedLines.shift().el.remove();
      }
    },

    big(text, sub, color) {
      const el = this.el.bigmsg;
      el.innerHTML = text + (sub ? `<small>${sub}</small>` : '');
      el.style.color = color || '#ffb648';
      el.classList.remove('show');
      void el.offsetWidth;
      el.classList.add('show');
    },

    hit(kill) {
      const el = this.el.hitmarker;
      el.classList.toggle('kill', !!kill);
      el.classList.remove('on');
      void el.offsetWidth;
      el.classList.add('on');
    },

    damage() {
      this.el.dmgflash.style.opacity = '1';
      clearTimeout(this._dmgT);
      this._dmgT = setTimeout(() => { this.el.dmgflash.style.opacity = '0'; }, 90);
    },

    prompt(text, sub, deny) {
      const el = this.el.prompt;
      if (!text) { el.classList.add('hidden'); return; }
      el.classList.remove('hidden');
      el.classList.toggle('deny', !!deny);
      el.querySelector('b').textContent = text;
      el.querySelector('span').textContent = sub || '';
    },

    update(G) {
      const e = this.el;
      const me = G.me;
      e.roundNum.textContent = G.round;
      e.leftNum.textContent = G.left;
      e.powerState.textContent = G.power ? 'ONLINE' : 'OFFLINE';
      e.powerState.className = G.power ? 'good' : 'bad';
      e.zoneName.textContent = G.zoneName;

      // round pips
      if (this._pips !== G.round) {
        this._pips = G.round;
        e.roundPips.innerHTML = '';
        const n = Math.min(20, G.round);
        for (let i = 0; i < n; i++) e.roundPips.appendChild(document.createElement('span'));
      }

      // buffs
      const buffs = [];
      if (G.doublesT > 0) buffs.push(['DOUBLE CREDITS ' + Math.ceil(G.doublesT), '#6cff8f']);
      if (G.overchargeT > 0) buffs.push(['OVERCHARGE ' + Math.ceil(G.overchargeT), '#ffd23f']);
      const key = buffs.map(b => b[0]).join('|');
      if (key !== this._buffKey) {
        this._buffKey = key;
        e.buffbar.innerHTML = '';
        for (const [t, c] of buffs) {
          const d = document.createElement('div');
          d.className = 'buff'; d.style.color = c; d.textContent = t;
          e.buffbar.appendChild(d);
        }
      }

      if (me) {
        e.credits.textContent = me.pt;
        const pct = Math.max(0, Math.min(1, me.hp / me.mx));
        e.healthBar.style.transform = `scaleX(${pct.toFixed(4)})`;
        e.healthBar.classList.toggle('low', pct < 0.35);

        const pk = me.pk.join(',');
        if (pk !== this._perks) {
          this._perks = pk;
          e.perkRow.innerHTML = '';
          for (const id of me.pk) {
            const P = window.SHARED.PERKS[id];
            if (!P) continue;
            const d = document.createElement('div');
            d.className = 'perk'; d.style.color = P.color;
            d.textContent = P.name[0];
            d.title = P.name + ' — ' + P.blurb;
            e.perkRow.appendChild(d);
          }
        }
      }

      // weapon panel
      const w = G.weapons[G.slot];
      if (w) {
        e.wpnName.textContent = w.stats.name.toUpperCase();
        e.wpnName.classList.toggle('pap', !!w.pap);
        e.magAmmo.textContent = w.mag;
        e.resAmmo.textContent = w.reserve;
        e.ammoRow.classList.toggle('empty', w.mag === 0);
      }
      const alt = G.weapons[1 - G.slot];
      e.altWpn.textContent = alt ? alt.stats.name.toUpperCase() : '— EMPTY —';
      e.nadeCount.textContent = '●'.repeat(G.nades) + '○'.repeat(Math.max(0, 4 - G.nades));

      if (G.reloading) {
        e.reloadBar.classList.remove('hidden');
        e.reloadBar.firstElementChild.style.width = (G.reloadProg * 100) + '%';
      } else e.reloadBar.classList.add('hidden');

      // squad
      const mates = G.allPlayers.filter(p => p.id !== G.youId);
      const skey = mates.map(m => `${m.id}:${m.hp}:${m.dn}`).join('|');
      if (skey !== this._skey) {
        this._skey = skey;
        e.squad.innerHTML = '';
        for (const m of mates) {
          const d = document.createElement('div');
          d.className = 'mate' + (m.dn ? ' down' : '');
          d.innerHTML = `${m.n} <span style="float:right;opacity:.6">${m.pt}</span>
            <div class="hb"><i style="width:${Math.max(0, (m.hp / m.mx) * 100)}%"></i></div>`;
          e.squad.appendChild(d);
        }
      }

      // Downed overlay, suppressed once the run is over so the two full-screen
      // messages do not stack on top of each other.
      const over = !e.gameover.classList.contains('hidden');
      const downed = me && me.dn && !over;
      e.downedOverlay.classList.toggle('hidden', !downed);
      if (downed) e.bleedBar.style.width = Math.max(0, (me.bl / 42) * 100) + '%';

      e.crosshair.classList.toggle('wide', G.moving && !G.ads);
    },

    scoreboard(show, G) {
      this.el.scoreboard.classList.toggle('hidden', !show);
      if (!show) return;
      let html = '<tr><th>OPERATOR</th><th>CREDITS</th><th>KILLS</th><th>DOWNS</th><th>PERKS</th></tr>';
      const rows = [...G.allPlayers].sort((a, b) => b.k - a.k);
      for (const p of rows) {
        html += `<tr class="${p.id === G.youId ? 'me' : ''}"><td>${p.n}${p.dn ? ' [DOWN]' : ''}</td>` +
          `<td>${p.pt}</td><td>${p.k}</td><td>${p.d}</td><td>${p.pk.length}</td></tr>`;
      }
      this.el.sbTable.innerHTML = html;
    },

    gameOver(show, data) {
      this.el.gameover.classList.toggle('hidden', !show);
      if (show && data) {
        this.el.goStats.innerHTML =
          `WAVE REACHED &nbsp;<b>${data.round}</b><br>` +
          `UNITS DESTROYED &nbsp;<b>${data.kills}</b><br>` +
          `TIME SURVIVED &nbsp;<b>${Math.floor(data.time / 60)}m ${data.time % 60}s</b>`;
      }
    },

    // ------------------------------------------------------------- minimap
    drawMinimap(G) {
      const c = this.mmCtx, size = this.el.minimap.width;
      const map = G.map;
      const view = 26;                       // tiles visible across the minimap
      const sc = size / view;
      c.clearRect(0, 0, size, size);
      c.fillStyle = 'rgba(2,6,10,.55)';
      c.fillRect(0, 0, size, size);

      const px = G.cam.x, py = G.cam.y;
      const ox = px - view / 2, oy = py - view / 2;
      const T = (wx, wy) => [(wx - ox) * sc, (wy - oy) * sc];

      const x0 = Math.max(0, Math.floor(ox)), x1 = Math.min(map.w - 1, Math.ceil(ox + view));
      const y0 = Math.max(0, Math.floor(oy)), y1 = Math.min(map.h - 1, Math.ceil(oy + view));

      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * map.w + x;
          const [sx, sy] = T(x, y);
          const d = map.doorAt[i];
          if (map.grid[i] === 1) {
            const z = map.zoneAt[i];
            c.fillStyle = G.zoneDim[z] || 'rgba(60,80,95,.55)';
            c.fillRect(sx, sy, sc + 0.6, sc + 0.6);
          } else if (d >= 0 && !G.openDoors.has(d)) {
            c.fillStyle = '#ffb648';
            c.fillRect(sx, sy, sc + 0.6, sc + 0.6);
          } else {
            c.fillStyle = 'rgba(124,249,255,.07)';
            c.fillRect(sx, sy, sc + 0.6, sc + 0.6);
          }
        }
      }

      // props
      for (const p of map.props) {
        if (p.x < ox || p.x > ox + view || p.y < oy || p.y > oy + view) continue;
        const [sx, sy] = T(p.x, p.y);
        const col = p.type === 'box' ? '#ffb648' : p.type === 'pap' ? '#b98cff'
          : p.type === 'power' ? (G.power ? '#6cff8f' : '#ff4d5e')
            : p.type === 'perk' ? (window.SHARED.PERKS[p.perk] || {}).color || '#7cf9ff' : '#5effc0';
        c.fillStyle = col;
        c.fillRect(sx - 2.5, sy - 2.5, 5, 5);
      }

      // robots
      for (const r of G.robotsView) {
        if (r.st === 1) continue;
        if (r.x < ox || r.x > ox + view || r.y < oy || r.y > oy + view) continue;
        const [sx, sy] = T(r.x, r.y);
        c.fillStyle = r.kind === 'titan' ? '#ffb648' : r.kind === 'hunter' ? '#c77dff' : '#ff4d5e';
        c.beginPath(); c.arc(sx, sy, 2.6, 0, 6.3); c.fill();
      }

      // squadmates
      for (const m of G.matesView) {
        const [sx, sy] = T(m.x, m.y);
        c.fillStyle = m.dn ? '#ff4d5e' : '#6cff8f';
        c.beginPath(); c.arc(sx, sy, 3.4, 0, 6.3); c.fill();
      }

      // self
      const [sx, sy] = T(px, py);
      c.save();
      c.translate(sx, sy); c.rotate(G.cam.a + Math.PI / 2);
      c.fillStyle = '#7cf9ff';
      c.shadowColor = '#7cf9ff'; c.shadowBlur = 8;
      c.beginPath(); c.moveTo(0, -6); c.lineTo(4.5, 5); c.lineTo(0, 2.5); c.lineTo(-4.5, 5);
      c.closePath(); c.fill();
      c.restore();

      // frame + zone label
      c.strokeStyle = 'rgba(124,249,255,.25)';
      c.lineWidth = 1;
      c.strokeRect(0.5, 0.5, size - 1, size - 1);
    }
  };

  window.HUD = HUD;
})();
