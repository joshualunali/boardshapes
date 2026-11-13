# BoardShapes

Overlay and compare snowboard outlines and size charts, in the spirit of mouse-shape
comparison sites, using the published specs from Burton, Jones and Nidecker.

## Run it

Open `index.html` in a browser. There's no build step and no server is needed, because the data
ships as `data/boards.js`. To serve it anyway: `python -m http.server` and visit
http://localhost:8000.

## Features

- **Top view overlay**: outlines drawn to scale. Align by board center, stance center, waist,
  nose or tail. Toggle the grid, stance markers, sidecut points (widest/waist) and fill.
- **Measure**: hover to read every board's width at that point along the length.
- **Drag** an outline to slide it (double-click to snap back). Drag the background to pan.
  Zoom with Ctrl+scroll, double-click, the +/− buttons or the Nose/Waist/Tail presets.
- **Side profile**: a schematic camber/rocker shape that shares the top view's horizontal scale.
- **Spec table**: per-size specs with differences vs. the first board.
- **Rider weight** (+ wide toggle): picks each board's recommended size from the brand's weight
  ranges.
- **Database tab**: a sortable table of every board (or every size). Click a row to compare it.
- Filters (brand, men's/women's, shape, profile family, flex), cm/in units, light/dark theme,
  and a shareable URL (`#c=board-id:size,...`).

## Data pipeline (`scraper/scrape.py`)

```
python scraper/scrape.py                    # fetch collection + product pages (cached, rate-limited)
python scraper/scrape.py --brand jones      # one brand only
python scraper/scrape.py --offline          # re-parse cached HTML, no network
python scraper/scrape.py --import-dir DIR   # parse product pages you saved from your browser
```

The scraper reads each product page's size-chart table(s) and normalizes the different brand
formats into one schema (mm / m / kg):

| field | Burton | Jones | Nidecker |
|---|---|---|---|
| nose / waist / tail width | ✓ | ✓ | ✓ |
| sidecut radius | ✓ | ✓ | ✓ |
| effective edge, contact length | ✓ | ✓ | ✓ |
| nose / tail length (tip to contact point) | – | ✓ | ✓ |
| setback, reference stance | ✓ | ✓ | ✓ |
| rider weight range | ✓ | ✓ | ✓ |
| shape, profile, flex, terrain | ✓ | ✓ | ✓ |

It also writes `popular: true` for a hand-picked list of flagship models (`POPULAR` in the
script). `scraper/overrides.json` lets you correct any field or tune the drawn tips of a board
(e.g. add a swallowtail).

**Being a polite scraper.** Requests are spaced out per site and honour `Retry-After`. If a site
keeps refusing, the scraper skips it and keeps that brand's existing data. Raw HTML is cached in
`scraper/cache/`; delete it to refresh.

**Saved pages.** If a site rate-limits automated requests, open each product page in your
browser, use *Save page as… → Webpage, HTML only* into a folder, and run
`--import-dir` on that folder. The brand is detected from the page itself. `scraper/saved/`
holds the pages the current data was built from.

## How outlines are built (`assets/geometry.js`)

The outline is reconstructed from the numbers; it is not traced from photos:

- **To scale, from published specs:** total length, nose/waist/tail widths, sidecut radius
  (a circular arc, deepest at the waist, reaching the nose and tail widths), taper, setback
  (measured from the middle of the sidecut) and reference stance.
- **Modelled:** the curve of the nose and tail tips (a superellipse quadrant whose bluntness
  depends on the shape), plus the nose/tail split for brands that don't publish tip lengths
  (Burton), which is estimated from the shape category. The side profile is a schematic
  drawn from the profile type, with exaggerated camber/rocker.

The spec table marks values that were estimated rather than published with `*`.

## Before publishing publicly

Board names, specs and product images belong to the brands. Images are hotlinked from the
brands' CDNs, not copied. Check each brand's terms of use before running this as a public site.

## Layout

```
index.html            page shell
assets/style.css      styles (light/dark, responsive)
assets/geometry.js    outline + profile reconstruction
assets/app.js         UI: list, filters, overlay, table, database, URL state
data/boards.json      normalized data (generated)
data/boards.js        same data as a script for file:// use (generated)
scraper/scrape.py     scraper / importer
scraper/overrides.json manual corrections
scraper/saved/        saved product pages used for the current data
```
