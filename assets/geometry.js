/*
 * Board geometry: rebuilds a top-down outline and a schematic side profile
 * from published spec numbers. All units are millimetres.
 *
 * Coordinate system: x runs along the board from the nose tip (x = 0) to the
 * tail end (x = L). y is the half-width (outline is symmetric about y = 0).
 *
 * What is measured vs. modelled:
 *   measured  - length, nose/tail/waist widths, sidecut radius, effective edge,
 *               contact length, nose/tail lengths (Jones, Nidecker), setback,
 *               reference stance
 *   modelled  - the curvature of the nose and tail tips (superellipse), the
 *               nose/tail split when the brand doesn't publish it (Burton), and
 *               the whole side profile (schematic only)
 */
(function (global) {
  'use strict';

  const NOSE_SHARE = { 'Twin': 0.5, 'Directional Twin': 0.52, 'Directional': 0.56 };

  const isNum = (v) => typeof v === 'number' && isFinite(v);

  function tipStyle(board) {
    const o = board.outline || {};
    const shape = board.shape;
    let noseP = shape === 'Directional' ? 2.1 : shape === 'Directional Twin' ? 2.25 : 2.3;
    let tailP = shape === 'Directional' ? 2.7 : shape === 'Directional Twin' ? 2.4 : 2.3;
    let notchDepth = 0, notchWidth = 0;
    if (board.tail_style === 'blunt') tailP = 3.6;
    if (board.tail_style === 'swallow') { tailP = 2.6; notchDepth = 0.32; notchWidth = 0.45; }
    return {
      noseP: o.nose_p || noseP,
      tailP: o.tail_p || tailP,
      notchDepth: o.notch_depth != null ? o.notch_depth : notchDepth,  // fraction of tail length
      notchWidth: o.notch_width != null ? o.notch_width : notchWidth,  // fraction of tail half-width
    };
  }

  function geometry(board, size) {
    const notes = [];
    const L = size.length;
    const Ww = size.waist;
    let Wn = isNum(size.nose_w) ? size.nose_w : null;
    let Wt = isNum(size.tail_w) ? size.tail_w : null;
    const Le = isNum(size.eff_edge) ? size.eff_edge : null;
    const Lc = isNum(size.contact) ? size.contact : null;
    let R = isNum(size.radius) ? size.radius * 1000 : null;

    if (Wn == null && Wt == null) {
      const chord = Le || Lc || 0.75 * L;
      const r = R || 7800;
      const d = r - Math.sqrt(r * r - (chord / 2) ** 2);
      Wn = Wt = Ww + 2 * d;
      notes.push('Nose/tail width estimated from sidecut radius.');
    } else if (Wn == null) {
      Wn = Wt + (size.taper || 0);
    } else if (Wt == null) {
      Wt = Wn - (size.taper || 0);
    }
    const dn = Math.max((Wn - Ww) / 2, 0.5);
    const dt = Math.max((Wt - Ww) / 2, 0.5);
    if (!R) {
      const half = (Le || Lc || 0.75 * L) / 2;
      const d = (dn + dt) / 2;
      R = (half * half + d * d) / (2 * d);
      notes.push('Sidecut radius estimated from effective edge.');
    }

    // Sidecut: circular arc, deepest at the waist, reaching the published
    // nose and tail widths. Its chord is the distance between widest points.
    let an = Math.sqrt(Math.max(0, 2 * R * dn - dn * dn));
    let at = Math.sqrt(Math.max(0, 2 * R * dt - dt * dt));
    let chord = an + at;
    const ref = Lc || Le || 0.72 * L;
    if (!(chord > 0.5 * L && chord < 0.9 * L)) {
      const k = ref / chord;
      an *= k; at *= k; chord = ref;
      notes.push('Sidecut length adjusted to fit the board.');
    }
    const rn = (an * an + dn * dn) / (2 * dn);
    const rt = (at * at + dt * dt) / (2 * dt);

    // Split the remaining length between nose and tail tips.
    let share = NOSE_SHARE[board.shape] != null ? NOSE_SHARE[board.shape] : 0.53;
    let splitMeasured = false;
    if (isNum(size.nose_len) && isNum(size.tail_len)) {
      share = size.nose_len / (size.nose_len + size.tail_len);
      splitMeasured = true;
    }
    const tips = L - chord;
    const N = tips * share;
    const T = tips - N;
    const xn = N, xw = N + an, xt = N + chord;

    const st = tipStyle(board);
    const pts = [];
    const STEPS = 48;
    // nose tip: superellipse quadrant from (0,0) to (xn, Wn/2)
    for (let i = 0; i <= STEPS; i++) {
      const th = (i / STEPS) * Math.PI / 2;
      const c = Math.cos(th), s = Math.sin(th);
      pts.push([xn - N * Math.pow(c, 2 / st.noseP), (Wn / 2) * Math.pow(s, 2 / st.noseP)]);
    }
    // sidecut
    const SC = 90;
    for (let i = 1; i < SC; i++) {
      const x = xn + (chord * i) / SC;
      const r = x <= xw ? rn : rt;
      const dx = x - xw;
      pts.push([x, Ww / 2 + r - Math.sqrt(Math.max(0, r * r - dx * dx))]);
    }
    // tail tip (optionally notched / swallowtail)
    const notchH = st.notchWidth * (Wt / 2);
    for (let i = STEPS; i >= 0; i--) {
      const th = (i / STEPS) * Math.PI / 2;
      const c = Math.cos(th), s = Math.sin(th);
      const p = [xt + T * Math.pow(c, 2 / st.tailP), (Wt / 2) * Math.pow(s, 2 / st.tailP)];
      if (st.notchDepth > 0 && p[1] < notchH) {
        pts.push(p);
        pts.push([L - st.notchDepth * T, 0]);
        break;
      }
      pts.push(p);
    }

    // stance: setback is measured from the middle of the sidecut
    const sidecutMid = (xn + xt) / 2;
    const stanceCenter = sidecutMid + (isNum(size.setback) ? size.setback : 0);
    const refStance = isNum(size.ref_stance) ? size.ref_stance : null;

    // contact points (for the side view)
    let c1, c2;
    if (isNum(size.nose_len) && isNum(size.tail_len)) {
      c1 = size.nose_len; c2 = L - size.tail_len;
    } else {
      const contact = Lc || chord;
      c1 = sidecutMid - contact / 2; c2 = sidecutMid + contact / 2;
    }

    return {
      L, Wn, Wt, Ww, R, xn, xw, xt, N, T, chord, splitMeasured,
      sidecutDepth: (dn + dt) / 2,
      center: L / 2, sidecutMid, stanceCenter, refStance,
      stance: refStance ? [stanceCenter - refStance / 2, stanceCenter + refStance / 2] : null,
      stanceRange: size.stance_range || null,
      contact: [c1, c2],
      upper: pts,
      notes,
    };
  }

  // Half-width at x (outermost edge), or null if off the board.
  function halfWidthAt(g, x) {
    if (x < 0 || x > g.L) return null;
    let best = null;
    const p = g.upper;
    for (let i = 1; i < p.length; i++) {
      const [x0, y0] = p[i - 1], [x1, y1] = p[i];
      if ((x >= x0 && x <= x1) || (x >= x1 && x <= x0)) {
        const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
        const y = y0 + t * (y1 - y0);
        if (best == null || y > best) best = y;
      }
    }
    return best;
  }

  function outlinePath(g, offset, scaleY) {
    const sy = scaleY || 1;
    const up = g.upper.map(([x, y]) => `${(x + offset).toFixed(2)},${(-y * sy).toFixed(2)}`);
    const lo = g.upper.slice().reverse().map(([x, y]) => `${(x + offset).toFixed(2)},${(y * sy).toFixed(2)}`);
    return 'M' + up.join('L') + 'L' + lo.join('L') + 'Z';
  }

  // ---- schematic side profile -------------------------------------------
  // Monotone cubic (Fritsch–Carlson) interpolation through key points.
  function monotone(xs, ys) {
    const n = xs.length;
    const d = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
      if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    return function (x) {
      let i = 0;
      while (i < n - 2 && x > xs[i + 1]) i++;
      const h = xs[i + 1] - xs[i], t = Math.min(1, Math.max(0, (x - xs[i]) / h));
      const t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] +
             (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    };
  }

  const PROFILE_LABEL = {
    camber: 'Camber',
    camrock: 'Hybrid camber (CamRock)',
    directional_camrock: 'Directional hybrid camber',
    directional_camber: 'Directional camber (rockered nose)',
    flat: 'Flat',
    directional_flat: 'Directional flat (rockered nose)',
    rocker: 'Rocker',
    hybrid_rocker: 'Hybrid rocker (Flying V)',
  };

  // Returns [x, z] display points. Camber/rocker (a few mm in reality) are
  // multiplied by `exag`; the tip kick is drawn at a fixed TIP_SCALE so the
  // view stays readable.
  const TIP_SCALE = 1.6;
  function profile(board, g, exag) {
    const E = exag || 1;
    const C = 6 * E, Rk = 9 * E;
    const hn = (board.shape === 'Directional' ? 72 : 60) * TIP_SCALE;
    const ht = (board.shape === 'Twin' ? 60 : 50) * TIP_SCALE;
    const [c1, c2] = g.contact;
    const sc = g.stanceCenter;
    const half = g.refStance ? g.refStance / 2 : (c2 - c1) * 0.24;
    const f1 = sc - half, f2 = sc + half;
    const kp = {
      camber: [[c1, 0], [f1, 0.75 * C], [sc, C], [f2, 0.75 * C], [c2, 0]],
      flat: [[c1, 0], [sc, 0], [c2, 0]],
      rocker: [[c1, Rk], [sc, 0], [c2, Rk]],
      camrock: [[c1, Rk], [f1, 0], [sc, 0.8 * C], [f2, 0], [c2, Rk]],
      directional_camrock: [[c1, 1.6 * Rk], [f1, 0], [sc, 0.8 * C], [f2, 0], [c2, 0.6 * Rk]],
      directional_camber: [[c1, 1.6 * Rk], [f1, 0], [sc, 0.8 * C], [f2, 0.6 * C], [c2, 0]],
      directional_flat: [[c1, 1.6 * Rk], [f1, 0], [c2, 0]],
      hybrid_rocker: [[c1, Rk], [f1, 0], [(f1 + sc) / 2, 0.5 * C], [sc, 0], [(sc + f2) / 2, 0.5 * C], [f2, 0], [c2, Rk]],
    }[board.profile] || [[c1, 0], [sc, C], [c2, 0]];
    kp.sort((a, b) => a[0] - b[0]);
    const xs = [], ys = [];
    kp.forEach(([x, y]) => { if (!xs.length || x - xs[xs.length - 1] > 5) { xs.push(x); ys.push(y); } });
    const core = monotone(xs, ys);
    const z1 = core(c1), z2 = core(c2);
    const pts = [];
    const n = 160;
    for (let i = 0; i <= n; i++) {
      const x = (g.L * i) / n;
      let z;
      if (x < c1) z = z1 + Math.max(hn - z1, 0) * Math.pow((c1 - x) / c1, 2.2);
      else if (x > c2) z = z2 + Math.max(ht - z2, 0) * Math.pow((x - c2) / (g.L - c2), 2.2);
      else z = core(x);
      pts.push([x, z]);
    }
    return pts;
  }

  const PROFILE_MAX_Z = (exag) => Math.max(72 * TIP_SCALE, 1.6 * 9 * (exag || 1) + 30);

  global.BoardGeometry = { geometry, halfWidthAt, outlinePath, profile, PROFILE_LABEL, PROFILE_MAX_Z };
})(window);
