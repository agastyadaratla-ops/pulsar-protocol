/* Thin WebSocket client with a snapshot buffer for entity interpolation. */
(function () {
  'use strict';

  const Net = {
    ws: null,
    connected: false,
    leaving: false,
    youId: null,
    room: null,
    map: null,
    snaps: [],          // recent server states, newest last
    latest: null,
    ping: 0,
    handlers: {},
    _pingT: 0,

    on(kind, fn) { (this.handlers[kind] = this.handlers[kind] || []).push(fn); },
    emit(kind, data) { (this.handlers[kind] || []).forEach(f => f(data)); },

    /* Resolve the game server: explicit override, then saved choice, then the
       build-time config, then this page's own origin. Returns a ws:// or wss://
       origin with no trailing slash. */
    resolveServer(explicit) {
      const clean = (v) => {
        if (!v) return '';
        let s = String(v).trim().replace(/\/+$/, '').replace(/\/ws$/, '');
        if (!s) return '';
        if (/^https:\/\//i.test(s)) s = 'wss://' + s.slice(8);
        else if (/^http:\/\//i.test(s)) s = 'ws://' + s.slice(7);
        else if (!/^wss?:\/\//i.test(s)) {
          // bare host: match the page's security level
          s = (location.protocol === 'https:' ? 'wss://' : 'ws://') + s;
        }
        return s;
      };

      const param = new URLSearchParams(location.search).get('server');
      let url = clean(explicit) || clean(param) ||
                clean(this.savedServer()) ||
                clean(window.PP_CONFIG && window.PP_CONFIG.server);

      if (!url) {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        url = `${proto}://${location.host}`;
      }
      return url;
    },

    savedServer() {
      try { return localStorage.getItem('pp.server') || ''; } catch (e) { return ''; }
    },

    rememberServer(v) {
      try {
        if (v) localStorage.setItem('pp.server', v);
        else localStorage.removeItem('pp.server');
      } catch (e) {}
    },

    connect(name, room, onState, server) {
      const base = this.resolveServer(server);
      const url = `${base}/ws`;
      this.serverUrl = base;

      // A secure page cannot open an insecure socket; say so plainly rather
      // than letting the browser fail with an opaque error.
      if (location.protocol === 'https:' && url.startsWith('ws://')) {
        onState && onState('need wss:// — this page is https');
        this.emit('close');
        return;
      }
      onState && onState('connecting…');
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        this.connected = true;
        onState && onState('handshake…');
        this.send({ t: 'join', name, room });
      };
      ws.onclose = () => {
        this.connected = false;
        onState && onState('connection closed');
        this.emit('close');
      };
      ws.onerror = () => { onState && onState('connection error'); };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'init') {
          this.youId = m.you; this.room = m.room; this.map = m.map;
          this.pushSnap(m.state);
          this.emit('init', m);
        } else if (m.t === 'state') {
          this.pushSnap(m);
        } else if (m.t === 'ev') {
          this.emit('ev', m);
        } else if (m.t === 'pong') {
          this.ping = Math.round(performance.now() - m.c);
        }
      };
    },

    pushSnap(s) {
      s._t = performance.now();
      this.latest = s;
      this.snaps.push(s);
      if (this.snaps.length > 24) this.snaps.shift();
    },

    /* Deliberate disconnect: flagged so the close handler does not report it
       as a dropped link. */
    leave() {
      this.leaving = true;
      try { if (this.ws) this.ws.close(); } catch (e) {}
      this.ws = null;
      this.connected = false;
      this.snaps.length = 0;
      this.latest = null;
      this.youId = null;
      this.map = null;
      setTimeout(() => { this.leaving = false; }, 400);
    },

    send(o) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o));
    },

    heartbeat(now) {
      if (now - this._pingT > 2000) {
        this._pingT = now;
        this.send({ t: 'ping', c: performance.now() });
      }
    },

    /* Interpolated view of the world ~110ms in the past so movement is smooth. */
    interpolated(delayMs) {
      const d = delayMs === undefined ? 110 : delayMs;
      const target = performance.now() - d;
      const s = this.snaps;
      if (s.length === 0) return null;
      if (s.length === 1) return { a: s[0], b: s[0], f: 0 };
      let i = s.length - 1;
      while (i > 0 && s[i]._t > target) i--;
      const a = s[i], b = s[Math.min(s.length - 1, i + 1)];
      const span = b._t - a._t;
      const f = span > 0 ? Math.max(0, Math.min(1, (target - a._t) / span)) : 0;
      return { a, b, f };
    }
  };

  window.Net = Net;
})();
