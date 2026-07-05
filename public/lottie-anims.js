/* LeadScout — inline Lottie (bodymovin) animations for payment result screens.
 * Authored by hand as valid Lottie JSON so lottie-web can render them with no
 * network fetch. Each is a 200x200, 30fps, play-once (loop:false) animation that
 * "draws on" a stroked shape via an animated trim path.
 *
 *   window.LOTTIE_SUCCESS — a green checkmark drawing in, then a ring drawing in.
 *   window.LOTTIE_FAIL    — a red circle drawing in, then an X drawing in.
 *
 * Colors match the app theme: accent #2dd4bf (0.176,0.831,0.749) and a soft
 * red #f87171 (0.973,0.443,0.443).
 */
(function () {
  'use strict';

  // Easing helpers for keyframes.
  var easeOut = { x: [0.33], y: [1] };
  var easeIn = { x: [0.66], y: [0] };

  // A single stroked, trim-path-animated shape group.
  // pts: array of [x,y] vertices (open polyline), color: [r,g,b], width: px,
  // start/end frames for the draw-on trim animation.
  function drawGroup(pts, color, width, ipf, opf, closed) {
    return {
      ty: 'gr',
      nm: 'stroke-group',
      it: [
        {
          ty: 'sh',
          nm: 'path',
          ks: {
            a: 0,
            k: {
              i: pts.map(function () { return [0, 0]; }),
              o: pts.map(function () { return [0, 0]; }),
              v: pts,
              c: !!closed,
            },
          },
        },
        {
          ty: 'tm', // trim path — animates the "draw on"
          nm: 'trim',
          s: { a: 0, k: 0 },
          e: {
            a: 1,
            k: [
              { t: ipf, s: [0], i: easeOut, o: easeIn },
              { t: opf, s: [100] },
            ],
          },
          o: { a: 0, k: 0 },
          m: 1,
        },
        {
          ty: 'st', // stroke
          nm: 'stroke',
          c: { a: 0, k: [color[0], color[1], color[2], 1] },
          o: { a: 0, k: 100 },
          w: { a: 0, k: width },
          lc: 2, // round cap
          lj: 2, // round join
          ml: 4,
        },
        {
          ty: 'tr', // group transform (required)
          p: { a: 0, k: [0, 0] },
          a: { a: 0, k: [0, 0] },
          s: { a: 0, k: [100, 100] },
          r: { a: 0, k: 0 },
          o: { a: 0, k: 100 },
          sk: { a: 0, k: 0 },
          sa: { a: 0, k: 0 },
        },
      ],
    };
  }

  function shapeLayer(ind, name, group, ip, op) {
    return {
      ddd: 0,
      ind: ind,
      ty: 4, // shape layer
      nm: name,
      sr: 1,
      ks: {
        o: { a: 0, k: 100 },
        r: { a: 0, k: 0 },
        p: { a: 0, k: [100, 100, 0] }, // center of the 200x200 canvas
        a: { a: 0, k: [0, 0, 0] },
        s: { a: 0, k: [100, 100, 100] },
      },
      ao: 0,
      shapes: [group],
      ip: ip,
      op: op,
      st: 0,
      bm: 0,
    };
  }

  function comp(name, layers) {
    return {
      v: '5.7.4',
      fr: 30,
      ip: 0,
      op: 60,
      w: 200,
      h: 200,
      nm: name,
      ddd: 0,
      assets: [],
      layers: layers,
    };
  }

  var GREEN = [0.176, 0.831, 0.749];
  var RED = [0.973, 0.443, 0.443];

  // Approximate a circle (radius r) with a 4-segment closed cubic-ish polyline.
  // A simple 12-point closed polygon reads as a smooth ring at these sizes.
  function circlePts(r) {
    var out = [];
    for (var i = 0; i < 24; i++) {
      var a = (i / 24) * Math.PI * 2 - Math.PI / 2;
      out.push([Math.round(Math.cos(a) * r * 100) / 100, Math.round(Math.sin(a) * r * 100) / 100]);
    }
    return out;
  }

  // ---- Success: ring draws in (frames 0-30), checkmark draws in (frames 14-40).
  window.LOTTIE_SUCCESS = comp('success', [
    shapeLayer(1, 'check', drawGroup([[-34, 2], [-10, 28], [40, -30]], GREEN, 13, 14, 40, false), 0, 60),
    shapeLayer(2, 'ring', drawGroup(circlePts(62), GREEN, 9, 0, 32, true), 0, 60),
  ]);

  // ---- Failure: ring draws in (frames 0-30), X draws in (two strokes 12-42).
  window.LOTTIE_FAIL = comp('fail', [
    shapeLayer(1, 'cross-b', drawGroup([[30, -30], [-30, 30]], RED, 13, 20, 44, false), 0, 60),
    shapeLayer(2, 'cross-a', drawGroup([[-30, -30], [30, 30]], RED, 13, 12, 38, false), 0, 60),
    shapeLayer(3, 'ring', drawGroup(circlePts(62), RED, 9, 0, 32, true), 0, 60),
  ]);
})();
