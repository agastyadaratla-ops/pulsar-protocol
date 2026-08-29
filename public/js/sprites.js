/* Canvas textures used by the 3D scene. Robots, operators and machines are real
   meshes now — these are the flat panels that read better as artwork: the
   wall-buy holograms and the perk chip faces. */
(function () {
  'use strict';

  function make(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return { c, g: c.getContext('2d') };
  }

  function round(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function wallbuySprite(color, label) {
    const W = 256, H = 192;
    const { c, g } = make(W, H);
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(6,20,28,.80)';
    round(g, 8, 8, W - 16, H - 16, 12); g.fill();
    g.strokeStyle = color; g.lineWidth = 3;
    g.shadowColor = color; g.shadowBlur = 18;
    round(g, 8, 8, W - 16, H - 16, 12); g.stroke();
    g.shadowBlur = 0;

    // stylised weapon silhouette
    g.fillStyle = '#0b1218';
    g.fillRect(46, 84, 148, 20);
    g.fillRect(72, 104, 26, 34);
    g.fillRect(130, 70, 42, 16);
    g.fillRect(32, 80, 20, 26);
    g.save();
    g.shadowColor = color; g.shadowBlur = 20; g.fillStyle = color;
    g.fillRect(180, 88, 36, 12); g.fillRect(180, 88, 36, 12);
    g.fillRect(98, 74, 36, 6);
    g.restore();

    g.fillStyle = color;
    g.font = '700 24px "Share Tech Mono",monospace';
    g.textAlign = 'center';
    g.fillText(label, W / 2, 164);
    return c;
  }

  function perkSprite(color, letter) {
    const W = 192, H = 320;
    const { c, g } = make(W, H);
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(4,10,15,.9)';
    round(g, 6, 6, W - 12, H - 12, 10); g.fill();
    g.save();
    g.shadowColor = color; g.shadowBlur = 40;
    g.fillStyle = color; g.globalAlpha = 0.9;
    g.beginPath(); g.arc(W / 2, 120, 56, 0, 6.3); g.fill();
    g.restore();
    g.fillStyle = '#04070c';
    g.font = '700 64px "Chakra Petch",sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(letter, W / 2, 124);
    g.strokeStyle = color; g.lineWidth = 3; g.globalAlpha = 0.85;
    g.strokeRect(28, 214, W - 56, 46);
    g.globalAlpha = 1;
    g.fillStyle = color;
    g.font = '600 22px "Share Tech Mono",monospace';
    g.fillText('INSERT', W / 2, 238);
    return c;
  }

  const S = { props: { wallbuy: {}, perk: {} } };

  function build() {
    const W = window.SHARED.WEAPONS;
    for (const id in W) S.props.wallbuy[id] = wallbuySprite(W[id].color, W[id].name.split(' ')[0]);
    const P = window.SHARED.PERKS;
    for (const id in P) S.props.perk[id] = perkSprite(P[id].color, P[id].name[0]);
  }

  window.SPRITES = S;
  window.buildSprites = build;
})();
