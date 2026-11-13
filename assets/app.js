/*
 * BoardShapes UI: board list and filters, the overlaid top/side view, the
 * spec comparison table and the sortable database.
 *
 * Data flow:
 *   window.BOARD_DATA      board records, from data/boards.js (scraper output)
 *   window.BoardGeometry   outline / profile maths, from assets/geometry.js
 *   state                  every piece of UI state lives in one object; event
 *                          handlers change it and then call a render function
 *                          (usually updateAll) which rebuilds the affected DOM
 *                          from scratch
 *
 * All lengths are kept in millimetres and weights in kg internally; the fmt
 * helpers convert to cm / inches / lb only for display.
 */
(function () {
  'use strict';

  const G = window.BoardGeometry;
  const DATA = window.BOARD_DATA || { boards: [] };
  const BOARDS = DATA.boards;
  const BY_ID = new Map(BOARDS.map((b) => [b.id, b]));
  const BRANDS = [...new Set(BOARDS.map((b) => b.brand))].sort();
  // One colour per comparison slot; their count caps how many boards can be
  // compared at once.
  const COLORS = ['#2563eb', '#e11d48', '#16a34a', '#f59e0b', '#9333ea', '#0891b2', '#db2777', '#65a30d'];
  const MAX_SEL = COLORS.length;
  const SHAPES = ['Twin', 'Directional Twin', 'Directional'];
  // Groups the eight detailed profile keys into the four families offered as
  // filter chips.
  const PROFILE_FAMILY = {
    camber: 'Camber', directional_camber: 'Camber',
    camrock: 'Hybrid', directional_camrock: 'Hybrid', hybrid_rocker: 'Hybrid',
    flat: 'Flat', directional_flat: 'Flat', rocker: 'Rocker',
  };
  const FAMILIES = ['Camber', 'Hybrid', 'Flat', 'Rocker'];

  const state = {
    // Boards being compared, in colour order. dx is a manual drag offset (mm)
    // applied on top of the chosen alignment.
    sel: [], // {id, size, color, hidden, dx}
    // Sidebar filters and sort.
    q: '', brands: new Set(), gender: 'all', popular: false,
    shapes: new Set(), families: new Set(), flexMin: 1, flexMax: 10,
    // weight is always stored in kg (null = not entered).
    sort: 'popular', unit: 'metric', weight: null, wide: false,
    // Compare view options.
    view: 'both', align: 'center',
    show: { grid: true, stance: true, sidecut: false, fill: true },
    // exag: side-view camber/rocker exaggeration. zoom: 1 = fit all boards.
    // panX / panY: view offset in mm.
    exag: 6, zoom: 1, panX: 0, panY: 0,
    // Active tab and database-table options.
    tab: 'compare', dbAll: false, dbSort: { key: 'brand', dir: 1 },
  };

  // ------------------------------------------------------------------ utils
  const $ = (s) => document.querySelector(s);
  const SVGNS = 'http://www.w3.org/2000/svg';
  // Tiny DOM builder: h('div', {class: 'x', onclick: fn}, 'text', childEl).
  // Attributes: "class", "style" (CSS text), "on*" (event listeners), "html"
  // (innerHTML); true sets an empty attribute; null/false are skipped.
  // Children may be nodes, strings or (nested) arrays; nulls are ignored.
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'html') e.innerHTML = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach((c) => c != null && e.append(c.nodeType ? c : document.createTextNode(c)));
    return e;
  }
  // SVG element builder (SVG elements need the SVG namespace). null-valued
  // attributes are skipped.
  function s(tag, attrs) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs || {}) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    return e;
  }
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  // Format to at most d decimals and drop trailing zeros: trim(25.0, 1) -> "25".
  const trim = (v, d) => { const t = v.toFixed(d); return t.includes('.') ? t.replace(/\.?0+$/, '') : t; };
  const imperial = () => state.unit === 'imperial';

  // Display formatters. Each returns null for missing data so callers can
  // show a dash. The d* variants format a signed difference and return null
  // when it's negligible, so zero deltas aren't shown.
  const fmt = {
    // mm -> "158 cm" / "250 mm" (unit picks which) or inches in imperial.
    len(mm, unit) {
      if (!isNum(mm)) return null;
      if (imperial()) return trim(mm / 25.4, 2) + '″';
      return unit === 'cm' ? trim(mm / 10, 1) + ' cm' : trim(mm, 1) + ' mm';
    },
    dlen(mm, unit) {
      if (!isNum(mm) || Math.abs(mm) < 0.05) return null;
      const sign = mm > 0 ? '+' : '−';
      return sign + fmt.len(Math.abs(mm), unit);
    },
    // Sidecut radius: metres or feet.
    radius(m) {
      if (!isNum(m)) return null;
      return imperial() ? trim(m * 3.28084, 1) + ' ft' : trim(m, 2) + ' m';
    },
    dradius(m) {
      if (!isNum(m) || Math.abs(m) < 0.005) return null;
      return (m > 0 ? '+' : '−') + fmt.radius(Math.abs(m));
    },
    // Rider weight range [lo, hi] in kg -> "54–82 kg"; open-ended -> "90+ kg".
    weight(w) {
      if (!w) return null;
      const [lo, hi] = w;
      const c = (kg) => (imperial() ? Math.round(kg * 2.20462) : kg);
      const u = imperial() ? ' lb' : ' kg';
      return hi == null ? c(lo) + '+' + u : c(lo) + '–' + c(hi) + u;
    },
    // Board weight.
    kg(v) {
      if (!isNum(v)) return null;
      return imperial() ? trim(v * 2.20462, 1) + ' lb' : trim(v, 2) + ' kg';
    },
  };

  // Show a short message at the bottom of the screen for 1.8 s.
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // Shopify CDN images (all three brands) accept ?width=, so ask for a small
  // copy for thumbnails instead of the full-size product shot.
  function thumbUrl(url, w) {
    if (!url) return null;
    try {
      const u = new URL(url, location.href);
      if (u.pathname.includes('/cdn/shop/')) u.searchParams.set('width', w);
      return u.toString();
    } catch (e) { return url; }
  }

  // ------------------------------------------------------------ board model
  // Wide sizes carry a "W" in their label, e.g. "158W".
  const isWide = (sz) => /W/i.test(sz.label);

  // Pick the size of board b that best fits the rider's weight.
  // Only wide or only regular sizes are considered, per the Wide checkbox,
  // falling back to all sizes if the board has none of that kind. Without a
  // weight it returns the middle size.
  function recommendSize(b) {
    const pool = b.sizes.filter((sz) => (state.wide ? isWide(sz) : !isWide(sz)));
    const cand = pool.length ? pool : b.sizes;
    const mid = cand[Math.floor((cand.length - 1) / 2)];
    const w = state.weight;
    if (!isNum(w)) return mid;
    // Score = 10 x kg outside the size's range (a heavy penalty) + distance
    // from the range centre in half-ranges. An open-ended "90+" range is
    // treated as 25 kg wide. Lower is better.
    let scored = cand.filter((sz) => sz.weight_kg).map((sz) => {
      const lo = sz.weight_kg[0];
      const hi = sz.weight_kg[1] == null ? lo + 25 : sz.weight_kg[1];
      const out = w < lo ? lo - w : w > hi ? w - hi : 0;
      return { sz, lo, hi, score: out * 10 + Math.abs(w - (lo + hi) / 2) / Math.max((hi - lo) / 2, 1) };
    });
    if (!scored.length) return mid;
    const best = Math.min(...scored.map((x) => x.score));
    const ties = scored.filter((x) => x.score - best < 1e-6).sort((a, c) => a.sz.length - c.sz.length);
    if (ties.length === 1) return ties[0].sz;
    // Several sizes share the same range: choose by where the rider falls in
    // it, so lighter riders get the shorter board.
    const t0 = ties[0];
    const t = Math.min(1, Math.max(0, (w - t0.lo) / Math.max(t0.hi - t0.lo, 1)));
    return ties[Math.round(t * (ties.length - 1))].sz;
  }

  // Size record by label (falls back to the first size).
  const sizeOf = (b, label) => b.sizes.find((x) => x.label === label) || b.sizes[0];
  // Geometry is needed on every render and the data never changes, so build
  // it once per board + size and cache it.
  const geoCache = new Map();
  function geo(b, label) {
    const k = b.id + '|' + label;
    if (!geoCache.has(k)) geoCache.set(k, G.geometry(b, sizeOf(b, label)));
    return geoCache.get(k);
  }
  // "150–162": the board's shortest to longest size in cm.
  const sizeRange = (b) => {
    const n = [...new Set(b.sizes.map((x) => Math.round(x.length / 10)))].sort((a, c) => a - c);
    return n.length > 1 ? n[0] + '–' + n[n.length - 1] : String(n[0]);
  };
  const displayName = (b) => b.name + (b.gender === 'women' ? ' (W)' : '');

  // ---------------------------------------------------------------- filters
  // Boards matching every active sidebar filter. Empty sets mean "any".
  function filtered() {
    const q = state.q.trim().toLowerCase();
    // Boards without a flex rating are only hidden once the range is narrowed.
    const fullFlex = state.flexMin <= 1 && state.flexMax >= 10;
    return BOARDS.filter((b) => {
      if (q && !(b.name + ' ' + b.brand + ' ' + (b.profile_raw || '') + ' ' + b.shape).toLowerCase().includes(q)) return false;
      if (state.brands.size && !state.brands.has(b.brand)) return false;
      if (state.gender !== 'all' && b.gender !== state.gender) return false;
      if (state.popular && !b.popular) return false;
      if (state.shapes.size && !state.shapes.has(b.shape)) return false;
      if (state.families.size && !state.families.has(PROFILE_FAMILY[b.profile])) return false;
      if (!fullFlex) {
        if (!isNum(b.flex) || b.flex < state.flexMin || b.flex > state.flexMax) return false;
      }
      return true;
    });
  }

  // Sort a copy of the list by the sidebar's sort choice.
  function sorted(list) {
    const mid = (b) => recommendSize(b);
    const by = {
      popular: (a, c) => a.brand.localeCompare(c.brand) || (c.popular - a.popular) || a.name.localeCompare(c.name),
      name: (a, c) => a.brand.localeCompare(c.brand) || a.name.localeCompare(c.name),
      // Boards without a flex rating go last.
      flex: (a, c) => (a.flex ?? 99) - (c.flex ?? 99) || a.name.localeCompare(c.name),
      // Compared at each board's recommended size.
      waist: (a, c) => mid(a).waist - mid(c).waist,
    }[state.sort];
    return list.slice().sort(by);
  }

  // ---------------------------------------------------------------- sidebar
  // Create the brand (with board counts), shape and profile-family filter
  // chips. Clicking a chip toggles it in the matching state set.
  function buildFilterChips() {
    const brandBox = $('#brandChips');
    BRANDS.forEach((br) => {
      brandBox.append(h('button', {
        class: 'chip', 'data-v': br,
        onclick: (e) => { toggleSet(state.brands, br); e.currentTarget.classList.toggle('on'); refreshList(); },
      }, br + ' ', h('span', { style: 'color:var(--faint)' }, String(BOARDS.filter((b) => b.brand === br).length))));
    });
    const shapeBox = $('#shapeChips');
    SHAPES.forEach((sh) => shapeBox.append(h('button', {
      class: 'chip', onclick: (e) => { toggleSet(state.shapes, sh); e.currentTarget.classList.toggle('on'); refreshList(); },
    }, sh)));
    const profBox = $('#profileChips');
    FAMILIES.forEach((f) => profBox.append(h('button', {
      class: 'chip', onclick: (e) => { toggleSet(state.families, f); e.currentTarget.classList.toggle('on'); refreshList(); },
    }, f)));
  }
  function toggleSet(set, v) { set.has(v) ? set.delete(v) : set.add(v); }

  // List thumbnail: the product photo, or a drawn outline if there's no
  // image or it fails to load. no-referrer keeps this page's URL from being
  // sent to the image CDN.
  function boardThumb(b) {
    const box = h('span', { class: 'thumb' });
    const url = thumbUrl(b.image, 120);
    if (url) {
      const img = h('img', { src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => { img.remove(); box.append(miniOutline(b)); });
      box.append(img);
    } else box.append(miniOutline(b));
    return box;
  }
  // Small SVG outline of the board's recommended size, standing upright.
  function miniOutline(b) {
    const sz = recommendSize(b);
    const g = geo(b, sz.label);
    const svg = s('svg', { viewBox: `${-g.Wn / 2 - 20} -20 ${g.Wn + 40} ${g.L + 40}` });
    // rotate so the nose points up
    // matrix(0 1 -1 0 0 0) maps (x, y) -> (-y, x): length runs top to bottom.
    const p = s('path', { d: G.outlinePath(g, 0), fill: 'var(--faint)', transform: 'matrix(0 1 -1 0 0 0)' });
    svg.append(p);
    return svg;
  }

  // Rebuild the sidebar board list from the current filters and sort.
  // Also refreshes the counts, and the database tab if it's showing (it
  // uses the same filters).
  function refreshList() {
    const list = sorted(filtered());
    const ul = $('#boardList');
    ul.textContent = '';
    const selIds = new Set(state.sel.map((x) => x.id));
    // Brand sub-headings only make sense when the list is ordered by brand.
    const grouped = state.sort === 'popular' || state.sort === 'name';
    let lastBrand = null;
    list.forEach((b) => {
      if (grouped && b.brand !== lastBrand) {
        ul.append(h('li', { class: 'brand-head' }, b.brand));
        lastBrand = b.brand;
      }
      const selEntry = state.sel.find((x) => x.id === b.id);
      const rec = recommendSize(b);
      // Subtitle: shape · flex · (your size, or the available size range).
      const sub = [b.shape, isNum(b.flex) ? 'flex ' + trim(b.flex, 1) : null,
        isNum(state.weight) ? 'your size ' + rec.label : sizeRange(b)].filter(Boolean).join(' · ');
      ul.append(h('li', {
        class: 'board-item' + (selIds.has(b.id) ? ' sel' : ''),
        title: b.description || '',
        onclick: () => toggleBoard(b.id),
      },
      boardThumb(b),
      h('div', {},
        h('div', { class: 'nm' }, b.name,
          b.gender === 'women' ? h('span', { class: 'tag' }, "W") : null,
          b.popular ? h('span', { class: 'tag' }, '★') : null),
        h('div', { class: 'sub' }, (grouped ? '' : b.brand + ' · ') + sub)),
      // Dot on the right shows the board's comparison colour when selected.
      h('span', { class: 'dot', style: selEntry ? `background:${selEntry.color}` : '' })));
    });
    $('#resultCount').textContent = list.length + ' of ' + BOARDS.length + ' boards';
    $('#boardCount').textContent = '(' + state.sel.length + ' selected)';
    if (state.tab === 'database') renderDatabase();
  }

  // -------------------------------------------------------------- selection
  // Add or remove a board from the comparison.
  //   toggleBoard(id)         remove it if selected, otherwise add it at the
  //                           recommended size
  //   toggleBoard(id, label)  select it at that size (changing the size if
  //                           it's already selected); used by the database
  function toggleBoard(id, label) {
    const i = state.sel.findIndex((x) => x.id === id);
    if (i >= 0 && !label) { state.sel.splice(i, 1); }
    else if (i >= 0 && label) { state.sel[i].size = label; }
    else {
      if (state.sel.length >= MAX_SEL) { toast(`Compare up to ${MAX_SEL} boards at once`); return; }
      const b = BY_ID.get(id);
      // Take the first colour not already in use.
      const used = new Set(state.sel.map((x) => x.color));
      state.sel.push({ id, size: label || recommendSize(b).label, color: COLORS.find((c) => !used.has(c)), hidden: false, dx: 0 });
    }
    updateAll();
  }

  // Chips above the stage, one per selected board: colour swatch, name,
  // size picker (★ marks the recommended size), show/hide and remove.
  function renderSelected() {
    const box = $('#selected');
    box.textContent = '';
    state.sel.forEach((sel, idx) => {
      const b = BY_ID.get(sel.id);
      const rec = recommendSize(b).label;
      const select = h('select', {
        'aria-label': 'Size for ' + b.name,
        // A new size has a different length, so any drag offset is reset.
        onchange: (e) => { sel.size = e.target.value; sel.dx = 0; updateAll(); },
      }, b.sizes.map((sz) => h('option', { value: sz.label, selected: sz.label === sel.size },
        sz.label + (isNum(state.weight) && sz.label === rec ? ' ★' : ''))));
      box.append(h('div', { class: 'sel-chip' + (sel.hidden ? ' hidden-board' : '') },
        h('span', { class: 'sw', style: `background:${sel.color}` }),
        h('span', {}, h('span', { class: 'nm' }, displayName(b)), ' ', h('span', { class: 'br' }, b.brand)),
        select,
        // Eye button: crossed-out eye while hidden, open eye while shown.
        h('button', {
          class: 'eye', title: sel.hidden ? 'Show' : 'Hide', 'aria-label': sel.hidden ? 'Show board' : 'Hide board',
          onclick: () => { sel.hidden = !sel.hidden; updateAll(); },
          html: sel.hidden
            ? '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 6.1A9.9 9.9 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-2.6 3.2M6.6 6.6C4.3 8.1 3 12 3 12s4 6 9 6a9 9 0 0 0 4.4-1.1"/></svg>'
            : '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
        }),
        h('button', { class: 'x', title: 'Remove', 'aria-label': 'Remove ' + b.name, onclick: () => { state.sel.splice(idx, 1); updateAll(); } }, '×')));
    });
    // The "pick boards" overlay shows when nothing visible is selected.
    $('#empty').hidden = state.sel.some((x) => !x.hidden);
  }

  // ------------------------------------------------------------------ stage
  // The stage holds two SVGs that share one horizontal scale: the top view
  // (outlines) and the side view (profiles). Their viewBoxes are in board
  // millimetres, so zooming and panning only change the viewBox.
  const topSvg = $('#topSvg');
  const sideSvg = $('#sideSvg');
  let view = null; // current layout, used by pointer handlers

  // The x position (mm from the nose tip) that each board is aligned on.
  // Boards are offset so this point sits at x = 0 on the stage.
  function alignRef(g) {
    switch (state.align) {
      case 'stance': return g.stanceCenter;
      case 'waist': return g.xw;
      case 'nose': return 0;
      case 'tail': return g.L;
      default: return g.L / 2;
    }
  }

  // Work out where each visible board sits and what part of the stage is
  // in view. Returns null when nothing is visible. Key fields:
  //   items        [{sel, b, g, off}], off = x offset applied to the board
  //   minX, maxX   horizontal extent of all boards (mm)
  //   W0, cx0      width and centre of the zoom-1 "fit all" view
  //   vbX, vbW     current viewBox x and width, after zoom and pan
  //   pxPerMm      screen pixels per mm at the current zoom
  //   topH, sideH  current viewBox heights; topH0 / sideH0 at zoom 1
  function layout() {
    const items = state.sel.filter((x) => !x.hidden).map((sel) => {
      const b = BY_ID.get(sel.id);
      const g = geo(b, sel.size);
      return { sel, b, g, off: -alignRef(g) + sel.dx };
    });
    if (!items.length) return null;
    const minX = Math.min(...items.map((it) => it.off));
    const maxX = Math.max(...items.map((it) => it.off + it.g.L));
    const maxHalf = Math.max(...items.map((it) => Math.max(it.g.Wn, it.g.Wt) / 2));
    const W0 = (maxX - minX) * 1.08 + 40;  // 8% + 40 mm of margin
    const cx0 = (minX + maxX) / 2;
    const vbW = W0 / state.zoom;
    const vbX = cx0 + state.panX - vbW / 2;
    const pxW = topSvg.clientWidth || topSvg.parentNode.clientWidth || 900;
    const pxPerMm = pxW / vbW;
    const fitPx = pxW / W0; // px per mm at zoom 1
    const topNeed = maxHalf * 2 * 1.15 + 64 / fitPx; // room for labels + axis
    const topH0 = Math.max(topNeed, W0 * 0.24);  // never flatter than ~4:1
    const sideH0 = G.PROFILE_MAX_Z(state.exag) + 70;
    // When zoomed in, let the views grow taller (up to a share of the window)
    // so a nose/tail close-up still shows the whole outline.
    const vh = window.innerHeight || 900;
    const topH = Math.max(topH0 / state.zoom, Math.min(topNeed, (vh * 0.7) / pxPerMm));
    const sideH = Math.max(sideH0 / state.zoom, Math.min(sideH0, (vh * 0.35) / pxPerMm));
    // Keep vertical panning within the outlines.
    const maxPanY = Math.max(0, (topNeed - topH) / 2);
    state.panY = Math.max(-maxPanY, Math.min(maxPanY, state.panY));
    return { items, minX, maxX, maxHalf, W0, cx0, vbW, vbX, pxW, pxPerMm, topH, topH0, sideH, sideH0 };
  }

  // Pick grid spacings (mm) so major lines are at least 70 px apart. Minor
  // lines subdivide them and are dropped (null) when under 7 px apart.
  // Metric steps: 1, 5, 10, 20, 50 cm. Imperial: 1, 2, 6, 12, 24 in.
  function gridSteps(pxPerMm) {
    const steps = imperial()
      ? [25.4, 50.8, 152.4, 304.8, 609.6]
      : [10, 50, 100, 200, 500];
    const major = steps.find((st) => st * pxPerMm >= 70) || steps[steps.length - 1];
    let minor = imperial() ? (major >= 152.4 ? 25.4 : major / 4) : (major >= 100 ? major / 10 : major / 5);
    if (minor * pxPerMm < 7) minor = null;
    return { major, minor };
  }

  // Grid label text: centimetres (unit added only at 0) or inches.
  function axisLabel(mm) {
    if (imperial()) return trim(mm / 25.4, 1) + '″';
    return trim(mm / 10, 1);
  }

  // Draw grid lines into `svg` over the box (x0, y0, w, hgt), in mm.
  // labels: 'top' adds axis labels and horizontal lines (top view); false
  // draws vertical lines only (side view).
  // Sizes are divided by pxPerMm so text and offsets stay a fixed number of
  // screen pixels at any zoom.
  function drawGrid(svg, L, x0, y0, w, hgt, labels) {
    const g = s('g');
    const { major, minor } = gridSteps(L.pxPerMm);
    const fs = 11 / L.pxPerMm;  // 11 px font
    // non-scaling-stroke keeps line widths in screen pixels.
    const line = (x, cls) => g.append(s('line', { x1: x, x2: x, y1: y0, y2: y0 + hgt, class: cls, 'vector-effect': 'non-scaling-stroke' }));
    if (minor) for (let x = Math.ceil(x0 / minor) * minor; x <= x0 + w; x += minor) line(x, 'grid-minor');
    for (let x = Math.ceil(x0 / major) * major; x <= x0 + w; x += major) {
      line(x, 'grid-major');
      if (labels) {
        const t = s('text', { x: x + 3 / L.pxPerMm, y: y0 + hgt - 6 / L.pxPerMm, 'font-size': fs, class: 'axis-label' });
        t.textContent = axisLabel(x) + (Math.abs(x) < 1e-6 ? (imperial() ? '' : ' cm') : '');
        g.append(t);
      }
    }
    // horizontal lines (top view only)
    if (labels === 'top') {
      const hline = (y, cls) => g.append(s('line', { x1: x0, x2: x0 + w, y1: y, y2: y, class: cls, 'vector-effect': 'non-scaling-stroke' }));
      if (minor) for (let y = Math.ceil(y0 / minor) * minor; y <= y0 + hgt; y += minor) hline(y, 'grid-minor');
      for (let y = Math.ceil(y0 / major) * major; y <= y0 + hgt; y += major) hline(y, 'grid-major');
    }
    svg.append(g);
  }

  // Redraw both views from scratch for the current state.
  function renderStage() {
    const L = layout();
    view = L;
    topSvg.textContent = '';
    sideSvg.textContent = '';
    const showTop = state.view !== 'side';
    const showSide = state.view !== 'top';
    topSvg.style.display = showTop ? '' : 'none';
    $('#topLabel').style.display = showTop ? '' : 'none';
    sideSvg.style.display = showSide ? '' : 'none';
    $('#sideLabel').style.display = showSide ? '' : 'none';
    if (!L) {
      // Nothing visible: keep a sensible size behind the empty overlay.
      topSvg.setAttribute('viewBox', '0 0 1000 250');
      sideSvg.setAttribute('viewBox', '0 0 1000 120');
      return;
    }
    const px = 1 / L.pxPerMm; // one screen pixel in mm
    // ---- top view
    // y = 0 is the board centre line; the view is centred on it (plus panY).
    if (showTop) {
      const vbY = -L.topH / 2 + state.panY;
      topSvg.setAttribute('viewBox', `${L.vbX} ${vbY} ${L.vbW} ${L.topH}`);
      if (state.show.grid) drawGrid(topSvg, L, L.vbX, vbY, L.vbW, L.topH, 'top');
      topSvg.append(s('line', { x1: L.vbX, x2: L.vbX + L.vbW, y1: 0, y2: 0, class: 'centerline', 'vector-effect': 'non-scaling-stroke' }));

      // NOSE / TAIL labels just above the widest outline.
      const nose = s('text', { x: L.minX, y: -L.maxHalf - 14 * px, 'font-size': 11 * px, class: 'end-label' });
      nose.textContent = 'NOSE';
      const tail = s('text', { x: L.maxX, y: -L.maxHalf - 14 * px, 'font-size': 11 * px, class: 'end-label', 'text-anchor': 'end' });
      tail.textContent = 'TAIL';
      topSvg.append(nose, tail);

      // Drawn in reverse so the first selected board ends up on top.
      L.items.slice().reverse().forEach((it) => {
        const { g, off, sel } = it;
        const grp = s('g', { 'data-id': sel.id });
        // data-id on the outline lets the pointer handlers tell which board
        // is being dragged.
        const path = s('path', {
          d: G.outlinePath(g, off), class: 'outline',
          fill: state.show.fill ? sel.color : 'none', 'fill-opacity': state.show.fill ? 0.1 : null,
          stroke: sel.color, 'stroke-width': 2, 'stroke-linejoin': 'round',
          'vector-effect': 'non-scaling-stroke', 'data-id': sel.id,
        });
        grp.append(path);
        // Stance: dashed lines at each binding (92% of the local width) and
        // a dot at the stance centre.
        if (state.show.stance && g.stance) {
          g.stance.forEach((x) => {
            const hw = G.halfWidthAt(g, x) || g.Ww / 2;
            grp.append(s('line', {
              x1: x + off, x2: x + off, y1: -hw * 0.92, y2: hw * 0.92, stroke: sel.color,
              'stroke-width': 1.5, 'stroke-dasharray': '5 4', 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none',
            }));
          });
          grp.append(s('circle', { cx: g.stanceCenter + off, cy: 0, r: 3.5 * px, fill: sel.color, 'pointer-events': 'none' }));
        }
        // Sidecut markers on both edges: widest nose point, waist, widest
        // tail point.
        if (state.show.sidecut) {
          [[g.xn, g.Wn / 2], [g.xw, g.Ww / 2], [g.xt, g.Wt / 2]].forEach(([x, y]) => {
            [-1, 1].forEach((sg) => grp.append(s('circle', {
              cx: x + off, cy: sg * y, r: 3.5 * px, fill: 'var(--panel)', stroke: sel.color,
              'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none',
            })));
          });
        }
        topSvg.append(grp);
      });
      // Empty layer, filled by showCursor() on hover.
      topSvg.append(s('g', { id: 'topCursor' }));
    }

    // ---- side view (shares the horizontal scale with the top view)
    if (showSide) {
      // anchor to the ground line so a zoomed-in view still shows the base
      // (the snow line, y = 0, sits 30 mm above the bottom edge).
      const contentBot = 30;
      const vbY = contentBot - L.sideH;
      sideSvg.setAttribute('viewBox', `${L.vbX} ${vbY} ${L.vbW} ${L.sideH}`);
      if (state.show.grid) drawGrid(sideSvg, L, L.vbX, vbY, L.vbW, L.sideH, false);
      sideSvg.append(s('line', { x1: L.vbX, x2: L.vbX + L.vbW, y1: 0, y2: 0, class: 'ground', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' }));
      L.items.slice().reverse().forEach((it) => {
        const pts = G.profile(it.b, it.g, state.exag);
        // Height z is drawn as -z because SVG y points down.
        const d = 'M' + pts.map(([x, z]) => `${(x + it.off).toFixed(1)},${(-z).toFixed(2)}`).join('L');
        sideSvg.append(s('path', {
          d, fill: 'none', stroke: it.sel.color, 'stroke-width': 2.5, 'stroke-linecap': 'round',
          'vector-effect': 'non-scaling-stroke',
        }));
        // Dots at the nose and tail contact points.
        it.g.contact.forEach((x) => sideSvg.append(s('circle', { cx: x + it.off, cy: 0, r: 3 * px, fill: it.sel.color })));
      });
      sideSvg.append(s('g', { id: 'sideCursor' }));
    }
  }

  // ---- pointer interaction: measure, drag boards, pan, zoom
  // Convert a mouse clientX (screen px) to an x in the SVG's viewBox (mm).
  function svgX(svg, clientX) {
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return vb.x + ((clientX - r.left) / r.width) * vb.width;
  }

  // Hover measurement: a vertical line through both views at the pointer,
  // dots where it crosses each outline, and a readout listing each board's
  // full width at that point.
  function showCursor(svg, clientX, clientY) {
    if (!view) return;
    const x = svgX(svg, clientX);
    const px = 1 / view.pxPerMm;
    const rows = [];
    [['topCursor', topSvg], ['sideCursor', sideSvg]].forEach(([id, sv]) => {
      const g = sv.querySelector('#' + id);
      if (!g) return;  // that view is hidden
      g.textContent = '';
      const vb = sv.viewBox.baseVal;
      g.append(s('line', { x1: x, x2: x, y1: vb.y, y2: vb.y + vb.height, class: 'cursor-line', 'vector-effect': 'non-scaling-stroke' }));
      if (id === 'topCursor') {
        view.items.forEach((it) => {
          const hw = G.halfWidthAt(it.g, x - it.off);
          if (hw == null) return;
          [-1, 1].forEach((sg) => g.append(s('circle', { cx: x, cy: sg * hw, r: 3.5 * px, fill: it.sel.color, stroke: 'var(--panel)', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' })));
        });
      }
    });
    // Width of each board at this x (in board coordinates: x - offset).
    view.items.forEach((it) => {
      const lx = x - it.off;
      const hw = G.halfWidthAt(it.g, lx);
      rows.push({ it, hw, lx });
    });
    const ro = $('#readout');
    ro.textContent = '';
    // Header: distance from the alignment point (which sits at x = 0).
    const refName = { center: 'center', stance: 'stance center', waist: 'waist', nose: 'nose', tail: 'tail' }[state.align];
    const d = x;
    ro.append(h('div', { class: 'rh' }, (Math.abs(d) < 0.5 ? 'at ' : (d < 0 ? '← ' : '→ ') + fmt.len(Math.abs(d), 'cm') + ' from ') + refName));
    rows.forEach(({ it, hw }) => {
      ro.append(h('div', { class: 'rr' },
        h('i', { style: `background:${it.sel.color}` }),
        h('span', {}, it.b.name + ' ' + it.sel.size),
        h('b', {}, hw == null ? '—' : fmt.len(hw * 2, 'mm'))));
    });
    // Place the readout below-right of the pointer, flipping to the other
    // side when it would run off the stage.
    const stage = $('#stage').getBoundingClientRect();
    ro.hidden = false;
    let left = clientX - stage.left + 16;
    if (left + ro.offsetWidth > stage.width - 8) left = clientX - stage.left - ro.offsetWidth - 16;
    let top = clientY - stage.top + 16;
    if (top + ro.offsetHeight > stage.height - 4) top = clientY - stage.top - ro.offsetHeight - 12;
    ro.style.left = Math.max(4, left) + 'px';
    ro.style.top = Math.max(4, top) + 'px';
  }
  function hideCursor() {
    $('#readout').hidden = true;
    ['#topCursor', '#sideCursor'].forEach((id) => { const g = document.querySelector(id); if (g) g.textContent = ''; });
  }

  // Zoom by `factor` (clamped to 1x-40x), keeping the point under the
  // pointer fixed on screen. clientY is only used in the top view, the one
  // view that pans vertically.
  function zoomAt(svg, clientX, factor, clientY) {
    if (!view) return;
    const x = svgX(svg, clientX);
    const nz = Math.min(40, Math.max(1, state.zoom * factor));
    // keep x under the cursor
    // Solve vbX + frac * newW = x for panX, where vbX = cx0 + panX - newW/2.
    const r = svg.getBoundingClientRect();
    const frac = (clientX - r.left) / r.width;
    const newW = view.W0 / nz;
    state.panX = x - frac * newW + newW / 2 - view.cx0;
    if (svg === topSvg && clientY != null) {
      const vb = svg.viewBox.baseVal;
      const y = vb.y + ((clientY - r.top) / r.height) * vb.height;
      const fy = (clientY - r.top) / r.height;
      const newH = view.topH0 / nz;
      state.panY = y - fy * newH + newH / 2;
    }
    state.zoom = nz;
    // Fully zoomed out: snap back to the centred "fit all" view.
    if (nz === 1) { state.panX = 0; state.panY = 0; }
    renderStage();
  }

  // Mouse/touch handling for one view:
  //   drag an outline (top view)  slide that board along x (sel.dx)
  //   drag the background         pan (vertically too in the top view)
  //   hover                       width readout (showCursor)
  //   double-click                reset a slid board, else zoom in
  //                               (Shift + double-click zooms out)
  //   Ctrl/Cmd + wheel            zoom
  function attachPointer(svg) {
    let drag = null;
    svg.addEventListener('pointerdown', (e) => {
      if (!view || e.button !== 0) return;
      const id = e.target.getAttribute && e.target.getAttribute('data-id');
      // Capture so the drag continues if the pointer leaves the SVG.
      svg.setPointerCapture(e.pointerId);
      if (id && svg === topSvg) {
        const sel = state.sel.find((x) => x.id === id);
        drag = { mode: 'board', sel, x0: e.clientX, dx0: sel.dx };
      } else {
        drag = { mode: 'pan', x0: e.clientX, y0: e.clientY, px0: state.panX, py0: state.panY };
        svg.classList.add('panning');
      }
    });
    svg.addEventListener('pointermove', (e) => {
      if (drag && view) {
        const mmPerPx = view.vbW / svg.getBoundingClientRect().width;
        if (drag.mode === 'board') {
          drag.sel.dx = drag.dx0 + (e.clientX - drag.x0) * mmPerPx;
        } else {
          state.panX = drag.px0 - (e.clientX - drag.x0) * mmPerPx;
          if (svg === topSvg) state.panY = drag.py0 - (e.clientY - drag.y0) * mmPerPx;
        }
        renderStage();
      }
      showCursor(svg, e.clientX, e.clientY);
    });
    const end = () => {
      // After a real board drag, explain how to undo it.
      if (drag && drag.mode === 'board' && Math.abs(drag.sel.dx - drag.dx0) > 0.5) {
        toast('Double-click a board to snap it back');
      }
      drag = null;
      svg.classList.remove('panning');
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('pointerleave', () => { if (!drag) hideCursor(); });
    svg.addEventListener('dblclick', (e) => {
      const id = e.target.getAttribute && e.target.getAttribute('data-id');
      if (id) {
        const sel = state.sel.find((x) => x.id === id);
        if (sel && sel.dx) { sel.dx = 0; renderStage(); return; }
      }
      zoomAt(svg, e.clientX, e.shiftKey ? 1 / 1.8 : 1.8, e.clientY);
    });
    // Non-passive so preventDefault() can stop the browser's own Ctrl+wheel
    // page zoom.
    svg.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAt(svg, e.clientX, e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientY);
    }, { passive: false });
  }

  // Zoom presets: frame the nose tips, the tail tips or the waists of all
  // visible boards, with some margin.
  function focusRegion(which) {
    const L = layout();
    if (!L) return;
    let a, b;  // x range to frame (mm)
    if (which === 'nose') {
      a = Math.min(...L.items.map((it) => it.off)) - 30;
      b = Math.max(...L.items.map((it) => it.off + it.g.xn)) + 120;
    } else if (which === 'tail') {
      a = Math.min(...L.items.map((it) => it.off + it.g.xt)) - 120;
      b = Math.max(...L.items.map((it) => it.off + it.g.L)) + 30;
    } else {
      const xs = L.items.map((it) => it.off + it.g.xw);
      a = Math.min(...xs) - 260; b = Math.max(...xs) + 260;
    }
    state.zoom = Math.min(40, Math.max(1, L.W0 / (b - a)));
    state.panX = (a + b) / 2 - L.cx0;
    state.panY = 0;
    renderStage();
  }

  // ------------------------------------------------------------- spec table
  // Row definitions for the comparison table under the stage. Each row is
  // either { section } (a heading) or a spec row with a label and one of:
  //   text(b, sz)     -> display string
  //   num(b, sz, g)   -> number; shown with f(value), plus df(difference)
  //                      against the first board in every other column
  //   node(b, sz)     -> DOM node
  // Optional: est(b, sz) true marks a value as estimated (shown with *),
  // extra(b, sz) appends text, and hint is a tooltip on the label.
  // Values like `sz.nose_w ?? g.Wn` fall back to the geometry's estimate
  // when the brand doesn't publish them.
  const ROWS = [
    { section: 'Size & fit' },
    { label: 'Size', text: (b, sz) => sz.label },
    { label: 'Rider weight', text: (b, sz) => fmt.weight(sz.weight_kg) },
    { label: 'Board weight', num: (b, sz) => sz.board_weight_kg, f: fmt.kg, df: (d) => (Math.abs(d) < 0.005 ? null : (d > 0 ? '+' : '−') + fmt.kg(Math.abs(d))) },
    { section: 'Dimensions' },
    { label: 'Length', num: (b, sz) => sz.length, f: (v) => fmt.len(v, 'cm'), df: (d) => fmt.dlen(d, 'cm') },
    { label: 'Effective edge', num: (b, sz) => sz.eff_edge, f: (v) => fmt.len(v, 'cm'), df: (d) => fmt.dlen(d, 'cm') },
    { label: 'Contact length', num: (b, sz) => sz.contact, f: (v) => fmt.len(v, 'cm'), df: (d) => fmt.dlen(d, 'cm') },
    { label: 'Nose width', num: (b, sz, g) => sz.nose_w ?? g.Wn, est: (b, sz) => !isNum(sz.nose_w), f: (v) => fmt.len(v, 'mm'), df: (d) => fmt.dlen(d, 'mm') },
    { label: 'Waist width', num: (b, sz) => sz.waist, f: (v) => fmt.len(v, 'mm'), df: (d) => fmt.dlen(d, 'mm') },
    { label: 'Tail width', num: (b, sz, g) => sz.tail_w ?? g.Wt, est: (b, sz) => !isNum(sz.tail_w), f: (v) => fmt.len(v, 'mm'), df: (d) => fmt.dlen(d, 'mm') },
    { label: 'Taper', num: (b, sz, g) => sz.taper ?? (g.Wn - g.Wt), f: (v) => fmt.len(v, 'mm'), df: (d) => fmt.dlen(d, 'mm') },
    { label: 'Nose length', hint: 'tip to contact point', num: (b, sz) => sz.nose_len, f: (v) => fmt.len(v, 'cm'), df: (d) => fmt.dlen(d, 'cm') },
    { label: 'Tail length', hint: 'contact point to tail', num: (b, sz) => sz.tail_len, f: (v) => fmt.len(v, 'cm'), df: (d) => fmt.dlen(d, 'cm') },
    // 1 dm² = 15.5 in².
    { label: 'Surface area', num: (b, sz) => sz.surface_dm2, f: (v) => (imperial() ? trim(v * 15.5, 0) + ' in²' : trim(v, 2) + ' dm²'), df: (d) => (Math.abs(d) < 0.01 ? null : (d > 0 ? '+' : '−') + (imperial() ? trim(Math.abs(d) * 15.5, 0) + ' in²' : trim(Math.abs(d), 2) + ' dm²')) },
    { section: 'Sidecut & stance' },
    { label: 'Sidecut radius', num: (b, sz, g) => sz.radius ?? g.R / 1000, est: (b, sz) => !isNum(sz.radius), f: fmt.radius, df: fmt.dradius, extra: (b, sz) => sz.radius_raw ? ' (' + sz.radius_raw + ')' : '' },
    { label: 'Sidecut depth', num: (b, sz, g) => sz.sidecut_depth ?? g.sidecutDepth, est: (b, sz) => !isNum(sz.sidecut_depth), f: (v) => fmt.len(v, 'mm'), df: (d) => fmt.dlen(d, 'mm') },
    { label: 'Reference stance', num: (b, sz) => sz.ref_stance, f: (v) => fmt.len(v, 'cm'), df: (d) => fmt.dlen(d, 'cm') },
    { label: 'Stance range', text: (b, sz) => sz.stance_range ? fmt.len(sz.stance_range[0], 'cm').replace(/ cm$/, '') + '–' + fmt.len(sz.stance_range[1], 'cm') : null },
    { label: 'Setback', num: (b, sz) => sz.setback, f: (v) => fmt.len(v, 'mm'), df: (d) => fmt.dlen(d, 'mm') },
    { section: 'Character' },
    { label: 'Shape', text: (b) => b.shape_raw && b.shape_raw !== b.shape ? `${b.shape} (${b.shape_raw})` : b.shape },
    { label: 'Profile', text: (b) => b.profile_raw || G.PROFILE_LABEL[b.profile] },
    // Bar widths: a 1-10 rating maps to 10-100%.
    { label: 'Flex', node: (b) => isNum(b.flex) ? h('span', {}, h('span', { class: 'bar' }, h('i', { style: `width:${b.flex * 10}%` })), trim(b.flex, 1) + '/10' + (b.flex_text ? ' · ' + b.flex_text : '')) : null },
    { label: 'Terrain', node: (b) => {
      if (!b.terrain) return null;
      const t = b.terrain;
      const row = (name, v) => isNum(v) ? [h('span', {}, name), h('span', { class: 'bar' }, h('i', { style: `width:${v * 10}%` }))] : [];
      return h('div', { class: 'terrain' }, row('All-mountain', t.all_mountain), row('Powder', t.powder), row('Park', t.park));
    } },
    // Label the link with the site's real domain, e.g. "jonessnowboards.com".
    { label: 'Product page', node: (b) => b.url ? h('a', { href: b.url, target: '_blank', rel: 'noopener' }, new URL(b.url).hostname.replace(/^www\./, '') + ' ↗') : null },
  ];

  // Build the comparison table (one column per selected board) and the
  // footnote explaining what is measured and what is estimated.
  function renderTable() {
    const tbl = $('#specTable');
    tbl.textContent = '';
    if (!state.sel.length) return;
    const cols = state.sel.map((sel) => {
      const b = BY_ID.get(sel.id);
      return { sel, b, sz: sizeOf(b, sel.size), g: geo(b, sel.size) };
    });
    const thead = h('thead', {}, h('tr', {}, h('th', {}, ''), cols.map((c) => h('th', {},
      h('div', { class: 'colhead' },
        h('span', { class: 'sw', style: `background:${c.sel.color}` }),
        h('div', {}, h('div', { class: 'nm' }, displayName(c.b)), h('div', { class: 'br' }, c.b.brand + ' · ' + c.sel.size)))))));
    const tbody = h('tbody');
    ROWS.forEach((r) => {
      if (r.section) {
        tbody.append(h('tr', { class: 'section' }, h('th', {}, r.section), cols.map(() => h('td'))));
        return;
      }
      const vals = cols.map((c) => (r.num ? r.num(c.b, c.sz, c.g) : null));
      if (r.num && vals.every((v) => !isNum(v))) return; // nobody publishes it
      const tr = h('tr', {}, h('th', { title: r.hint || '' }, r.label));
      cols.forEach((c, i) => {
        let cell;
        if (r.num) {
          const v = vals[i];
          if (!isNum(v)) cell = h('td', { class: 'na' }, '—');
          else {
            const est = r.est && r.est(c.b, c.sz);
            cell = h('td', {}, h('span', { class: est ? 'est' : '', title: est ? 'Estimated from other specs' : '' }, r.f(v) + (est ? ' *' : '') + (r.extra ? r.extra(c.b, c.sz) : '')));
            // Difference against the first column.
            if (i > 0 && isNum(vals[0])) {
              const dtext = r.df(v - vals[0]);
              if (dtext) cell.append(h('span', { class: 'delta ' + (v > vals[0] ? 'pos' : 'neg') }, dtext));
            }
          }
        } else if (r.text) {
          const t = r.text(c.b, c.sz);
          cell = h('td', { class: t ? '' : 'na' }, t || '—');
        } else {
          const n = r.node(c.b, c.sz);
          cell = h('td', { class: n ? '' : 'na' }, n || '—');
        }
        tr.append(cell);
      });
      tbody.append(tr);
    });
    tbl.append(thead, tbody);

    // Footnote caveats only appear when they apply to a selected board.
    const notes = [];
    if (cols.some((c) => !c.g.splitMeasured)) notes.push('Burton does not publish nose/tail lengths, so the nose/tail split of those outlines is estimated from the board shape.');
    if (cols.some((c) => c.g.notes.length)) notes.push('Values marked * are estimated from the other published specs.');
    $('#footnote').textContent =
      'Outlines are rebuilt from each brand\'s published length, nose/waist/tail widths, sidecut radius, setback and stance. ' +
      'Widths and sidecut are to scale; the exact curve of the nose and tail tips, and the side profile, are approximations. ' +
      notes.join(' ') + ' Data from burton.com, jonessnowboards.com and nidecker.com, ' + (DATA.generated || '').slice(0, 10) + '.';
  }

  // --------------------------------------------------------------- database
  // Column definitions for the Database tab. Each row object r is
  // { b: board, sz: size, g: geometry }.
  //   v(r)     value used for sorting (and display, unless show is given)
  //   show(r)  custom display text
  //   unit     'cm' / 'mm' / 'r' (radius): how dbCell converts the number
  //            and which unit goes in the header
  const DB_COLS = [
    { key: 'sel', label: '' },
    { key: 'brand', label: 'Brand', v: (r) => r.b.brand },
    { key: 'name', label: 'Model', v: (r) => displayName(r.b) },
    // +0.5 sorts a wide size just after its regular twin (158 < 158W < 159).
    { key: 'size', label: 'Size', v: (r) => r.sz.length + (isWide(r.sz) ? 0.5 : 0), show: (r) => r.sz.label },
    { key: 'shape', label: 'Shape', v: (r) => r.b.shape, align: 'left' },
    { key: 'flex', label: 'Flex', v: (r) => r.b.flex, show: (r) => isNum(r.b.flex) ? trim(r.b.flex, 1) : '—' },
    { key: 'eff', label: 'Eff. edge', unit: 'cm', v: (r) => r.sz.eff_edge },
    { key: 'nose', label: 'Nose', unit: 'mm', v: (r) => r.sz.nose_w ?? r.g.Wn },
    { key: 'waist', label: 'Waist', unit: 'mm', v: (r) => r.sz.waist },
    { key: 'tail', label: 'Tail', unit: 'mm', v: (r) => r.sz.tail_w ?? r.g.Wt },
    { key: 'taper', label: 'Taper', unit: 'mm', v: (r) => r.sz.taper ?? (r.g.Wn - r.g.Wt) },
    { key: 'radius', label: 'Sidecut', unit: 'r', v: (r) => r.sz.radius },
    { key: 'setback', label: 'Setback', unit: 'mm', v: (r) => r.sz.setback },
    { key: 'stance', label: 'Stance', unit: 'cm', v: (r) => r.sz.ref_stance },
    { key: 'weight', label: 'Rider weight', v: (r) => r.sz.weight_kg ? r.sz.weight_kg[0] : null, show: (r) => fmt.weight(r.sz.weight_kg) || '—' },
  ];

  // Display text for one database cell, converted to the current units.
  // (Units appear in the column header, not in each cell.)
  function dbCell(col, r) {
    if (col.show) return col.show(r);
    const v = col.v(r);
    if (v == null || v === '') return '—';
    if (typeof v === 'string') return v;
    if (col.unit === 'cm') return imperial() ? trim(v / 25.4, 1) : trim(v / 10, 1);
    if (col.unit === 'mm') return imperial() ? trim(v / 25.4, 2) : trim(v, 1);
    if (col.unit === 'r') return imperial() ? trim(v * 3.28084, 1) : trim(v, 2);
    return String(v);
  }
  // Unit suffix for a column header, e.g. " (mm)" or " (in)".
  const unitHead = (u) => !u ? '' : u === 'r' ? (imperial() ? ' (ft)' : ' (m)') : imperial() ? ' (in)' : ` (${u})`;

  // Build the Database tab: one row per filtered board (at its recommended
  // size), or one per size when "Show every size" is ticked. Clicking a
  // header sorts by it (click again to reverse); clicking a row adds or
  // removes that board/size in the comparison.
  function renderDatabase() {
    const rows = [];
    filtered().forEach((b) => {
      const sizes = state.dbAll ? b.sizes : [recommendSize(b)];
      sizes.forEach((sz) => rows.push({ b, sz, g: geo(b, sz.label) }));
    });
    const col = DB_COLS.find((c) => c.key === state.dbSort.key) || DB_COLS[1];
    const dir = state.dbSort.dir;
    // Missing values always sort last; ties fall back to name, then length.
    rows.sort((a, c) => {
      const va = col.v(a), vc = col.v(c);
      if (va == null && vc == null) return 0;
      if (va == null) return 1;
      if (vc == null) return -1;
      const d = typeof va === 'string' ? va.localeCompare(vc) : va - vc;
      return d * dir || a.b.name.localeCompare(c.b.name) || a.sz.length - c.sz.length;
    });
    const tbl = $('#dbTable');
    tbl.textContent = '';
    tbl.append(h('thead', {}, h('tr', {}, DB_COLS.map((c) => h('th', {
      class: c.key === state.dbSort.key ? 'sorted' : '',
      onclick: c.key === 'sel' ? null : () => {
        state.dbSort = { key: c.key, dir: state.dbSort.key === c.key ? -state.dbSort.dir : 1 };
        renderDatabase();
      },
    }, c.label + unitHead(c.unit) + (c.key === state.dbSort.key ? (dir > 0 ? ' ▲' : ' ▼') : ''))))));
    const tb = h('tbody');
    rows.forEach((r) => {
      // "on" only when this exact size is the one being compared.
      const selEntry = state.sel.find((x) => x.id === r.b.id);
      const on = selEntry && selEntry.size === r.sz.label;
      tb.append(h('tr', {
        class: on ? 'sel' : '',
        onclick: () => {
          if (on) toggleBoard(r.b.id);
          else toggleBoard(r.b.id, r.sz.label);
        },
      }, DB_COLS.map((c) => c.key === 'sel'
        ? h('td', {}, h('input', { type: 'checkbox', checked: on, tabindex: -1, 'aria-label': 'Compare' }))
        : h('td', { class: c.key === 'name' ? 'model' : '' }, dbCell(c, r)))));
    });
    tbl.append(tb);
    $('#dbCount').textContent = rows.length + (state.dbAll ? ' board sizes' : ' boards') +
      (isNum(state.weight) ? ' · showing your recommended size' : ' · showing the middle size') + ' · click a row to compare';
  }

  // ------------------------------------------------------------- URL state
  // The comparison is mirrored into the URL fragment so it can be shared or
  // bookmarked. Only non-default values are written, e.g.
  //   #c=burton-custom-camber:158,jones-mountain-twin:157&a=stance&u=in&w=75
  //   c = id:size list, a = align, v = view, u = units, w = weight (kg),
  //   wide = wide sizes
  function writeHash() {
    const p = new URLSearchParams();
    if (state.sel.length) p.set('c', state.sel.map((x) => x.id + ':' + x.size).join(','));
    if (state.align !== 'center') p.set('a', state.align);
    if (state.view !== 'both') p.set('v', state.view);
    if (state.unit !== 'metric') p.set('u', 'in');
    if (isNum(state.weight)) p.set('w', String(Math.round(state.weight)));
    if (state.wide) p.set('wide', '1');
    // Leave ":" and "," unescaped so the link stays readable.
    const str = p.toString().replace(/%3A/g, ':').replace(/%2C/g, ',');
    const base = location.href.split('#')[0];
    // replaceState updates the URL without adding a history entry per change.
    try { history.replaceState(null, '', str ? base + '#' + str : base); } catch (e) { /* e.g. sandboxed frame */ }
  }
  // Restore state from the URL fragment. Returns true if it named boards to
  // compare (init then skips the default selection). Unknown ids are ignored;
  // an unknown size falls back to the recommended size.
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get('a')) state.align = p.get('a');
    if (p.get('v')) state.view = p.get('v');
    if (p.get('u') === 'in') state.unit = 'imperial';
    if (p.get('w') && isFinite(+p.get('w'))) state.weight = +p.get('w');
    if (p.get('wide')) state.wide = true;
    const c = p.get('c');
    if (c) {
      c.split(',').forEach((tok) => {
        const [id, size] = tok.split(':');
        const b = BY_ID.get(id);
        if (!b || state.sel.length >= MAX_SEL) return;
        state.sel.push({ id, size: b.sizes.some((x) => x.label === size) ? size : recommendSize(b).label, color: COLORS[state.sel.length], hidden: false, dx: 0 });
      });
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------- wire
  // Re-render everything that depends on the selection, then update the URL.
  function updateAll() {
    renderSelected();
    renderStage();
    renderTable();
    refreshList();
    writeHash();
  }

  // Copy state into the form controls (after reading the URL or switching
  // units).
  function syncControls() {
    document.querySelectorAll('#unitSeg button').forEach((b) => b.classList.toggle('on', b.dataset.unit === state.unit));
    document.querySelectorAll('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === state.view));
    $('#alignSel').value = state.align;
    $('#weightUnit').textContent = imperial() ? 'lb' : 'kg';
    $('#riderWeight').value = isNum(state.weight) ? Math.round(imperial() ? state.weight * 2.20462 : state.weight) : '';
    $('#wideOnly').checked = state.wide;
  }

  // Startup: choose the initial comparison, hook up every control, then
  // render.
  function init() {
    if (!BOARDS.length) {
      $('#empty').hidden = false;
      $('#empty').innerHTML = '<p>No board data found. Run <code>python scraper/scrape.py</code> to build <code>data/boards.js</code>.</p>';
      return;
    }
    buildFilterChips();
    const fromHash = readHash();
    // With no shared link, start with one flagship board per brand, or the
    // first popular board of each brand if those ids are missing.
    if (!fromHash) {
      ['burton-custom-camber', 'jones-mountain-twin', 'nidecker-merc'].forEach((id) => {
        const b = BY_ID.get(id);
        if (b) state.sel.push({ id, size: recommendSize(b).label, color: COLORS[state.sel.length], hidden: false, dx: 0 });
      });
      if (!state.sel.length) {
        BRANDS.forEach((br) => {
          const b = BOARDS.find((x) => x.brand === br && x.popular) || BOARDS.find((x) => x.brand === br);
          if (b) state.sel.push({ id: b.id, size: recommendSize(b).label, color: COLORS[state.sel.length], hidden: false, dx: 0 });
        });
      }
    }
    syncControls();

    // theme
    // A saved choice in localStorage wins; otherwise CSS follows the OS
    // setting. The button flips whichever theme is currently showing.
    try {
      const t = localStorage.getItem('bs-theme');
      if (t) document.documentElement.dataset.theme = t;
    } catch (e) { /* storage unavailable */ }
    $('#themeBtn').addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme ||
        (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('bs-theme', next); } catch (e) { /* ignore */ }
    });

    // tabs
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
      state.tab = t.dataset.tab;
      document.querySelectorAll('.tab').forEach((x) => {
        x.classList.toggle('active', x === t);
        x.setAttribute('aria-selected', x === t);
      });
      $('#tab-compare').hidden = state.tab !== 'compare';
      $('#tab-database').hidden = state.tab !== 'database';
      // Redraw whichever panel is now visible.
      if (state.tab === 'database') renderDatabase(); else renderStage();
    }));

    // Sidebar filters.
    $('#search').addEventListener('input', (e) => { state.q = e.target.value; refreshList(); });
    document.querySelectorAll('#genderSeg button').forEach((b) => b.addEventListener('click', () => {
      state.gender = b.dataset.g;
      document.querySelectorAll('#genderSeg button').forEach((x) => x.classList.toggle('on', x === b));
      refreshList();
    }));
    $('#popularOnly').addEventListener('change', (e) => { state.popular = e.target.checked; refreshList(); });
    $('#sortSel').addEventListener('change', (e) => { state.sort = e.target.value; refreshList(); });
    // Flex range: two overlapping sliders; if they cross, their values are
    // swapped so min <= max.
    const flexIn = () => {
      let a = +$('#flexMin').value, b = +$('#flexMax').value;
      if (a > b) [a, b] = [b, a];
      state.flexMin = a; state.flexMax = b;
      $('#flexOut').textContent = trim(a, 1) + '–' + trim(b, 1);
      refreshList();
    };
    $('#flexMin').addEventListener('input', flexIn);
    $('#flexMax').addEventListener('input', flexIn);

    // Rider weight / wide preference: re-pick the recommended size for every
    // selected board. The input is in the displayed unit; state is in kg.
    const resize = () => { state.sel.forEach((x) => { x.size = recommendSize(BY_ID.get(x.id)).label; x.dx = 0; }); updateAll(); };
    $('#riderWeight').addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      state.weight = isFinite(v) && v > 0 ? (imperial() ? v / 2.20462 : v) : null;
      resize();
    });
    $('#wideOnly').addEventListener('change', (e) => { state.wide = e.target.checked; resize(); });

    // Top bar and compare toolbar.
    document.querySelectorAll('#unitSeg button').forEach((b) => b.addEventListener('click', () => {
      state.unit = b.dataset.unit; syncControls(); updateAll();
    }));
    document.querySelectorAll('#viewSeg button').forEach((b) => b.addEventListener('click', () => {
      state.view = b.dataset.view; syncControls(); renderStage(); writeHash();
    }));
    // A new alignment clears manual drag offsets and horizontal pan.
    $('#alignSel').addEventListener('change', (e) => {
      state.align = e.target.value; state.sel.forEach((x) => { x.dx = 0; }); state.panX = 0; renderStage(); writeHash();
    });
    // Grid / Stance / Sidecut / Fill checkboxes -> state.show flags.
    [['tGrid', 'grid'], ['tStance', 'stance'], ['tSidecut', 'sidecut'], ['tFill', 'fill']].forEach(([id, k]) => {
      $('#' + id).addEventListener('change', (e) => { state.show[k] = e.target.checked; renderStage(); });
    });
    $('#exag').addEventListener('input', (e) => { state.exag = +e.target.value; $('#exagOut').textContent = state.exag; renderStage(); });
    // Zoom buttons zoom about the current centre (1.5x per click).
    $('#zoomIn').addEventListener('click', () => { state.zoom = Math.min(40, state.zoom * 1.5); renderStage(); });
    $('#zoomOut').addEventListener('click', () => {
      state.zoom = Math.max(1, state.zoom / 1.5);
      if (state.zoom === 1) { state.panX = 0; state.panY = 0; }
      renderStage();
    });
    $('#zoomFit').addEventListener('click', () => { state.zoom = 1; state.panX = 0; state.panY = 0; renderStage(); });
    document.querySelectorAll('[data-focus]').forEach((b) => b.addEventListener('click', () => focusRegion(b.dataset.focus)));
    $('#dbAllSizes').addEventListener('change', (e) => { state.dbAll = e.target.checked; renderDatabase(); });

    // Share: copy the URL (with its #state) to the clipboard. If the
    // Clipboard API is missing or refuses, show the link in a prompt instead.
    $('#shareBtn').addEventListener('click', () => {
      writeHash();
      const url = location.href;
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
        .then(() => toast('Link copied'))
        .catch(() => { prompt('Copy this link:', url); });
    });
    // Narrow screens: the sidebar collapses behind a toggle button.
    $('#sidebarToggle').addEventListener('click', (e) => {
      const open = $('#sidebar').classList.toggle('open');
      e.currentTarget.setAttribute('aria-expanded', open);
    });

    attachPointer(topSvg);
    attachPointer(sideSvg);
    // The layout depends on the stage's pixel width, so redraw on resize
    // (debounced by 50 ms).
    let rz;
    new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(renderStage, 50); }).observe($('#stage'));

    updateAll();
  }

  init();
})();
