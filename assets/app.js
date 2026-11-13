(function () {
  'use strict';

  const G = window.BoardGeometry;
  const DATA = window.BOARD_DATA || { boards: [] };
  const BOARDS = DATA.boards;
  const BY_ID = new Map(BOARDS.map((b) => [b.id, b]));
  const BRANDS = [...new Set(BOARDS.map((b) => b.brand))].sort();
  const COLORS = ['#2563eb', '#e11d48', '#16a34a', '#f59e0b', '#9333ea', '#0891b2', '#db2777', '#65a30d'];
  const MAX_SEL = COLORS.length;
  const SHAPES = ['Twin', 'Directional Twin', 'Directional'];
  const PROFILE_FAMILY = {
    camber: 'Camber', directional_camber: 'Camber',
    camrock: 'Hybrid', directional_camrock: 'Hybrid', hybrid_rocker: 'Hybrid',
    flat: 'Flat', directional_flat: 'Flat', rocker: 'Rocker',
  };
  const FAMILIES = ['Camber', 'Hybrid', 'Flat', 'Rocker'];

  const state = {
    sel: [], // {id, size, color, hidden, dx}
    q: '', brands: new Set(), gender: 'all', popular: false,
    shapes: new Set(), families: new Set(), flexMin: 1, flexMax: 10,
    sort: 'popular', unit: 'metric', weight: null, wide: false,
    view: 'both', align: 'center',
    show: { grid: true, stance: true, sidecut: false, fill: true },
    exag: 6, zoom: 1, panX: 0, panY: 0,
    tab: 'compare', dbAll: false, dbSort: { key: 'brand', dir: 1 },
  };

  // ------------------------------------------------------------------ utils
  const $ = (s) => document.querySelector(s);
  const SVGNS = 'http://www.w3.org/2000/svg';
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
  function s(tag, attrs) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs || {}) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    return e;
  }
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const trim = (v, d) => { const t = v.toFixed(d); return t.includes('.') ? t.replace(/\.?0+$/, '') : t; };
  const imperial = () => state.unit === 'imperial';

  const fmt = {
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
    radius(m) {
      if (!isNum(m)) return null;
      return imperial() ? trim(m * 3.28084, 1) + ' ft' : trim(m, 2) + ' m';
    },
    dradius(m) {
      if (!isNum(m) || Math.abs(m) < 0.005) return null;
      return (m > 0 ? '+' : '−') + fmt.radius(Math.abs(m));
    },
    weight(w) {
      if (!w) return null;
      const [lo, hi] = w;
      const c = (kg) => (imperial() ? Math.round(kg * 2.20462) : kg);
      const u = imperial() ? ' lb' : ' kg';
      return hi == null ? c(lo) + '+' + u : c(lo) + '–' + c(hi) + u;
    },
    kg(v) {
      if (!isNum(v)) return null;
      return imperial() ? trim(v * 2.20462, 1) + ' lb' : trim(v, 2) + ' kg';
    },
  };

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  function thumbUrl(url, w) {
    if (!url) return null;
    try {
      const u = new URL(url, location.href);
      if (u.pathname.includes('/cdn/shop/')) u.searchParams.set('width', w);
      return u.toString();
    } catch (e) { return url; }
  }

  // ------------------------------------------------------------ board model
  const isWide = (sz) => /W/i.test(sz.label);

  function recommendSize(b) {
    const pool = b.sizes.filter((sz) => (state.wide ? isWide(sz) : !isWide(sz)));
    const cand = pool.length ? pool : b.sizes;
    const mid = cand[Math.floor((cand.length - 1) / 2)];
    const w = state.weight;
    if (!isNum(w)) return mid;
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
    const t0 = ties[0];
    const t = Math.min(1, Math.max(0, (w - t0.lo) / Math.max(t0.hi - t0.lo, 1)));
    return ties[Math.round(t * (ties.length - 1))].sz;
  }

  const sizeOf = (b, label) => b.sizes.find((x) => x.label === label) || b.sizes[0];
  const geoCache = new Map();
  function geo(b, label) {
    const k = b.id + '|' + label;
    if (!geoCache.has(k)) geoCache.set(k, G.geometry(b, sizeOf(b, label)));
    return geoCache.get(k);
  }
  const sizeRange = (b) => {
    const n = [...new Set(b.sizes.map((x) => Math.round(x.length / 10)))].sort((a, c) => a - c);
    return n.length > 1 ? n[0] + '–' + n[n.length - 1] : String(n[0]);
  };
  const displayName = (b) => b.name + (b.gender === 'women' ? ' (W)' : '');

  // ---------------------------------------------------------------- filters
  function filtered() {
    const q = state.q.trim().toLowerCase();
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

  function sorted(list) {
    const mid = (b) => recommendSize(b);
    const by = {
      popular: (a, c) => a.brand.localeCompare(c.brand) || (c.popular - a.popular) || a.name.localeCompare(c.name),
      name: (a, c) => a.brand.localeCompare(c.brand) || a.name.localeCompare(c.name),
      flex: (a, c) => (a.flex ?? 99) - (c.flex ?? 99) || a.name.localeCompare(c.name),
      waist: (a, c) => mid(a).waist - mid(c).waist,
    }[state.sort];
    return list.slice().sort(by);
  }

  // ---------------------------------------------------------------- sidebar
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
  function miniOutline(b) {
    const sz = recommendSize(b);
    const g = geo(b, sz.label);
    const svg = s('svg', { viewBox: `${-g.Wn / 2 - 20} -20 ${g.Wn + 40} ${g.L + 40}` });
    const p = s('path', { d: G.outlinePath(g, 0), fill: 'var(--faint)', transform: `rotate(90) translate(0 0)` });
    // rotate so the nose points up
    p.setAttribute('transform', 'matrix(0 1 -1 0 0 0)');
    svg.append(p);
    return svg;
  }

  function refreshList() {
    const list = sorted(filtered());
    const ul = $('#boardList');
    ul.textContent = '';
    const selIds = new Set(state.sel.map((x) => x.id));
    const grouped = state.sort === 'popular' || state.sort === 'name';
    let lastBrand = null;
    list.forEach((b) => {
      if (grouped && b.brand !== lastBrand) {
        ul.append(h('li', { class: 'brand-head' }, b.brand));
        lastBrand = b.brand;
      }
      const selEntry = state.sel.find((x) => x.id === b.id);
      const rec = recommendSize(b);
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
      h('span', { class: 'dot', style: selEntry ? `background:${selEntry.color}` : '' })));
    });
    $('#resultCount').textContent = list.length + ' of ' + BOARDS.length + ' boards';
    $('#boardCount').textContent = '(' + state.sel.length + ' selected)';
    if (state.tab === 'database') renderDatabase();
  }

  // -------------------------------------------------------------- selection
  function toggleBoard(id, label) {
    const i = state.sel.findIndex((x) => x.id === id);
    if (i >= 0 && !label) { state.sel.splice(i, 1); }
    else if (i >= 0 && label) { state.sel[i].size = label; }
    else {
      if (state.sel.length >= MAX_SEL) { toast(`Compare up to ${MAX_SEL} boards at once`); return; }
      const b = BY_ID.get(id);
      const used = new Set(state.sel.map((x) => x.color));
      state.sel.push({ id, size: label || recommendSize(b).label, color: COLORS.find((c) => !used.has(c)), hidden: false, dx: 0 });
    }
    updateAll();
  }

  function renderSelected() {
    const box = $('#selected');
    box.textContent = '';
    state.sel.forEach((sel, idx) => {
      const b = BY_ID.get(sel.id);
      const rec = recommendSize(b).label;
      const select = h('select', {
        'aria-label': 'Size for ' + b.name,
        onchange: (e) => { sel.size = e.target.value; sel.dx = 0; updateAll(); },
      }, b.sizes.map((sz) => h('option', { value: sz.label, selected: sz.label === sel.size },
        sz.label + (isNum(state.weight) && sz.label === rec ? ' ★' : ''))));
      box.append(h('div', { class: 'sel-chip' + (sel.hidden ? ' hidden-board' : '') },
        h('span', { class: 'sw', style: `background:${sel.color}` }),
        h('span', {}, h('span', { class: 'nm' }, displayName(b)), ' ', h('span', { class: 'br' }, b.brand)),
        select,
        h('button', {
          class: 'eye', title: sel.hidden ? 'Show' : 'Hide', 'aria-label': sel.hidden ? 'Show board' : 'Hide board',
          onclick: () => { sel.hidden = !sel.hidden; updateAll(); },
          html: sel.hidden
            ? '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 6.1A9.9 9.9 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-2.6 3.2M6.6 6.6C4.3 8.1 3 12 3 12s4 6 9 6a9 9 0 0 0 4.4-1.1"/></svg>'
            : '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
        }),
        h('button', { class: 'x', title: 'Remove', 'aria-label': 'Remove ' + b.name, onclick: () => { state.sel.splice(idx, 1); updateAll(); } }, '×')));
    });
    $('#empty').hidden = state.sel.some((x) => !x.hidden);
  }

  // ------------------------------------------------------------------ stage
  const topSvg = $('#topSvg');
  const sideSvg = $('#sideSvg');
  let view = null; // current layout, used by pointer handlers

  function alignRef(g) {
    switch (state.align) {
      case 'stance': return g.stanceCenter;
      case 'waist': return g.xw;
      case 'nose': return 0;
      case 'tail': return g.L;
      default: return g.L / 2;
    }
  }

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
    const W0 = (maxX - minX) * 1.08 + 40;
    const cx0 = (minX + maxX) / 2;
    const vbW = W0 / state.zoom;
    const vbX = cx0 + state.panX - vbW / 2;
    const pxW = topSvg.clientWidth || topSvg.parentNode.clientWidth || 900;
    const pxPerMm = pxW / vbW;
    const fitPx = pxW / W0; // px per mm at zoom 1
    const topNeed = maxHalf * 2 * 1.15 + 64 / fitPx; // room for labels + axis
    const topH0 = Math.max(topNeed, W0 * 0.24);
    const sideH0 = G.PROFILE_MAX_Z(state.exag) + 70;
    // When zoomed in, let the views grow taller (up to a share of the window)
    // so a nose/tail close-up still shows the whole outline.
    const vh = window.innerHeight || 900;
    const topH = Math.max(topH0 / state.zoom, Math.min(topNeed, (vh * 0.7) / pxPerMm));
    const sideH = Math.max(sideH0 / state.zoom, Math.min(sideH0, (vh * 0.35) / pxPerMm));
    const maxPanY = Math.max(0, (topNeed - topH) / 2);
    state.panY = Math.max(-maxPanY, Math.min(maxPanY, state.panY));
    return { items, minX, maxX, maxHalf, W0, cx0, vbW, vbX, pxW, pxPerMm, topH, topH0, sideH, sideH0 };
  }

  function gridSteps(pxPerMm) {
    const steps = imperial()
      ? [25.4, 50.8, 152.4, 304.8, 609.6]
      : [10, 50, 100, 200, 500];
    const major = steps.find((st) => st * pxPerMm >= 70) || steps[steps.length - 1];
    let minor = imperial() ? (major >= 152.4 ? 25.4 : major / 4) : (major >= 100 ? major / 10 : major / 5);
    if (minor * pxPerMm < 7) minor = null;
    return { major, minor };
  }

  function axisLabel(mm) {
    if (imperial()) return trim(mm / 25.4, 1) + '″';
    return trim(mm / 10, 1);
  }

  function drawGrid(svg, L, x0, y0, w, hgt, labels) {
    const g = s('g');
    const { major, minor } = gridSteps(L.pxPerMm);
    const fs = 11 / L.pxPerMm;
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
      topSvg.setAttribute('viewBox', '0 0 1000 250');
      sideSvg.setAttribute('viewBox', '0 0 1000 120');
      return;
    }
    const px = 1 / L.pxPerMm; // one screen pixel in mm
    // ---- top view
    if (showTop) {
      const vbY = -L.topH / 2 + state.panY;
      topSvg.setAttribute('viewBox', `${L.vbX} ${vbY} ${L.vbW} ${L.topH}`);
      if (state.show.grid) drawGrid(topSvg, L, L.vbX, vbY, L.vbW, L.topH, 'top');
      topSvg.append(s('line', { x1: L.vbX, x2: L.vbX + L.vbW, y1: 0, y2: 0, class: 'centerline', 'vector-effect': 'non-scaling-stroke' }));

      const nose = s('text', { x: L.minX, y: -L.maxHalf - 14 * px, 'font-size': 11 * px, class: 'end-label' });
      nose.textContent = 'NOSE';
      const tail = s('text', { x: L.maxX, y: -L.maxHalf - 14 * px, 'font-size': 11 * px, class: 'end-label', 'text-anchor': 'end' });
      tail.textContent = 'TAIL';
      topSvg.append(nose, tail);

      L.items.slice().reverse().forEach((it) => {
        const { g, off, sel } = it;
        const grp = s('g', { 'data-id': sel.id });
        const path = s('path', {
          d: G.outlinePath(g, off), class: 'outline',
          fill: state.show.fill ? sel.color : 'none', 'fill-opacity': state.show.fill ? 0.1 : null,
          stroke: sel.color, 'stroke-width': 2, 'stroke-linejoin': 'round',
          'vector-effect': 'non-scaling-stroke', 'data-id': sel.id,
        });
        grp.append(path);
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
      topSvg.append(s('g', { id: 'topCursor' }));
    }

    // ---- side view (shares the horizontal scale with the top view)
    if (showSide) {
      // anchor to the ground line so a zoomed-in view still shows the base
      const contentBot = 30;
      const vbY = contentBot - L.sideH;
      sideSvg.setAttribute('viewBox', `${L.vbX} ${vbY} ${L.vbW} ${L.sideH}`);
      if (state.show.grid) drawGrid(sideSvg, L, L.vbX, vbY, L.vbW, L.sideH, false);
      sideSvg.append(s('line', { x1: L.vbX, x2: L.vbX + L.vbW, y1: 0, y2: 0, class: 'ground', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' }));
      L.items.slice().reverse().forEach((it) => {
        const pts = G.profile(it.b, it.g, state.exag);
        const d = 'M' + pts.map(([x, z]) => `${(x + it.off).toFixed(1)},${(-z).toFixed(2)}`).join('L');
        sideSvg.append(s('path', {
          d, fill: 'none', stroke: it.sel.color, 'stroke-width': 2.5, 'stroke-linecap': 'round',
          'vector-effect': 'non-scaling-stroke',
        }));
        it.g.contact.forEach((x) => sideSvg.append(s('circle', { cx: x + it.off, cy: 0, r: 3 * px, fill: it.sel.color })));
      });
      sideSvg.append(s('g', { id: 'sideCursor' }));
    }
  }

  // ---- pointer interaction: measure, drag boards, pan, zoom
  function svgX(svg, clientX) {
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return vb.x + ((clientX - r.left) / r.width) * vb.width;
  }

  function showCursor(svg, clientX, clientY) {
    if (!view) return;
    const x = svgX(svg, clientX);
    const px = 1 / view.pxPerMm;
    const rows = [];
    [['topCursor', topSvg], ['sideCursor', sideSvg]].forEach(([id, sv]) => {
      const g = sv.querySelector('#' + id);
      if (!g) return;
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
    view.items.forEach((it) => {
      const lx = x - it.off;
      const hw = G.halfWidthAt(it.g, lx);
      rows.push({ it, hw, lx });
    });
    const ro = $('#readout');
    ro.textContent = '';
    const refName = { center: 'center', stance: 'stance center', waist: 'waist', nose: 'nose', tail: 'tail' }[state.align];
    const d = x;
    ro.append(h('div', { class: 'rh' }, (Math.abs(d) < 0.5 ? 'at ' : (d < 0 ? '← ' : '→ ') + fmt.len(Math.abs(d), 'cm') + ' from ') + refName));
    rows.forEach(({ it, hw }) => {
      ro.append(h('div', { class: 'rr' },
        h('i', { style: `background:${it.sel.color}` }),
        h('span', {}, it.b.name + ' ' + it.sel.size),
        h('b', {}, hw == null ? '—' : fmt.len(hw * 2, 'mm'))));
    });
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

  function zoomAt(svg, clientX, factor, clientY) {
    if (!view) return;
    const x = svgX(svg, clientX);
    const nz = Math.min(40, Math.max(1, state.zoom * factor));
    // keep x under the cursor
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
    if (nz === 1) { state.panX = 0; state.panY = 0; }
    renderStage();
  }

  function attachPointer(svg) {
    let drag = null;
    svg.addEventListener('pointerdown', (e) => {
      if (!view || e.button !== 0) return;
      const id = e.target.getAttribute && e.target.getAttribute('data-id');
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
    svg.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAt(svg, e.clientX, e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientY);
    }, { passive: false });
  }

  function focusRegion(which) {
    const L = layout();
    if (!L) return;
    let a, b;
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
    { label: 'Flex', node: (b) => isNum(b.flex) ? h('span', {}, h('span', { class: 'bar' }, h('i', { style: `width:${b.flex * 10}%` })), trim(b.flex, 1) + '/10' + (b.flex_text ? ' · ' + b.flex_text : '')) : null },
    { label: 'Terrain', node: (b) => {
      if (!b.terrain) return null;
      const t = b.terrain;
      const row = (name, v) => isNum(v) ? [h('span', {}, name), h('span', { class: 'bar' }, h('i', { style: `width:${v * 10}%` }))] : [];
      return h('div', { class: 'terrain' }, row('All-mountain', t.all_mountain), row('Powder', t.powder), row('Park', t.park));
    } },
    { label: 'Product page', node: (b) => h('a', { href: b.url, target: '_blank', rel: 'noopener' }, b.brand.toLowerCase() + '.com ↗') },
  ];

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

    const notes = [];
    if (cols.some((c) => !c.g.splitMeasured)) notes.push('Burton does not publish nose/tail lengths, so the nose/tail split of those outlines is estimated from the board shape.');
    if (cols.some((c) => c.g.notes.length)) notes.push('Values marked * are estimated from the other published specs.');
    $('#footnote').textContent =
      'Outlines are rebuilt from each brand\'s published length, nose/waist/tail widths, sidecut radius, setback and stance. ' +
      'Widths and sidecut are to scale; the exact curve of the nose and tail tips, and the side profile, are approximations. ' +
      notes.join(' ') + ' Data from burton.com, jonessnowboards.com and nidecker.com, ' + (DATA.generated || '').slice(0, 10) + '.';
  }

  // --------------------------------------------------------------- database
  const DB_COLS = [
    { key: 'sel', label: '' },
    { key: 'brand', label: 'Brand', v: (r) => r.b.brand },
    { key: 'name', label: 'Model', v: (r) => displayName(r.b) },
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
  const unitHead = (u) => !u ? '' : u === 'r' ? (imperial() ? ' (ft)' : ' (m)') : imperial() ? ' (in)' : ` (${u})`;

  function renderDatabase() {
    const rows = [];
    filtered().forEach((b) => {
      const sizes = state.dbAll ? b.sizes : [recommendSize(b)];
      sizes.forEach((sz) => rows.push({ b, sz, g: geo(b, sz.label) }));
    });
    const col = DB_COLS.find((c) => c.key === state.dbSort.key) || DB_COLS[1];
    const dir = state.dbSort.dir;
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
  function writeHash() {
    const p = new URLSearchParams();
    if (state.sel.length) p.set('c', state.sel.map((x) => x.id + ':' + x.size).join(','));
    if (state.align !== 'center') p.set('a', state.align);
    if (state.view !== 'both') p.set('v', state.view);
    if (state.unit !== 'metric') p.set('u', 'in');
    if (isNum(state.weight)) p.set('w', String(Math.round(state.weight)));
    if (state.wide) p.set('wide', '1');
    const str = p.toString().replace(/%3A/g, ':').replace(/%2C/g, ',');
    const base = location.href.split('#')[0];
    try { history.replaceState(null, '', str ? base + '#' + str : base); } catch (e) { /* e.g. sandboxed frame */ }
  }
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
  function updateAll() {
    renderSelected();
    renderStage();
    renderTable();
    refreshList();
    writeHash();
  }

  function syncControls() {
    document.querySelectorAll('#unitSeg button').forEach((b) => b.classList.toggle('on', b.dataset.unit === state.unit));
    document.querySelectorAll('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === state.view));
    $('#alignSel').value = state.align;
    $('#weightUnit').textContent = imperial() ? 'lb' : 'kg';
    $('#riderWeight').value = isNum(state.weight) ? Math.round(imperial() ? state.weight * 2.20462 : state.weight) : '';
    $('#wideOnly').checked = state.wide;
  }

  function init() {
    if (!BOARDS.length) {
      $('#empty').hidden = false;
      $('#empty').innerHTML = '<p>No board data found. Run <code>python scraper/scrape.py</code> to build <code>data/boards.js</code>.</p>';
      return;
    }
    buildFilterChips();
    const fromHash = readHash();
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
      if (state.tab === 'database') renderDatabase(); else renderStage();
    }));

    $('#search').addEventListener('input', (e) => { state.q = e.target.value; refreshList(); });
    document.querySelectorAll('#genderSeg button').forEach((b) => b.addEventListener('click', () => {
      state.gender = b.dataset.g;
      document.querySelectorAll('#genderSeg button').forEach((x) => x.classList.toggle('on', x === b));
      refreshList();
    }));
    $('#popularOnly').addEventListener('change', (e) => { state.popular = e.target.checked; refreshList(); });
    $('#sortSel').addEventListener('change', (e) => { state.sort = e.target.value; refreshList(); });
    const flexIn = () => {
      let a = +$('#flexMin').value, b = +$('#flexMax').value;
      if (a > b) [a, b] = [b, a];
      state.flexMin = a; state.flexMax = b;
      $('#flexOut').textContent = trim(a, 1) + '–' + trim(b, 1);
      refreshList();
    };
    $('#flexMin').addEventListener('input', flexIn);
    $('#flexMax').addEventListener('input', flexIn);

    const resize = () => { state.sel.forEach((x) => { x.size = recommendSize(BY_ID.get(x.id)).label; x.dx = 0; }); updateAll(); };
    $('#riderWeight').addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      state.weight = isFinite(v) && v > 0 ? (imperial() ? v / 2.20462 : v) : null;
      resize();
    });
    $('#wideOnly').addEventListener('change', (e) => { state.wide = e.target.checked; resize(); });

    document.querySelectorAll('#unitSeg button').forEach((b) => b.addEventListener('click', () => {
      state.unit = b.dataset.unit; syncControls(); updateAll();
    }));
    document.querySelectorAll('#viewSeg button').forEach((b) => b.addEventListener('click', () => {
      state.view = b.dataset.view; syncControls(); renderStage(); writeHash();
    }));
    $('#alignSel').addEventListener('change', (e) => {
      state.align = e.target.value; state.sel.forEach((x) => { x.dx = 0; }); state.panX = 0; renderStage(); writeHash();
    });
    [['tGrid', 'grid'], ['tStance', 'stance'], ['tSidecut', 'sidecut'], ['tFill', 'fill']].forEach(([id, k]) => {
      $('#' + id).addEventListener('change', (e) => { state.show[k] = e.target.checked; renderStage(); });
    });
    $('#exag').addEventListener('input', (e) => { state.exag = +e.target.value; $('#exagOut').textContent = state.exag; renderStage(); });
    $('#zoomIn').addEventListener('click', () => { state.zoom = Math.min(40, state.zoom * 1.5); renderStage(); });
    $('#zoomOut').addEventListener('click', () => {
      state.zoom = Math.max(1, state.zoom / 1.5);
      if (state.zoom === 1) { state.panX = 0; state.panY = 0; }
      renderStage();
    });
    $('#zoomFit').addEventListener('click', () => { state.zoom = 1; state.panX = 0; state.panY = 0; renderStage(); });
    document.querySelectorAll('[data-focus]').forEach((b) => b.addEventListener('click', () => focusRegion(b.dataset.focus)));
    $('#dbAllSizes').addEventListener('change', (e) => { state.dbAll = e.target.checked; renderDatabase(); });

    $('#shareBtn').addEventListener('click', () => {
      writeHash();
      const url = location.href;
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
        .then(() => toast('Link copied'))
        .catch(() => { prompt('Copy this link:', url); });
    });
    $('#sidebarToggle').addEventListener('click', (e) => {
      const open = $('#sidebar').classList.toggle('open');
      e.currentTarget.setAttribute('aria-expanded', open);
    });

    attachPointer(topSvg);
    attachPointer(sideSvg);
    let rz;
    new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(renderStage, 50); }).observe($('#stage'));

    updateAll();
  }

  init();
})();
