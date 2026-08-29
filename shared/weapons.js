/* Shared weapon / perk / enemy tables. Loaded by both the Node server and the browser. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SHARED = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // dmg      : damage per projectile
  // rpm      : rounds per minute
  // mag      : magazine size
  // reserve  : spare ammo on purchase
  // reload   : seconds
  // spread   : degrees of cone at the hip
  // pellets  : projectiles per trigger pull
  // pierce   : how many robots one shot punches through
  // range    : max effective range in tiles
  // splash   : explosion radius in tiles (0 = none)
  const WEAPONS = {
    sidearm: {
      id: 'sidearm', name: 'M7 Pulse Sidearm', cls: 'pistol',
      dmg: 40, rpm: 400, mag: 12, reserve: 120, reload: 1.4, spread: 1.4,
      pellets: 1, pierce: 0, range: 30, splash: 0, auto: false,
      color: '#59f7ff', beam: 0.9,
      pap: { name: 'M7 "Bluewidow"', dmg: 190, mag: 24, reserve: 240, pierce: 1 }
    },
    carbine: {
      id: 'carbine', name: 'PLS-1 Pulsar Carbine', cls: 'rifle',
      dmg: 58, rpm: 545, mag: 32, reserve: 288, reload: 2.1, spread: 1.9,
      pellets: 1, pierce: 1, range: 42, splash: 0, auto: true,
      color: '#7cf9ff', beam: 1.0,
      pap: { name: 'PLS-1 "Nova Lance"', dmg: 235, mag: 48, reserve: 432, pierce: 2 }
    },
    repeater: {
      id: 'repeater', name: 'ARC-9 Arc Repeater', cls: 'smg',
      dmg: 38, rpm: 900, mag: 45, reserve: 360, reload: 1.9, spread: 3.0,
      pellets: 1, pierce: 0, range: 26, splash: 0, auto: true,
      color: '#b98cff', beam: 0.8,
      pap: { name: 'ARC-9 "Stormfeed"', dmg: 160, mag: 70, reserve: 490, pierce: 1 }
    },
    scatter: {
      id: 'scatter', name: 'HX Plasma Scattergun', cls: 'shotgun',
      dmg: 46, rpm: 80, mag: 8, reserve: 64, reload: 2.9, spread: 7.5,
      pellets: 9, pierce: 1, range: 13, splash: 0, auto: false,
      color: '#ff9a4d', beam: 1.6,
      pap: { name: 'HX "Sunbreaker"', dmg: 150, mag: 12, reserve: 96, pierce: 3 }
    },
    lance: {
      id: 'lance', name: 'VX Photon Lance', cls: 'sniper',
      dmg: 620, rpm: 58, mag: 6, reserve: 48, reload: 3.1, spread: 0.2,
      pellets: 1, pierce: 5, range: 90, splash: 0, auto: false,
      color: '#fff05e', beam: 2.4, scope: 2.6,
      pap: { name: 'VX "Sunspear"', dmg: 2100, mag: 10, reserve: 80, pierce: 9 }
    },
    ionstorm: {
      id: 'ionstorm', name: 'IO-9 Ion Storm', cls: 'lmg',
      dmg: 64, rpm: 700, mag: 100, reserve: 400, reload: 4.4, spread: 2.6,
      pellets: 1, pierce: 2, range: 48, splash: 0, auto: true,
      color: '#5effc0', beam: 1.2,
      pap: { name: 'IO-9 "Tempest Core"', dmg: 270, mag: 150, reserve: 600, pierce: 4 }
    },
    singularity: {
      id: 'singularity', name: 'SG-0 Singularity Launcher', cls: 'launcher',
      dmg: 900, rpm: 42, mag: 4, reserve: 20, reload: 3.6, spread: 0.6,
      pellets: 1, pierce: 0, range: 60, splash: 4.2, auto: false,
      color: '#ff5ec8', beam: 3.0,
      pap: { name: 'SG-0 "Event Horizon"', dmg: 2600, mag: 6, reserve: 30, splash: 6.0 }
    },
    railgun: {
      id: 'railgun', name: 'GX Rail Repeater', cls: 'rifle',
      dmg: 130, rpm: 260, mag: 20, reserve: 180, reload: 2.4, spread: 1.1,
      pellets: 1, pierce: 3, range: 60, splash: 0, auto: true,
      color: '#8fd0ff', beam: 1.4,
      pap: { name: 'GX "Threadcutter"', dmg: 520, mag: 30, reserve: 270, pierce: 6 }
    }
  };

  // Everything except the starting sidearm can drop from the Fabricator.
  const BOX_POOL = ['carbine', 'repeater', 'scatter', 'lance', 'ionstorm', 'singularity', 'railgun'];

  const PERKS = {
    plating:  { id: 'plating',  name: 'Alloy Plating',   cost: 2500, power: true,  color: '#ff5252', blurb: 'Chassis integrity x2.5' },
    reload:   { id: 'reload',   name: 'Rapid Cycler',    cost: 3000, power: true,  color: '#6cff8f', blurb: 'Reload twice as fast' },
    overdrive:{ id: 'overdrive',name: 'Overdrive Core',  cost: 2000, power: true,  color: '#ffd23f', blurb: '+35% rate of fire' },
    nano:     { id: 'nano',     name: 'Nanorepair Cell', cost: 1500, power: false, color: '#4fc3ff', blurb: 'Faster revives, self-repair solo' },
    kinetic:  { id: 'kinetic',  name: 'Kinetic Boost',   cost: 2000, power: true,  color: '#c77dff', blurb: '+25% movement speed' }
  };

  // Robot roster. `height` is the chassis height in world units and drives the
  // vertical hit test — the top ~24% counts as a headshot.
  const ROBOTS = {
    grunt:  { id: 'grunt',  hp: 1.00, speed: 1.00, dmg: 22, radius: 0.34, score: 100, scale: 1.00, height: 1.70 },
    drone:  { id: 'drone',  hp: 0.55, speed: 1.55, dmg: 14, radius: 0.28, score: 130, scale: 0.78, height: 1.30 },
    titan:  { id: 'titan',  hp: 4.20, speed: 0.68, dmg: 44, radius: 0.52, score: 240, scale: 1.45, height: 2.30 },
    hunter: { id: 'hunter', hp: 2.10, speed: 1.32, dmg: 30, radius: 0.38, score: 300, scale: 1.10, height: 1.85 }
  };

  const POWERUPS = {
    maxammo:   { id: 'maxammo',   name: 'RESUPPLY',      color: '#7cf9ff' },
    emp:       { id: 'emp',       name: 'EMP SURGE',     color: '#b98cff' },
    overcharge:{ id: 'overcharge',name: 'OVERCHARGE',    color: '#ffd23f' },
    doubles:   { id: 'doubles',   name: 'DOUBLE CREDITS',color: '#6cff8f' },
    repair:    { id: 'repair',    name: 'FIELD REPAIR',  color: '#ff6b8a' }
  };

  const CONST = {
    PLAYER_RADIUS: 0.28,
    PLAYER_SPEED: 3.35,
    SPRINT_MULT: 1.5,
    BASE_HP: 100,
    REGEN_DELAY: 3.4,
    REGEN_RATE: 34,
    BLEEDOUT: 42,
    REVIVE_TIME: 4.2,
    CRAWL_SPEED: 1.0,
    PAP_COST: 5000,
    BOX_COST: 950,
    GRENADE_DMG: 620,
    GRENADE_RADIUS: 4.0,
    MAX_GRENADES: 4,
    HIT_POINTS: 10,
    TICK: 1 / 30,
    NET_HZ: 20
  };

  // Resolve a weapon instance -> stat block (applies Pack-a-Punch overrides).
  function statsFor(inst) {
    const base = WEAPONS[inst.id];
    if (!base) return null;
    const out = Object.assign({}, base);
    if (inst.pap && base.pap) Object.assign(out, base.pap);
    out.id = base.id;
    out.base = base;
    out.papped = !!inst.pap;
    return out;
  }

  return { WEAPONS, BOX_POOL, PERKS, ROBOTS, POWERUPS, CONST, statsFor };
});
