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
 *
 * Outline construction, nose to tail:
 *
 *   nose tip           sidecut (two circular arcs)            tail tip
 *   |<--- N --->|<-------------- chord -------------->|<--- T --->|
 *   x=0         xn               xw                   xt          x=L
 *               widest nose      waist (narrowest)    widest tail
 *
 * Exposed on window.BoardGeometry for assets/app.js.
 */
(function (global) {
  'use strict';

  // When a brand doesn't publish nose/tail lengths, this is the fraction of
  // the non-sidecut length (the two tips together) given to the nose.
  // Directional boards get a longer nose.
  const NOSE_SHARE = { 'Twin': 0.5, 'Directional Twin': 0.52, 'Directional': 0.56 };

  const isNum = (v) => typeof v === 'number' && isFinite(v);

  // Superellipse exponents for drawing the nose and tail tips. 2 gives an
  // elliptical curve; higher values give a squarer, blunter tip. Values in
  // board.outline (set via scraper/overrides.json) take precedence.
  function tipStyle(board) {
    const o = board.outline || {};
    const shape = board.shape;
    // Directional boards: rounder, more pointed nose and a squarer tail.
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

  /**
   * Build the outline and key positions for one board size.
   *
   * @param board  board record from data/boards.js (shape, tail_style, outline)
   * @param size   one entry of board.sizes (lengths in mm, radius in m)
   * @returns object with
   *   L, Wn, Wt, Ww     length, nose/tail/waist widths (mm)
   *   R                 sidecut radius (mm)
   *   xn, xw, xt        x of widest nose point, waist, widest tail point
   *   N, T, chord       nose tip, tail tip and sidecut lengths along x
   *   splitMeasured     true if the nose/tail split came from published lengths
   *   sidecutDepth      average depth of the sidecut (mm)
   *   center, sidecutMid, stanceCenter   reference x positions
   *   refStance, stance [front, back] binding x positions, or null
   *   stanceRange       [min, max] stance width from the data, or null
   *   contact           [nose, tail] contact-point x positions for the side view
   *   upper             [[x, y], ...] half-outline from nose tip to tail end
   *   notes             strings describing anything that had to be estimated
   */
  function geometry(board, size) {
    const notes = [];
    const L = size.length;
    const Ww = size.waist;
    let Wn = isNum(size.nose_w) ? size.nose_w : null;
    let Wt = isNum(size.tail_w) ? size.tail_w : null;
    const Le = isNum(size.eff_edge) ? size.eff_edge : null;
    const Lc = isNum(size.contact) ? size.contact : null;
    let R = isNum(size.radius) ? size.radius * 1000 : null;  // m -> mm

    // ---- fill in missing widths
    if (Wn == null && Wt == null) {
      // Neither published: the tips are as much wider than the waist as the
      // sidecut arc is deep. Depth of an arc of radius r over a chord c (its
      // sagitta) is r - sqrt(r^2 - (c/2)^2). Defaults: 75% of length, 7.8 m.
      const chord = Le || Lc || 0.75 * L;
      const r = R || 7800;
      const d = r - Math.sqrt(r * r - (chord / 2) ** 2);
      Wn = Wt = Ww + 2 * d;
      notes.push('Nose/tail width estimated from sidecut radius.');
    } else if (Wn == null) {
      // One published: taper = nose width - tail width.
      Wn = Wt + (size.taper || 0);
    } else if (Wt == null) {
      Wt = Wn - (size.taper || 0);
    }
    // Sidecut depth on the nose and tail side (half the width difference to
    // the waist). The 0.5 mm floor avoids dividing by zero below.
    const dn = Math.max((Wn - Ww) / 2, 0.5);
    const dt = Math.max((Wt - Ww) / 2, 0.5);
    if (!R) {
      // Radius of the circle through the waist and both widest points:
      // R = (h^2 + d^2) / (2d), with h = half the chord and d = the depth.
      const half = (Le || Lc || 0.75 * L) / 2;
      const d = (dn + dt) / 2;
      R = (half * half + d * d) / (2 * d);
      notes.push('Sidecut radius estimated from effective edge.');
    }

    // Sidecut: circular arc, deepest at the waist, reaching the published
    // nose and tail widths. Its chord is the distance between widest points.
    // From (R - d)^2 + a^2 = R^2, the distance along x from the waist to the
    // point where the arc is d deep is a = sqrt(2Rd - d^2).
    let an = Math.sqrt(Math.max(0, 2 * R * dn - dn * dn));
    let at = Math.sqrt(Math.max(0, 2 * R * dt - dt * dt));
    let chord = an + at;
    const ref = Lc || Le || 0.72 * L;
    // If the published numbers don't agree (the chord comes out shorter than
    // half the board or longer than 90% of it), stretch the sidecut to the
    // contact length / effective edge instead.
    if (!(chord > 0.5 * L && chord < 0.9 * L)) {
      const k = ref / chord;
      an *= k; at *= k; chord = ref;
      notes.push('Sidecut length adjusted to fit the board.');
    }
    // Radius for each half so its arc runs exactly from the waist to the
    // widest point. With taper the two halves differ, which moves the waist
    // off-centre.
    const rn = (an * an + dn * dn) / (2 * dn);
    const rt = (at * at + dt * dt) / (2 * dt);

    // Split the remaining length between nose and tail tips.
    let share = NOSE_SHARE[board.shape] != null ? NOSE_SHARE[board.shape] : 0.53;
    let splitMeasured = false;
    if (isNum(size.nose_len) && isNum(size.tail_len)) {
      share = size.nose_len / (size.nose_len + size.tail_len);
      splitMeasured = true;
    }
    const tips = L - chord;  // total length of both tips
    const N = tips * share;  // nose tip length
    const T = tips - N;      // tail tip length
    const xn = N, xw = N + an, xt = N + chord;

    const st = tipStyle(board);
    const pts = [];  // half-outline points [x, y], traced nose -> tail
    const STEPS = 48;
    // nose tip: superellipse quadrant from (0,0) to (xn, Wn/2)
    // Parametric form: x = a*cos(t)^(2/p), y = b*sin(t)^(2/p).
    for (let i = 0; i <= STEPS; i++) {
      const th = (i / STEPS) * Math.PI / 2;
      const c = Math.cos(th), s = Math.sin(th);
      pts.push([xn - N * Math.pow(c, 2 / st.noseP), (Wn / 2) * Math.pow(s, 2 / st.noseP)]);
    }
    // sidecut
    // Interior points only (the tips supply both ends). Each half is a circle
    // centred at (xw, Ww/2 + r), so the edge is at its narrowest, Ww/2, at
    // the waist.
    const SC = 90;
    for (let i = 1; i < SC; i++) {
      const x = xn + (chord * i) / SC;
      const r = x <= xw ? rn : rt;
      const dx = x - xw;
      pts.push([x, Ww / 2 + r - Math.sqrt(Math.max(0, r * r - dx * dx))]);
    }
    // tail tip (optionally notched / swallowtail)
    // Traced from the widest tail point (xt, Wt/2) out to the tail end (L, 0).
    // For a swallowtail, once the curve comes within notchH of the centre
    // line it cuts straight in to the notch apex on the centre line.
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
    // (positive setback moves the stance toward the tail).
    const sidecutMid = (xn + xt) / 2;
    const stanceCenter = sidecutMid + (isNum(size.setback) ? size.setback : 0);
    const refStance = isNum(size.ref_stance) ? size.ref_stance : null;

    // contact points (for the side view)
    // Published nose/tail lengths run from each tip to its contact point.
    // Without them, centre the contact length (or the sidecut) on the
    // sidecut midpoint.
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
      // Front (nose-side) and back binding positions.
      stance: refStance ? [stanceCenter - refStance / 2, stanceCenter + refStance / 2] : null,
      stanceRange: size.stance_range || null,
      contact: [c1, c2],
      upper: pts,
      notes,
    };
  }

  // Half-width at x (outermost edge), or null if off the board.
  // Interpolates linearly along the outline. It checks every segment that
  // spans x and keeps the largest y, because the outline isn't single-valued
  // in x everywhere (e.g. the inward cut of a swallowtail notch).
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

  // SVG path data for the full, closed outline. The half-outline is drawn
  // along the top (negative y, since SVG y points down), then mirrored back
  // along the bottom. `offset` shifts the board along x; `scaleY` optionally
  // stretches it vertically.
  function outlinePath(g, offset, scaleY) {
    const sy = scaleY || 1;
    const up = g.upper.map(([x, y]) => `${(x + offset).toFixed(2)},${(-y * sy).toFixed(2)}`);
    const lo = g.upper.slice().reverse().map(([x, y]) => `${(x + offset).toFixed(2)},${(y * sy).toFixed(2)}`);
    return 'M' + up.join('L') + 'L' + lo.join('L') + 'Z';
  }

  // ---- schematic side profile -------------------------------------------
  // Monotone cubic (Fritsch–Carlson) interpolation through key points.
  // Unlike a plain cubic spline it never overshoots, so a flat stretch stays
  // flat and the base never dips below a keypoint. xs must be strictly
  // increasing. Returns f(x); x outside the range is clamped to the ends.
  function monotone(xs, ys) {
    const n = xs.length;
    const d = [], m = new Array(n);  // d: secant slopes, m: tangent slopes
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
    // Initial tangents: one-sided at the ends; the average of neighbouring
    // secants inside, or 0 at a local peak or valley (the secants change sign).
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    // Scale tangents down where needed so each segment stays monotone
    // (the Fritsch–Carlson condition a^2 + b^2 <= 9).
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
      if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    return function (x) {
      // Find the segment containing x, then evaluate the cubic Hermite basis.
      let i = 0;
      while (i < n - 2 && x > xs[i + 1]) i++;
      const h = xs[i + 1] - xs[i], t = Math.min(1, Math.max(0, (x - xs[i]) / h));
      const t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] +
             (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    };
  }

  // Human-readable names for the profile keys produced by the scraper's
  // classify_profile().
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
  // z is height above the snow (positive = up) and x matches the top view.
  // Between the contact points the base follows a monotone curve through
  // profile-specific keypoints; outside them the tips kick up.
  const TIP_SCALE = 1.6;
  function profile(board, g, exag) {
    const E = exag || 1;
    const C = 6 * E, Rk = 9 * E;  // camber arch height, rocker lift (mm)
    // Nose/tail kick heights: directional boards get a taller nose; twins
    // get matching tips.
    const hn = (board.shape === 'Directional' ? 72 : 60) * TIP_SCALE;
    const ht = (board.shape === 'Twin' ? 60 : 50) * TIP_SCALE;
    const [c1, c2] = g.contact;
    const sc = g.stanceCenter;
    // Binding positions; without a reference stance, assume 24% of the
    // contact span either side of the stance centre.
    const half = g.refStance ? g.refStance / 2 : (c2 - c1) * 0.24;
    const f1 = sc - half, f2 = sc + half;
    // Keypoints [x, z] for each profile, from nose contact (c1) to tail
    // contact (c2) through front foot (f1), stance centre (sc) and back foot
    // (f2). z > 0 means the base is lifted off the snow there.
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
    // Drop keypoints within 5 mm of the previous one (e.g. a wide stance that
    // reaches the contact points) so monotone() gets strictly increasing xs.
    const xs = [], ys = [];
    kp.forEach(([x, y]) => { if (!xs.length || x - xs[xs.length - 1] > 5) { xs.push(x); ys.push(y); } });
    const core = monotone(xs, ys);
    const z1 = core(c1), z2 = core(c2);
    const pts = [];
    const n = 160;
    for (let i = 0; i <= n; i++) {
      const x = (g.L * i) / n;
      let z;
      // Tips: power curve rising from the base height at the contact point
      // to the kick height at the board end. It never dips below the base.
      if (x < c1) z = z1 + Math.max(hn - z1, 0) * Math.pow((c1 - x) / c1, 2.2);
      else if (x > c2) z = z2 + Math.max(ht - z2, 0) * Math.pow((x - c2) / (g.L - c2), 2.2);
      else z = core(x);
      pts.push([x, z]);
    }
    return pts;
  }

  // Tallest z the side view must fit at a given exaggeration: the highest
  // nose kick, or the exaggerated directional rocker plus some headroom.
  const PROFILE_MAX_Z = (exag) => Math.max(72 * TIP_SCALE, 1.6 * 9 * (exag || 1) + 30);

  global.BoardGeometry = { geometry, halfWidthAt, outlinePath, profile, PROFILE_LABEL, PROFILE_MAX_Z };
})(window);
