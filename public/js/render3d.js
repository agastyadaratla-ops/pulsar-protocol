/* Pulsar Protocol — WebGL renderer (three.js).
 *
 * World convention: the server works in tiles on an (x, y) plane. In the scene
 * that becomes (x, height, z) with z = y, so every conversion is just y -> z.
 */
(function () {
  'use strict';

  const EYE = 1.40;      // camera height, world units
  const WALL_H = 2.60;   // ceiling height
  const FOG = 0.032;   // lighter haze: the facility was reading as pitch black

  const T = window.THREE;

  const R = {
    W: 0, H: 0, quality: 1, _fAcc: 0, _fN: 0,
    scene: null, camera: null, gl: null, map: null,
    zoneColors: [],
    robots: new Map(), mates: new Map(), pickups: new Map(),
    doorMeshes: new Map(), propMeshes: [],
    tracers: [], blasts: [], sparkSystem: null,
    vm: null, vmGroup: null, muzzle: null, muzzleLight: null,
    protos: {}, fx2d: null, fx2dCtx: null,

    // ------------------------------------------------------------------ boot
    init(canvas) {
      this.gl = new T.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
      this.gl.setClearColor(0x05090e, 1);

      this.scene = new T.Scene();
      this.scene.fog = new T.FogExp2(0x05090e, FOG);

      this.camera = new T.PerspectiveCamera(78, 1, 0.05, 90);
      this.camera.rotation.order = 'YXZ';
      this.scene.add(this.camera);

      this.scene.add(new T.AmbientLight(0x5e7d96, 2.6));
      this.scene.add(new T.HemisphereLight(0x7ea3bd, 0x18232e, 2.2));

      // the operator's own suit lamp: a soft near-field fill, not a floodlight
      this.lamp = new T.PointLight(0xcfe6f2, 10, 26, 1.8);
      this.lamp.position.set(0, 0.15, 0.3);
      this.camera.add(this.lamp);

      // A small roving pool of lights, reassigned each frame to whichever
      // machines are nearest, so upgrades announce themselves across a room
      // without paying for a light per prop.
      this.propLights = [];
      for (let i = 0; i < 4; i++) {
        const l = new T.PointLight(0xffffff, 0, 11, 1.7);
        l.visible = false;
        this.scene.add(l);
        this.propLights.push(l);
      }

      this.muzzleLight = new T.PointLight(0x7cf9ff, 0, 14, 2);
      this.muzzleLight.position.set(0.3, -0.2, -1.2);
      this.camera.add(this.muzzleLight);

      // Weapon pass: rendered after the world with a cleared depth buffer, so it
      // is lit on its own terms and can never clip into geometry.
      this.vmScene = new T.Scene();
      this.vmScene.add(new T.AmbientLight(0x93a8bb, 1.5));
      const key = new T.DirectionalLight(0xdfefff, 2.1);
      key.position.set(-0.6, 1, 0.7);
      this.vmScene.add(key);
      const rim = new T.DirectionalLight(0x4f7d96, 1.2);
      rim.position.set(0.8, -0.3, -0.6);
      this.vmScene.add(rim);
      this.vmCamera = new T.PerspectiveCamera(58, 1, 0.01, 8);
      this.vmScene.add(this.vmCamera);

      this.buildProtos();
      this.buildSparks();

      // 2D overlay for name tags and floating numbers
      this.fx2d = document.getElementById('fx2d');
      this.fx2dCtx = this.fx2d.getContext('2d');

      this.resize();
      window.addEventListener('resize', () => this.resize());
    },

    resize() {
      // A hidden or zero-sized container reports 0, which would leave a 0x0
      // drawing buffer and a NaN aspect ratio that never recovers.
      const cssW = Math.max(16, window.innerWidth || 0);
      const cssH = Math.max(16, window.innerHeight || 0);
      this.W = cssW; this.H = cssH;
      this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5) * this.quality);
      this.gl.setSize(cssW, cssH, false);
      this.camera.aspect = cssW / Math.max(1, cssH);
      this.camera.updateProjectionMatrix();
      this.vmCamera.aspect = this.camera.aspect;
      this.vmCamera.updateProjectionMatrix();
      this.fx2d.width = cssW; this.fx2d.height = cssH;
    },

    /* Trade internal resolution for frame rate; never touches field of view. */
    autoQuality(dt) {
      this._fAcc += dt; this._fN++;
      if (this._fN < 45) return;
      const avg = this._fAcc / this._fN;
      this._fAcc = 0; this._fN = 0;
      let q = this.quality;
      if (avg > 0.028) q -= 0.12;
      else if (avg < 0.0135) q += 0.06;
      q = Math.max(0.5, Math.min(1, q));
      if (Math.abs(q - this.quality) > 0.02) { this.quality = q; this.resize(); }
    },

    // -------------------------------------------------------------- geometry
    setMap(map) {
      this.map = map;
      this.zoneColors = map.zones.map(z => new T.Color(z.tint));
      this.clearWorld();
      this.buildLevel();
      this.buildDoors();
      this.buildProps();
    },

    clearWorld() {
      for (const g of [this.levelGroup, this.doorGroup, this.propGroup]) {
        if (!g) continue;
        this.scene.remove(g);
        g.traverse(o => { if (o.geometry && o.userData.dispose !== false) o.geometry.dispose(); });
      }
      this.levelGroup = new T.Group(); this.scene.add(this.levelGroup);
      this.doorGroup = new T.Group(); this.scene.add(this.doorGroup);
      this.propGroup = new T.Group(); this.scene.add(this.propGroup);
      this.doorMeshes.clear();
      this.propMeshes.length = 0;
      for (const t of this.tracers) { this.scene.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh.material.dispose(); }
      this.tracers.length = 0;
      for (const b of this.blasts) { this.scene.remove(b.mesh); this.scene.remove(b.light); b.mesh.geometry.dispose(); b.mesh.material.dispose(); }
      this.blasts.length = 0;
      for (const [, m] of this.robots) this.scene.remove(m.obj);
      this.robots.clear();
      for (const [, m] of this.mates) this.scene.remove(m.obj);
      this.mates.clear();
      for (const [, m] of this.pickups) this.scene.remove(m.obj);
      this.pickups.clear();
    },

    /* One merged mesh for the walls, one for the emissive trim. Interior faces
       between two solid tiles are never emitted. */
    buildLevel() {
      const m = this.map;
      const pos = [], nor = [], col = [], uv = [];
      const ePos = [], eCol = [];
      const solid = (x, y) => {
        if (x < 0 || y < 0 || x >= m.w || y >= m.h) return true;
        return m.grid[y * m.w + x] === 1;
      };
      const STRIP = 0.14, STRIP_Y = WALL_H - 0.55;

      // Vertices arrive as a=bottom-left, b=bottom-right, c=top-right, d=top-left,
      // emitted as (a,b,c) and (a,c,d). Shading the bottom pair darker than the
      // top bakes in contact shadow, which is what makes a wall read as a solid
      // slab instead of a sheet of paper.
      // Wound as (a,c,b) and (a,d,c) — NOT (a,b,c)/(a,c,d). Backface culling is
      // decided by winding, not by the normal attribute, and the intuitive order
      // yields a geometric normal pointing into the wall, which culls every face
      // from the side the player actually stands on.
      const face = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, cBot, cTop, uvw) => {
        pos.push(ax, ay, az, cx, cy, cz, bx, by, bz, ax, ay, az, dx, dy, dz, cx, cy, cz);
        for (let i = 0; i < 6; i++) nor.push(nx, ny, nz);
        const order = [cBot, cTop, cBot, cBot, cTop, cTop];
        for (const k of order) col.push(k.r, k.g, k.b);
        uv.push(0, 0, uvw, 1, uvw, 0, 0, 0, 0, 1, uvw, 1);
      };
      const strip = (ax, az, bx, bz, c) => {
        const y0 = STRIP_Y, y1 = STRIP_Y + STRIP;
        ePos.push(ax, y0, az, bx, y1, bz, bx, y0, bz, ax, y0, az, ax, y1, az, bx, y1, bz);
        for (let i = 0; i < 6; i++) eCol.push(c.r, c.g, c.b);
      };

      for (let y = 0; y < m.h; y++) {
        for (let x = 0; x < m.w; x++) {
          if (m.grid[y * m.w + x] !== 1) continue;
          const zi = m.zoneAt[y * m.w + x] | 0;
          const base = this.zoneColors[zi] || new T.Color(0x44586a);
          // slight per-tile variance so long walls do not read as one flat sheet
          const h = (((x * 73856093) ^ (y * 19349663)) >>> 0) % 97;
          const c = base.clone().multiplyScalar(1.02 + (h / 97) * 0.34);
          const trim = base.clone().lerp(new T.Color(0xffffff), 0.55);
          const x0 = x, x1 = x + 1, z0 = y, z1 = y + 1;

          // Fixed per-orientation brightness. Lambert alone leaves all four wall
          // directions nearly equal under ambient light, so corners disappear and
          // the geometry stops reading as three-dimensional.
          const AO = 0.30, FACE = { n: 0.66, s: 1.00, w: 0.78, e: 0.88 };
          const shade = (k) => {
            const top = c.clone().multiplyScalar(k);
            return [top.clone().multiplyScalar(AO), top];
          };

          if (!solid(x, y - 1)) {                       // north face
            const [b, t] = shade(FACE.n);
            face(x0, 0, z0, x1, 0, z0, x1, WALL_H, z0, x0, WALL_H, z0, 0, 0, -1, b, t, 1);
            strip(x0, z0 - 0.01, x1, z0 - 0.01, trim);
          }
          if (!solid(x, y + 1)) {                       // south
            const [b, t] = shade(FACE.s);
            face(x1, 0, z1, x0, 0, z1, x0, WALL_H, z1, x1, WALL_H, z1, 0, 0, 1, b, t, 1);
            strip(x1, z1 + 0.01, x0, z1 + 0.01, trim);
          }
          if (!solid(x - 1, y)) {                       // west
            const [b, t] = shade(FACE.w);
            face(x0, 0, z1, x0, 0, z0, x0, WALL_H, z0, x0, WALL_H, z1, -1, 0, 0, b, t, 1);
            strip(x0 - 0.01, z1, x0 - 0.01, z0, trim);
          }
          if (!solid(x + 1, y)) {                       // east
            const [b, t] = shade(FACE.e);
            face(x1, 0, z0, x1, 0, z1, x1, WALL_H, z1, x1, WALL_H, z0, 1, 0, 0, b, t, 1);
            strip(x1 + 0.01, z0, x1 + 0.01, z1, trim);
          }
        }
      }

      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
      g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
      g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
      const wallTex = this.panelTexture();
      this.levelGroup.add(new T.Mesh(g, new T.MeshLambertMaterial({ vertexColors: true, map: wallTex })));

      const eg = new T.BufferGeometry();
      eg.setAttribute('position', new T.Float32BufferAttribute(ePos, 3));
      eg.setAttribute('color', new T.Float32BufferAttribute(eCol, 3));
      this.levelGroup.add(new T.Mesh(eg, new T.MeshBasicMaterial({
        vertexColors: true, blending: T.AdditiveBlending, depthWrite: false, transparent: true,
        opacity: 0.55, side: T.DoubleSide   // thin unlit band: visible from either side by design
      })));

      // floor + ceiling planes
      const floorTex = this.gridTexture('#16222c', '#2b4a5c', 8);
      floorTex.repeat.set(m.w / 2, m.h / 2);
      const floor = new T.Mesh(new T.PlaneGeometry(m.w, m.h),
        new T.MeshLambertMaterial({ map: floorTex, color: 0xb4c8d6 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(m.w / 2, 0, m.h / 2);
      this.levelGroup.add(floor);

      const ceilTex = this.gridTexture('#0a1218', '#1b2f3c', 4);
      ceilTex.repeat.set(m.w / 4, m.h / 4);
      const ceil = new T.Mesh(new T.PlaneGeometry(m.w, m.h),
        new T.MeshLambertMaterial({ map: ceilTex, color: 0x7c93a6 }));
      ceil.rotation.x = Math.PI / 2;
      ceil.position.set(m.w / 2, WALL_H, m.h / 2);
      this.levelGroup.add(ceil);
    },

    panelTexture() {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 128, 128);
      g.strokeStyle = 'rgba(0,0,0,.42)'; g.lineWidth = 3;
      g.strokeRect(0, 0, 128, 128);
      g.strokeStyle = 'rgba(0,0,0,.22)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, 42); g.lineTo(128, 42); g.moveTo(0, 92); g.lineTo(128, 92); g.stroke();
      g.fillStyle = 'rgba(0,0,0,.16)';
      for (let i = 0; i < 5; i++) g.fillRect(14 + i * 22, 100, 10, 18);
      g.fillStyle = 'rgba(255,255,255,.5)';
      g.fillRect(0, 0, 128, 6);
      const t = new T.CanvasTexture(c);
      t.wrapS = t.wrapT = T.RepeatWrapping;
      return t;
    },

    gridTexture(bg, line, div) {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d');
      g.fillStyle = bg; g.fillRect(0, 0, 128, 128);
      g.strokeStyle = line; g.lineWidth = 2;
      for (let i = 0; i <= div; i++) {
        const p = (i / div) * 128;
        g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 128); g.moveTo(0, p); g.lineTo(128, p); g.stroke();
      }
      g.fillStyle = line;
      g.globalAlpha = 0.5;
      g.fillRect(60, 60, 8, 8);
      const t = new T.CanvasTexture(c);
      t.wrapS = t.wrapT = T.RepeatWrapping;
      return t;
    },

    buildDoors() {
      const m = this.map;
      for (const d of m.doors) {
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const [tx, ty] of d.tiles) {
          x0 = Math.min(x0, tx); x1 = Math.max(x1, tx + 1);
          z0 = Math.min(z0, ty); z1 = Math.max(z1, ty + 1);
        }
        const g = new T.Group();
        const body = new T.Mesh(
          new T.BoxGeometry(x1 - x0, WALL_H, z1 - z0),
          new T.MeshLambertMaterial({ color: 0x6b4a1f })
        );
        body.position.set((x0 + x1) / 2, WALL_H / 2, (z0 + z1) / 2);
        g.add(body);

        // hazard bar + a pulsing lock light
        const bar = new T.Mesh(
          new T.BoxGeometry((x1 - x0) * 1.01, 0.28, (z1 - z0) * 1.01),
          new T.MeshBasicMaterial({ color: 0xffb648 })
        );
        bar.position.set((x0 + x1) / 2, WALL_H * 0.62, (z0 + z1) / 2);
        g.add(bar);
        g.userData.bar = bar;
        this.doorGroup.add(g);
        this.doorMeshes.set(d.id, g);
      }
    },

    buildProps() {
      const S = window.SPRITES;
      for (const p of this.map.props) {
        const g = new T.Group();
        g.position.set(p.x, 0, p.y);

        if (p.type === 'wallbuy') {
          const tex = new T.CanvasTexture(S.props.wallbuy[p.weapon]);
          const panel = new T.Mesh(new T.PlaneGeometry(1.7, 1.28),
            new T.MeshBasicMaterial({ map: tex, transparent: true }));
          panel.position.y = 1.5;
          // face away from whichever wall it is bolted to
          panel.rotation.y = [0, -Math.PI / 2, Math.PI, Math.PI / 2][p.face || 0];
          g.add(panel);
        } else if (p.type === 'perk') {
          const P = window.SHARED.PERKS[p.perk];
          const col = new T.Color(P.color);
          const body = new T.Mesh(new T.BoxGeometry(0.85, 1.9, 0.7),
            new T.MeshLambertMaterial({ color: 0x1b242c }));
          body.position.y = 0.95;
          g.add(body);
          const face = new T.Mesh(new T.PlaneGeometry(0.62, 1.2),
            new T.MeshBasicMaterial({ color: col }));
          face.position.set(0, 1.15, 0.36);
          g.add(face);
          const lamp = new T.Mesh(new T.BoxGeometry(0.9, 0.1, 0.75),
            new T.MeshBasicMaterial({ color: col }));
          lamp.position.y = 1.95;
          g.add(lamp);
          g.rotation.y = [0, -Math.PI / 2, Math.PI, Math.PI / 2][p.face || 0];
        } else if (p.type === 'box') {
          const crate = new T.Mesh(new T.BoxGeometry(1.3, 0.95, 1.0),
            new T.MeshLambertMaterial({ color: 0x8a6a34 }));
          crate.position.y = 0.48;
          g.add(crate);
          const rim = new T.Mesh(new T.BoxGeometry(1.36, 0.09, 1.06),
            new T.MeshBasicMaterial({ color: 0xffb648 }));
          rim.position.y = 0.95;
          g.add(rim);
          const halo = this.glowSprite(0x7cf9ff, 1.7);
          halo.position.y = 1.6;
          g.add(halo);
          g.userData.bob = halo;
        } else if (p.type === 'pap') {
          const mat = new T.MeshLambertMaterial({ color: 0x1c252e });
          for (const s of [-1, 1]) {
            const leg = new T.Mesh(new T.BoxGeometry(0.36, 2.3, 0.5), mat);
            leg.position.set(s * 0.85, 1.15, 0);
            g.add(leg);
          }
          const top = new T.Mesh(new T.BoxGeometry(2.1, 0.4, 0.5), mat);
          top.position.y = 2.35;
          g.add(top);
          const core = new T.Mesh(new T.PlaneGeometry(1.35, 1.9),
            new T.MeshBasicMaterial({
              color: 0xb98cff, transparent: true, opacity: 0.35,
              side: T.DoubleSide, blending: T.AdditiveBlending, depthWrite: false
            }));
          core.position.y = 1.25;
          g.add(core);
          g.userData.core = core;
        } else if (p.type === 'power') {
          const panel = new T.Mesh(new T.BoxGeometry(0.9, 1.1, 0.22),
            new T.MeshLambertMaterial({ color: 0x1a232b }));
          panel.position.y = 1.4;
          g.add(panel);
          const lamp = new T.Mesh(new T.PlaneGeometry(0.55, 0.3),
            new T.MeshBasicMaterial({ color: 0xff4d5e }));
          lamp.position.set(0, 1.62, 0.13);
          g.add(lamp);
          g.userData.lamp = lamp;
          g.rotation.y = [0, -Math.PI / 2, Math.PI, Math.PI / 2][p.face || 0];
        }
        // Every purchasable gets a light shaft running to the ceiling plus a soft
        // halo, so you can pick machines out from across a dim room.
        const accent = this.propAccent(p);
        const shaft = new T.Mesh(
          new T.CylinderGeometry(0.42, 0.16, WALL_H, 10, 1, true),
          new T.MeshBasicMaterial({
            color: accent, transparent: true, opacity: 0.055,
            blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide
          })
        );
        shaft.position.y = WALL_H / 2;
        g.add(shaft);

        const core = new T.Mesh(
          new T.CylinderGeometry(0.045, 0.045, WALL_H, 6),
          new T.MeshBasicMaterial({
            color: accent, transparent: true, opacity: 0.26,
            blending: T.AdditiveBlending, depthWrite: false
          })
        );
        core.position.y = WALL_H / 2;
        g.add(core);

        const halo = this.glowSprite(accent, 1.7);
        halo.position.y = 1.5;
        g.add(halo);
        g.userData.halo = halo;
        g.userData.accent = accent;

        g.userData.prop = p;
        this.propGroup.add(g);
        this.propMeshes.push(g);
      }
    },

    /* Signature colour per machine type — shared by its shaft, halo and light. */
    propAccent(p) {
      if (p.type === 'wallbuy') return new T.Color(window.SHARED.WEAPONS[p.weapon].color).getHex();
      if (p.type === 'perk') return new T.Color(window.SHARED.PERKS[p.perk].color).getHex();
      if (p.type === 'box') return 0xffb648;
      if (p.type === 'pap') return 0xb98cff;
      if (p.type === 'power') return 0x6cff8f;
      return 0x7cf9ff;
    },

    /* Hand the four roving lights to the four nearest machines each frame. */
    updatePropLights(G) {
      const near = [];
      for (const g of this.propMeshes) {
        const p = g.userData.prop;
        const d = Math.hypot(p.x - G.cam.x, p.y - G.cam.y);
        if (d < 17) near.push({ g, d });
      }
      near.sort((a, b) => a.d - b.d);
      for (let i = 0; i < this.propLights.length; i++) {
        const l = this.propLights[i];
        const pick = near[i];
        if (!pick) { l.visible = false; l.intensity = 0; continue; }
        const p = pick.g.userData.prop;
        const dead = (p.type === 'pap' && !G.power) ||
                     (p.type === 'perk' && window.SHARED.PERKS[p.perk].power && !G.power);
        l.visible = true;
        l.color.setHex(pick.g.userData.accent);
        l.position.set(p.x, 1.7, p.y);
        l.intensity = (dead ? 2.5 : 7) + Math.sin(G.time * 2.4 + i) * 1.1;
        if (pick.g.userData.halo) {
          pick.g.userData.halo.material.opacity = dead ? 0.14 : 0.34 + Math.sin(G.time * 2.4 + i) * 0.07;
        }
      }
    },

    glowSprite(color, size) {
      if (!this._glowTex) {
        const c = document.createElement('canvas');
        c.width = c.height = 128;
        const g = c.getContext('2d');
        const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        grd.addColorStop(0, 'rgba(255,255,255,1)');
        grd.addColorStop(0.25, 'rgba(255,255,255,.55)');
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
        this._glowTex = new T.CanvasTexture(c);
      }
      const s = new T.Sprite(new T.SpriteMaterial({
        map: this._glowTex, color, blending: T.AdditiveBlending,
        depthWrite: false, transparent: true
      }));
      s.scale.set(size, size, 1);
      return s;
    },

    // ------------------------------------------------------------ prototypes
    buildProtos() {
      const CH = {
        grunt: { c: 0x8ea3b3, eye: 0xff4d5e, h: 1.70, w: 1.00 },
        drone: { c: 0x79b7ae, eye: 0x5effc0, h: 1.30, w: 0.78 },
        titan: { c: 0xb39472, eye: 0xffb648, h: 2.30, w: 1.45 },
        hunter: { c: 0xa186c4, eye: 0xc77dff, h: 1.85, w: 1.05 }
      };
      for (const kind in CH) this.protos[kind] = this.buildRobot(CH[kind]);
      this.protos.operator = this.buildOperator();
    },

    buildRobot(spec) {
      const g = new T.Group();
      const body = new T.MeshLambertMaterial({ color: spec.c });
      const dark = new T.MeshLambertMaterial({ color: 0x232c34 });
      const eye = new T.MeshBasicMaterial({ color: new T.Color(spec.eye).multiplyScalar(1.25) });
      const w = spec.w, h = spec.h;

      const legH = h * 0.40, torsoH = h * 0.36, headH = h * 0.16;
      let n = 0;
      for (const s of [-1, 1]) {
        const leg = new T.Mesh(new T.BoxGeometry(0.20 * w, legH, 0.24 * w), dark);
        leg.geometry.translate(0, -legH / 2, 0);      // hinge at the hip
        leg.position.set(s * 0.17 * w, legH, 0);
        leg.name = 'leg' + n;
        g.add(leg);

        const arm = new T.Mesh(new T.BoxGeometry(0.16 * w, torsoH * 0.95, 0.18 * w), body);
        arm.geometry.translate(0, -torsoH * 0.475, 0);
        arm.position.set(s * (0.30 * w), legH + torsoH * 0.92, 0);
        arm.name = 'arm' + n;
        g.add(arm);
        n++;
      }

      const torso = new T.Mesh(new T.BoxGeometry(0.52 * w, torsoH, 0.34 * w), body);
      torso.position.y = legH + torsoH / 2;
      g.add(torso);

      const core = new T.Mesh(new T.PlaneGeometry(0.22 * w, 0.12 * w), eye);
      core.position.set(0, legH + torsoH * 0.45, 0.175 * w);
      g.add(core);

      const head = new T.Mesh(new T.BoxGeometry(0.32 * w, headH, 0.30 * w), body);
      head.position.y = legH + torsoH + headH / 2;
      g.add(head);

      const visor = new T.Mesh(new T.PlaneGeometry(0.26 * w, headH * 0.38), eye);
      visor.position.set(0, legH + torsoH + headH * 0.55, 0.152 * w);
      g.add(visor);

      // shoulder plates read the silhouette at distance
      for (const s of [-1, 1]) {
        const pad = new T.Mesh(new T.BoxGeometry(0.18 * w, 0.12 * w, 0.30 * w), dark);
        pad.position.set(s * 0.31 * w, legH + torsoH * 0.94, 0);
        g.add(pad);
      }

      return g;
    },

    /* Resolve the animated limbs on a fresh clone by name. */
    rig(obj) {
      return {
        legs: [obj.getObjectByName('leg0'), obj.getObjectByName('leg1')],
        arms: [obj.getObjectByName('arm0'), obj.getObjectByName('arm1')]
      };
    },

    buildOperator() {
      const g = new T.Group();
      const suit = new T.MeshLambertMaterial({ color: 0x4e7382 });
      const dark = new T.MeshLambertMaterial({ color: 0x1d2a33 });
      const vis = new T.MeshBasicMaterial({ color: 0x7cf9ff });
      let n = 0;
      for (const s of [-1, 1]) {
        const leg = new T.Mesh(new T.BoxGeometry(0.20, 0.78, 0.24), dark);
        leg.geometry.translate(0, -0.39, 0);
        leg.position.set(s * 0.16, 0.78, 0);
        leg.name = 'leg' + n;
        g.add(leg);
        const arm = new T.Mesh(new T.BoxGeometry(0.15, 0.62, 0.17), suit);
        arm.geometry.translate(0, -0.31, 0);
        arm.position.set(s * 0.31, 1.42, 0);
        arm.name = 'arm' + n;
        g.add(arm);
        n++;
      }
      const torso = new T.Mesh(new T.BoxGeometry(0.52, 0.66, 0.32), suit);
      torso.position.y = 1.11; g.add(torso);
      const helm = new T.Mesh(new T.BoxGeometry(0.34, 0.32, 0.32), suit);
      helm.position.y = 1.60; g.add(helm);
      const visor = new T.Mesh(new T.PlaneGeometry(0.28, 0.13), vis);
      visor.position.set(0, 1.62, 0.163); g.add(visor);
      const pack = new T.Mesh(new T.BoxGeometry(0.34, 0.4, 0.16), dark);
      pack.position.set(0, 1.2, -0.22); g.add(pack);
      return g;
    },

    // ----------------------------------------------------------- viewmodel
    buildViewmodel(cls, color) {
      const g = new T.Group();
      const steel = new T.MeshLambertMaterial({ color: 0x33434f });
      const dark = new T.MeshLambertMaterial({ color: 0x161d24 });
      const hot = new T.MeshBasicMaterial({ color: new T.Color(color) });
      const box = (w, h, d, mat, x, y, z) => {
        const mm = new T.Mesh(new T.BoxGeometry(w, h, d), mat);
        mm.position.set(x, y, z);
        g.add(mm);
        return mm;
      };

      const L = { pistol: 0.34, smg: 0.52, rifle: 0.66, shotgun: 0.70, sniper: 0.92, lmg: 0.74, launcher: 0.80 }[cls] || 0.66;
      box(0.09, 0.10, L, steel, 0, 0, -L / 2);                       // receiver
      box(0.06, 0.05, L * 0.55, dark, 0, 0.005, -L - L * 0.18);      // barrel
      box(0.07, 0.16, 0.10, dark, 0, -0.12, 0.02);                   // grip
      box(0.05, 0.10, 0.16, steel, 0, -0.03, 0.12);                  // stock

      if (cls === 'lmg') box(0.13, 0.16, 0.22, dark, 0, -0.13, -0.14);
      else if (cls !== 'pistol' && cls !== 'launcher') box(0.05, 0.17, 0.09, dark, 0, -0.12, -0.12);
      if (cls === 'sniper') box(0.05, 0.05, 0.28, dark, 0, 0.09, -0.24);
      if (cls === 'launcher') box(0.16, 0.16, L * 0.9, steel, 0, 0.02, -L * 0.55);

      const emitter = box(0.05, 0.05, 0.07, hot, 0, 0.005, -L - L * 0.42);
      box(0.02, 0.02, L * 0.42, hot, 0.048, 0.02, -L * 0.55);        // charge rail
      box(0.02, 0.02, L * 0.42, hot, -0.048, 0.02, -L * 0.55);

      const tip = new T.Object3D();
      tip.position.set(0, 0.01, -L - L * 0.48);
      g.add(tip);
      g.userData.tip = tip;
      g.userData.emitter = emitter;
      return g;
    },

    setWeapon(stats) {
      if (this.vmGroup) this.vmScene.remove(this.vmGroup);
      this.vmGroup = this.buildViewmodel(stats.cls, stats.color);
      this.vmScene.add(this.vmGroup);
      this.muzzleLight.color = new T.Color(stats.color);
      this._vmKey = stats.name;
    },

    // -------------------------------------------------------------- effects
    buildSparks() {
      const MAX = 600;
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.Float32BufferAttribute(new Float32Array(MAX * 3), 3));
      geo.setAttribute('color', new T.Float32BufferAttribute(new Float32Array(MAX * 3), 3));
      const mat = new T.PointsMaterial({
        size: 0.09, vertexColors: true, blending: T.AdditiveBlending,
        depthWrite: false, transparent: true, sizeAttenuation: true
      });
      this.sparkSystem = new T.Points(geo, mat);
      this.sparkSystem.frustumCulled = false;
      this.scene.add(this.sparkSystem);
      this.sparkMax = MAX;
    },

    addTracer(from, to, color, width, life) {
      // Skip the first stretch of the beam: at 5cm thick and 40cm from the eye it
      // would otherwise fill half the screen.
      const full = new T.Vector3(to.x - from.x, to.y - from.y, to.z - from.z);
      const total = full.length();
      if (total < 0.01) return;
      const skip = Math.min(1.6, total * 0.35);
      from = {
        x: from.x + (full.x / total) * skip,
        y: from.y + (full.y / total) * skip,
        z: from.z + (full.z / total) * skip
      };
      const dir = new T.Vector3(to.x - from.x, to.y - from.y, to.z - from.z);
      const len = dir.length();
      if (len < 0.01) return;
      const mesh = new T.Mesh(
        new T.BoxGeometry(width * 0.035, width * 0.035, len),
        new T.MeshBasicMaterial({
          color: new T.Color(color), blending: T.AdditiveBlending,
          transparent: true, depthWrite: false
        })
      );
      mesh.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
      mesh.lookAt(to.x, to.y, to.z);
      this.scene.add(mesh);
      this.tracers.push({ mesh, life, max: life });
    },

    addBlast(x, y, z, radius, color) {
      const mesh = new T.Mesh(
        new T.SphereGeometry(1, 14, 10),
        new T.MeshBasicMaterial({
          color: new T.Color(color), blending: T.AdditiveBlending,
          transparent: true, depthWrite: false, opacity: 0.6
        })
      );
      mesh.position.set(x, y, z);
      this.scene.add(mesh);
      const light = new T.PointLight(new T.Color(color), 40, radius * 6, 2);
      light.position.set(x, y, z);
      this.scene.add(light);
      this.blasts.push({ mesh, light, radius, life: 0.55, max: 0.55 });
    },

    // ----------------------------------------------------------------- frame
    draw(G) {
      const cam = this.camera;
      cam.position.set(G.cam.x, EYE + G.bob, G.cam.y);
      cam.rotation.y = -G.cam.a - Math.PI / 2;
      cam.rotation.x = G.cam.pitch;
      cam.rotation.z = G.roll || 0;
      const fov = 78 / (1 + ((G.vm.stats && G.vm.stats.scope ? G.vm.stats.scope : 1.35) - 1) * G.adsT);
      if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }

      this.syncDoors(G);
      this.syncProps(G);
      this.updatePropLights(G);
      this.syncRobots(G);
      this.syncMates(G);
      this.syncPickups(G);
      this.syncSparks(G);
      this.stepEffects(G);
      this.poseViewmodel(G);

      this.gl.render(this.scene, cam);
      if (this.vmGroup) {
        this.gl.autoClear = false;
        this.gl.clearDepth();
        this.gl.render(this.vmScene, this.vmCamera);
        this.gl.autoClear = true;
      }
      this.drawOverlay(G);
    },

    syncDoors(G) {
      for (const [id, g] of this.doorMeshes) {
        const open = G.openDoors.has(id);
        g.visible = !open;
        if (!open && g.userData.bar) {
          g.userData.bar.material.color.setHSL(0.09, 1, 0.5 + Math.sin(G.time * 4) * 0.14);
        }
      }
    },

    syncProps(G) {
      for (const g of this.propMeshes) {
        const p = g.userData.prop;
        if (p.type === 'box') {
          g.position.set(p.x, 0, p.y);                 // the fabricator relocates
          if (g.userData.bob) g.userData.bob.position.y = 1.6 + Math.sin(G.time * 2.2) * 0.12;
        } else if (p.type === 'pap' && g.userData.core) {
          g.userData.core.material.opacity = G.power ? 0.30 + Math.sin(G.time * 3) * 0.14 : 0.05;
        } else if (p.type === 'power' && g.userData.lamp) {
          g.userData.lamp.material.color.set(G.power ? 0x6cff8f : 0xff4d5e);
        }
      }
    },

    syncRobots(G) {
      const live = new Set();
      for (const r of G.robotsView) {
        live.add(r.id);
        let e = this.robots.get(r.id);
        if (!e) {
          const obj = this.protos[r.kind].clone(true);
          this.scene.add(obj);
          e = Object.assign({ obj, kind: r.kind, phase: Math.random() * 6.28 }, this.rig(obj));
          this.robots.set(r.id, e);
        }
        const o = e.obj;
        o.position.set(r.x, 0, r.y);
        o.rotation.y = -r.a - Math.PI / 2;

        if (r.st === 1) {
          const t = 1 - Math.max(0, Math.min(1, (r.dieT || 0) / 0.55));
          o.rotation.z = t * 1.5;
          o.position.y = -t * 0.9;
          o.scale.setScalar(1 - t * 0.25);
        } else {
          o.position.y = 0;
          o.scale.setScalar(1);
          o.rotation.z = 0;
          const sw = Math.sin(G.time * 7 + e.phase);
          if (e.legs[0]) { e.legs[0].rotation.x = sw * 0.55; e.legs[1].rotation.x = -sw * 0.55; }
          if (e.arms[0]) { e.arms[0].rotation.x = -sw * 0.42; e.arms[1].rotation.x = sw * 0.42; }
        }
      }
      for (const [id, e] of this.robots) {
        if (live.has(id)) continue;
        this.scene.remove(e.obj);
        this.robots.delete(id);
      }
    },

    syncMates(G) {
      const live = new Set();
      for (const m of G.matesView) {
        live.add(m.id);
        let e = this.mates.get(m.id);
        if (!e) {
          const obj = this.protos.operator.clone(true);
          this.scene.add(obj);
          e = Object.assign({ obj }, this.rig(obj));
          this.mates.set(m.id, e);
        }
        const o = e.obj;
        o.position.set(m.x, 0, m.y);
        o.rotation.y = -m.a - Math.PI / 2;
        if (m.dn) {
          o.rotation.z = 1.45;
          o.position.y = 0.30;
        } else {
          o.rotation.z = 0;
          o.position.y = 0;
          const sw = Math.sin(G.time * 6 + m.id);
          if (e.legs[0]) { e.legs[0].rotation.x = sw * 0.4; e.legs[1].rotation.x = -sw * 0.4; }
          if (e.arms[0]) { e.arms[0].rotation.x = -sw * 0.3; e.arms[1].rotation.x = sw * 0.3; }
        }
      }
      for (const [id, e] of this.mates) {
        if (live.has(id)) continue;
        this.scene.remove(e.obj);
        this.mates.delete(id);
      }
    },

    syncPickups(G) {
      const live = new Set();
      for (const p of G.pickupsView) {
        live.add(p.id);
        let e = this.pickups.get(p.id);
        if (!e) {
          const col = new T.Color(window.SHARED.POWERUPS[p.kind].color);
          const obj = new T.Group();
          const core = new T.Mesh(new T.IcosahedronGeometry(0.28, 0),
            new T.MeshBasicMaterial({ color: col }));
          obj.add(core);
          obj.add(this.glowSprite(col.getHex(), 1.5));
          this.scene.add(obj);
          e = { obj, core };
          this.pickups.set(p.id, e);
        }
        e.obj.position.set(p.x, 0.85 + Math.sin(G.time * 3 + p.id) * 0.14, p.y);
        e.core.rotation.y = G.time * 2;
        e.core.rotation.x = G.time * 1.3;
      }
      for (const [id, e] of this.pickups) {
        if (live.has(id)) continue;
        this.scene.remove(e.obj);
        this.pickups.delete(id);
      }
    },

    syncSparks(G) {
      const pos = this.sparkSystem.geometry.attributes.position.array;
      const col = this.sparkSystem.geometry.attributes.color.array;
      const n = Math.min(G.sparks.length, this.sparkMax);
      const tmp = new T.Color();
      for (let i = 0; i < n; i++) {
        const s = G.sparks[i];
        pos[i * 3] = s.x; pos[i * 3 + 1] = s.z; pos[i * 3 + 2] = s.y;
        tmp.set(s.color);
        const f = Math.max(0, s.life / s.max);
        col[i * 3] = tmp.r * f; col[i * 3 + 1] = tmp.g * f; col[i * 3 + 2] = tmp.b * f;
      }
      for (let i = n; i < this.sparkMax; i++) { pos[i * 3 + 1] = -999; col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0; }
      this.sparkSystem.geometry.attributes.position.needsUpdate = true;
      this.sparkSystem.geometry.attributes.color.needsUpdate = true;
      this.sparkSystem.geometry.setDrawRange(0, this.sparkMax);
    },

    stepEffects(G) {
      const dt = G.dt || 0.016;
      for (let i = this.tracers.length - 1; i >= 0; i--) {
        const t = this.tracers[i];
        t.life -= dt;
        if (t.life <= 0) {
          this.scene.remove(t.mesh);
          t.mesh.geometry.dispose(); t.mesh.material.dispose();
          this.tracers.splice(i, 1);
        } else t.mesh.material.opacity = Math.max(0, t.life / t.max);
      }
      for (let i = this.blasts.length - 1; i >= 0; i--) {
        const b = this.blasts[i];
        b.life -= dt;
        const k = 1 - b.life / b.max;
        if (b.life <= 0) {
          this.scene.remove(b.mesh); this.scene.remove(b.light);
          b.mesh.geometry.dispose(); b.mesh.material.dispose();
          this.blasts.splice(i, 1);
        } else {
          b.mesh.scale.setScalar(b.radius * (0.25 + k * 1.15));
          b.mesh.material.opacity = 0.85 * (1 - k);
          b.light.intensity = 40 * (1 - k);
        }
      }
      this.muzzleLight.intensity = G.vm.flash * 26;
      if (this.lamp) this.lamp.intensity = 10 + G.vm.flash * 16;
    },

    poseViewmodel(G) {
      if (!this.vmGroup) return;
      const vm = G.vm, ads = G.adsT;
      const sway = 0.02;
      const hipX = 0.17, hipY = -0.15, hipZ = -0.42;
      const adsX = 0.0, adsY = -0.062, adsZ = -0.30;
      this.vmGroup.position.set(
        hipX + (adsX - hipX) * ads + Math.cos(G.bobPhase * 0.5) * sway * (1 - ads),
        hipY + (adsY - hipY) * ads + Math.abs(Math.sin(G.bobPhase)) * sway * (1 - ads) - vm.reloadDip * 0.22,
        hipZ + (adsZ - hipZ) * ads + vm.recoil * 0.07
      );
      this.vmGroup.rotation.set(
        vm.recoil * 0.22 + vm.reloadDip * 0.7,
        (1 - ads) * -0.06 + vm.tilt,
        (1 - ads) * 0.04 + vm.reloadDip * 0.3
      );
    },

    /* Muzzle position in world space, for spawning tracers. */
    /* Derived from the live camera state rather than camera.matrixWorld, which
       is a frame stale when shots are fired during the update step. */
    muzzleWorld(cam) {
      const a = cam.a, fwd = 0.45, side = 0.16;
      return {
        x: cam.x + Math.cos(a) * fwd + Math.sin(a) * side,
        y: EYE - 0.10 + Math.tan(cam.pitch) * fwd,
        z: cam.y + Math.sin(a) * fwd - Math.cos(a) * side
      };
    },

    // ------------------------------------------------------------- overlay
    drawOverlay(G) {
      const ctx = this.fx2dCtx, W = this.fx2d.width, H = this.fx2d.height;
      ctx.clearRect(0, 0, W, H);
      const v = new T.Vector3();
      const toScreen = (x, y, z) => {
        v.set(x, y, z).project(this.camera);
        if (v.z > 1) return null;
        return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, z: v.z };
      };

      ctx.textAlign = 'center';
      for (const m of G.matesView) {
        const p = toScreen(m.x, 1.95, m.y);
        if (!p) continue;
        const d = Math.hypot(m.x - G.cam.x, m.y - G.cam.y);
        if (d > 30) continue;
        ctx.globalAlpha = Math.min(1, (30 - d) / 8);
        ctx.font = '600 13px "Chakra Petch",sans-serif';
        ctx.fillStyle = m.dn ? '#ff6b7a' : '#7cf9ff';
        ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 4;
        ctx.fillText(m.n, p.x, p.y);
        if (m.dn) {
          ctx.font = '600 12px "Share Tech Mono",monospace';
          ctx.fillStyle = '#ffb648';
          ctx.fillText(`DOWN ${Math.ceil(m.bl)}s`, p.x, p.y + 15);
        }
      }

      for (const n of G.popups) {
        const rise = (1 - n.life / n.max) * 0.9;
        const p = toScreen(n.x, n.z + rise, n.y);
        if (!p) continue;
        ctx.globalAlpha = Math.max(0, Math.min(1, n.life / n.max * 1.6));
        ctx.font = `700 ${n.big ? 21 : 15}px "Share Tech Mono",monospace`;
        ctx.fillStyle = n.color;
        ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 4;
        ctx.fillText(n.text, p.x, p.y);
      }

      // Interaction labels float on the machines themselves. Only the closest
      // few are drawn, and any that would land on top of each other are pushed
      // apart vertically — a wall of overlapping prices is unreadable.
      const labels = [];
      for (const g of this.propMeshes) {
        const pr = g.userData.prop;
        const d = Math.hypot(pr.x - G.cam.x, pr.y - G.cam.y);
        if (d > 18) continue;
        const label = G.propLabel(pr);
        if (!label) continue;
        const p = toScreen(pr.x, pr.type === 'wallbuy' ? 2.15 : 2.55, pr.y);
        if (!p) continue;
        labels.push({ p, label, d });
      }
      labels.sort((a, b) => a.d - b.d);
      const shown = labels.slice(0, 3).sort((a, b) => a.p.y - b.p.y);
      for (let i = 1; i < shown.length; i++) {
        const gap = shown[i].p.y - shown[i - 1].p.y;
        if (gap < 26) shown[i].p.y = shown[i - 1].p.y + 26;
      }
      for (const { p, label, d } of shown) {
        ctx.globalAlpha = Math.min(1, (18 - d) / 5);
        ctx.font = `700 ${Math.max(13, Math.min(22, 150 / Math.max(3, d)))}px "Share Tech Mono",monospace`;
        ctx.fillStyle = label.color;
        ctx.shadowColor = 'rgba(0,0,0,.95)'; ctx.shadowBlur = 5;
        ctx.fillText(label.text, p.x, p.y);
      }

      for (const d of G.doorSigns) {
        const p = toScreen(d.x, 2.0, d.y);
        if (!p) continue;
        const dist = Math.hypot(d.x - G.cam.x, d.y - G.cam.y);
        ctx.globalAlpha = Math.min(1, (14 - dist) / 5);
        ctx.font = '700 20px "Share Tech Mono",monospace';
        ctx.fillStyle = '#ffb648';
        ctx.shadowColor = 'rgba(0,0,0,.95)'; ctx.shadowBlur = 6;
        ctx.fillText(`[ ${d.cost} ]`, p.x, p.y);
        ctx.font = '600 12px "Chakra Petch",sans-serif';
        ctx.fillStyle = '#ffe0b0';
        ctx.fillText(d.name, p.x, p.y + 16);
      }

      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }
  };

  R.EYE = EYE;
  R.WALL_H = WALL_H;
  window.Renderer = R;
})();
