#!/usr/bin/env python3
"""
Scrape snowboard size charts from Burton, Jones and Nidecker.

Writes:
  data/boards.json   - normalized board + per-size spec data
  data/boards.js     - same data as `window.BOARD_DATA = {...}` so index.html
                       works when opened straight from disk (file://)

Raw HTML is cached in scraper/cache/ so re-runs (or `--offline` re-parses)
don't hit the brand sites again. Delete the cache to refresh.

Usage:
  python scraper/scrape.py              # fetch (polite, cached) + parse
  python scraper/scrape.py --offline    # re-parse cached HTML only
  python scraper/scrape.py --brand jones
  python scraper/scrape.py --import-dir scraper/saved   # parse pages saved
                                                        # from a browser

Pipeline overview:
  1. collection_links()  - walk each brand's men's/women's collection pages
                           and collect product URLs that look like snowboards
  2. fetch()             - download each product page (or read it from cache)
  3. parse_product()     - pull the size-chart <table>s (parse_tables), turn
                           each size column into a normalized record in mm / kg
                           (build_sizes), and read brand-specific metadata such
                           as shape, profile, flex and terrain (META[brand])
  4. main()              - merge with existing data, apply overrides.json,
                           sort, and write data/boards.json + data/boards.js
"""
import argparse
import datetime as dt
import html
import json
import pathlib
import random
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

# Project paths, all resolved relative to the repo root (one level above
# this file's folder) so the script works from any working directory.
ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / "scraper" / "cache"
OUT_JSON = ROOT / "data" / "boards.json"
OUT_JS = ROOT / "data" / "boards.js"
OVERRIDES = ROOT / "scraper" / "overrides.json"

# Browser-like User-Agent; the brand stores serve bot-challenge pages to
# obviously scripted clients.
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")

# Per-brand config:
#   name        - display name written into the data
#   base        - site origin that relative product links are joined to
#   collections - (gender, path) pairs for the listing pages to crawl
#   delay       - minimum seconds between requests to that host
BRANDS = {
    "burton": {
        "name": "Burton",
        "base": "https://www.burton.com",
        "collections": [("men", "/en-us/collections/mens-snowboards"),
                        ("women", "/en-us/collections/womens-snowboards")],
        "delay": 9,  # Burton rate-limits aggressively
    },
    "jones": {
        "name": "Jones",
        "base": "https://www.jonessnowboards.com",
        "collections": [("men", "/collections/mens-snowboards"),
                        ("women", "/collections/womens-snowboards")],
        "delay": 4,
    },
    "nidecker": {
        "name": "Nidecker",
        "base": "https://www.nidecker.com",
        "collections": [("men", "/collections/men-snowboards"),
                        ("women", "/collections/women-snowboards")],
        "delay": 4,
    },
}

# Hand-picked flagship / best-selling models, flagged `popular` in the data.
# Matched as substrings of the cleaned model name.
POPULAR = {
    "burton": ["custom", "process", "instigator", "feelgood", "hometown hero",
               "good company", "rewind", "yeasayer", "ripcord", "cartographer",
               "high fidelity", "counterbalance", "blossom"],
    "jones": ["mountain twin", "frontier", "flagship", "stratos", "hovercraft",
              "mind expander", "storm chaser", "aviator", "tweaker",
              "twin sister", "dream weaver", "airheart"],
    "nidecker": ["merc", "sensor", "play", "escape", "blade", "megalight",
                 "gamma", "elle", "ora", "astral"],
}

# Product handles containing any of these are not snowboards (or not adult
# solid boards) and are skipped.
SKIP_HANDLE = re.compile(
    r"split|backpack|bag|jacket|pant|bib|boot|binding|glove|mitt|hood|kid|"
    r"toddler|youth|junior|grom|one-piece|leash|wax|tool|beanie|sock|helmet|"
    r"goggle|pow-surf|snowg|stomp|tee|shirt|hat|cap|gift", re.I)


def log(*a):
    """Print progress to stderr (keeps stdout clean) and flush immediately
    so messages show up during long rate-limit sleeps."""
    print(*a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# Fetching (polite, cached, honours Retry-After)
# --------------------------------------------------------------------------
def _fetch_curl(url):
    """Download `url` with the system curl binary.

    Preferred over urllib when curl is installed: its TLS/HTTP fingerprint is
    less likely to trip the stores' bot protection. Response headers are
    dumped to cache/_hdr.txt (overwritten on every request) so the
    Retry-After value can be read back after a 429/503.

    Returns (status_code, body_text, retry_after_seconds_or_None).
    """
    hdr = CACHE / "_hdr.txt"
    hdr.parent.mkdir(parents=True, exist_ok=True)
    p = subprocess.run(
        ["curl", "-s", "-L", "--compressed", "-A", UA,
         "-H", "Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
         "-H", "Accept-Language: en-US,en;q=0.9",
         # -D writes headers to a file; -w appends a status marker after the
         # body so the code can be split off the end of stdout.
         "-D", str(hdr), "-w", "\n__STATUS__%{http_code}", url],
        capture_output=True, timeout=60)
    out = p.stdout.decode("utf-8", "replace")
    body, _, status = out.rpartition("\n__STATUS__")
    retry = None
    try:
        # With -L there may be several header blocks (one per redirect);
        # the last Retry-After belongs to the final response.
        m = re.findall(r"(?im)^retry-after:\s*(\d+)", hdr.read_text("latin-1"))
        retry = int(m[-1]) if m else None
    except OSError:
        pass
    return int(status or 0), body, retry


def _fetch_urllib(url):
    """Pure-Python fallback used when curl isn't on PATH.

    Same return shape as _fetch_curl: (status, body, retry_after).
    """
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode("utf-8", "replace"), None
    except urllib.error.HTTPError as e:
        # Only the delay-seconds form of Retry-After is handled (not dates).
        ra = e.headers.get("Retry-After")
        return e.code, "", int(ra) if ra and ra.isdigit() else None


_last_hit = {}    # host -> time.time() of the last request, for rate limiting
_refused = set()  # hosts that keep refusing us this run


def fetch(url, cache_file, delay, offline=False):
    """Return the HTML for `url`, using `cache_file` as a permanent cache.

    - A cached copy is always returned without touching the network.
    - In offline mode a cache miss returns None.
    - Requests to the same host are spaced at least `delay` seconds apart,
      plus up to 30% random jitter.
    - Up to 3 attempts; non-404 failures back off for max(Retry-After, 60s)
      times the attempt number. A host that fails all 3 is skipped for the
      rest of the run.

    Returns the page text, or None if it couldn't be fetched.
    """
    if cache_file.exists():
        return cache_file.read_text("utf-8")
    if offline:
        return None
    host = url.split("/")[2]  # "https://host/path" -> "host"
    if host in _refused:
        return None
    # Sleep until `delay` seconds have passed since the last hit on this host.
    wait = _last_hit.get(host, 0) + delay - time.time()
    if wait > 0:
        time.sleep(wait + random.uniform(0, delay * 0.3))
    getter = _fetch_curl if shutil.which("curl") else _fetch_urllib
    for attempt in range(3):
        status, body, retry = getter(url)
        _last_hit[host] = time.time()
        # A real product page is far larger than 5 KB; anything smaller is
        # usually a bot-challenge or error stub that must not be cached.
        if status == 200 and len(body) > 5000:
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(body, "utf-8")
            return body
        if status == 404:
            log(f"  404 {url}")
            return None
        if attempt < 2:
            # Wait at least 60s, then 120s+ on the second retry.
            backoff = max(retry or 60, 60) * (attempt + 1)
            log(f"  HTTP {status} on {url} -> waiting {backoff}s")
            time.sleep(backoff)
    _refused.add(host)
    log(f"  {host} is refusing requests (HTTP {status}); skipping it for this run.\n"
        f"  Try again later, or save the product pages from your browser and run\n"
        f"  `python scraper/scrape.py --import-dir <folder>`.")
    return None


def cache_name(url):
    """Turn a URL's path (and query) into a filesystem-safe cache filename.

    e.g. "https://x.com/collections/mens?page=2" -> "collections_mens_page_2.html"
    """
    path = url.split("://", 1)[1].split("/", 1)[1]  # drop scheme and host
    return re.sub(r"[^a-zA-Z0-9]+", "_", path).strip("_")[:150] + ".html"


# --------------------------------------------------------------------------
# HTML helpers
# --------------------------------------------------------------------------
# These use regexes rather than an HTML parser so the script has no
# third-party dependencies; the markup involved (tables, meta tags) is
# simple enough for that.
def strip_tags(s):
    """Convert an HTML fragment (e.g. a table cell) to plain, single-spaced
    text. <br> becomes a space so "7.8<br>8.2" doesn't fuse into "7.88.2"."""
    s = re.sub(r"<br\s*/?>", " ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def page_lines(page):
    """Flatten a whole page into its visible text, one text node per line.

    Script/style/svg/noscript blocks are dropped first. Each tag becomes a
    line break, so a spec rendered as <dt>Shape</dt><dd>Twin</dd> turns into
    the consecutive lines "Shape", "Twin". The brand meta_* parsers rely on
    that label-then-value pattern.
    """
    s = re.sub(r"<(script|style|svg|noscript)\b.*?</\1>", "", page,
               flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", "\n", s)
    return [re.sub(r"\s+", " ", html.unescape(l)).strip()
            for l in s.split("\n") if l.strip()]


def meta_content(page, prop):
    """Return the content of <meta property|name="prop" content="...">.

    Attribute order varies between sites, so both orders are tried.
    """
    m = re.search(r'<meta[^>]+(?:property|name)="%s"[^>]+content="([^"]*)"'
                  % re.escape(prop), page, re.I)
    if not m:
        m = re.search(r'<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="%s"'
                      % re.escape(prop), page, re.I)
    return html.unescape(m.group(1)).strip() if m else None


def jsonld_product(page):
    """Return the first schema.org Product object in the page's JSON-LD
    <script> blocks (it holds a clean name and description), or {}."""
    for blk in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>',
                          page, re.S | re.I):
        try:
            data = json.loads(blk)
        except ValueError:
            continue  # malformed block; try the next one
        items = data if isinstance(data, list) else [data]
        for it in items:
            if isinstance(it, dict) and it.get("@type") == "Product":
                return it
    return {}


def parse_tables(page):
    """Merge every size-chart table on the page into {label: {size: value}}.

    A size chart is a table whose first header cell mentions "size" and
    whose other header cells include at least one size label starting with
    three digits ("154", "158W"). Rows are spec labels ("Waist Width (mm)"),
    columns are sizes.

    Returns (order, merged):
      order  - size labels in the order first seen, e.g. ["150", "154", "158W"]
      merged - {row label: {size label: raw cell text}}; when several tables
               contain the same row, the first value seen wins.
    """
    order, merged = [], {}
    for t in re.findall(r"<table\b.*?</table>", page, re.S | re.I):
        # Build a 2-D grid of plain-text cells (th and td alike).
        rows = re.findall(r"<tr\b[^>]*>(.*?)</tr>", t, re.S | re.I)
        grid = [[strip_tags(c) for c in
                 re.findall(r"<t[hd]\b[^>]*>(.*?)</t[hd]>", r, re.S | re.I)]
                for r in rows]
        grid = [g for g in grid if g]
        if not grid or len(grid[0]) < 2:
            continue
        head = grid[0]
        if not re.search(r"size", head[0], re.I):
            continue  # not a size chart
        # Normalize size labels: "158 W" -> "158W".
        sizes = [re.sub(r"\s+", "", h).upper() for h in head[1:]]
        if not any(re.match(r"^\d{3}", s) for s in sizes):
            continue
        for s in sizes:
            if s and s not in order:
                order.append(s)
        for row in grid[1:]:
            if len(row) < 2 or not row[0]:
                continue
            d = merged.setdefault(row[0], {})
            for s, v in zip(sizes, row[1:]):
                if s and v and s not in d:
                    d[s] = v
    return order, merged


# --------------------------------------------------------------------------
# Value normalization
# --------------------------------------------------------------------------
# Maps a size-chart row label to an internal key. Matching is
# case-insensitive and in list order: the first pattern that matches a label
# wins, and the first label found for a key wins (see build_sizes). Order
# therefore matters, e.g. the "(kg)" weight row is preferred over "(lbs)".
FIELDS = [  # (regex on row label, key)
    (r"rider.?s? weight.*\(kg\)", "weight"),
    (r"rider.?s? weight.*\(lbs?\)", "weight_lbs"),
    (r"^(weight range|rider weight|recommended weight)", "weight"),
    (r"^total length", "length"),
    (r"^(nose|tip) length", "nose_len"),
    (r"^tail length", "tail_len"),
    (r"^(contact (edge )?length|running length)", "contact"),
    (r"^effective edge", "eff_edge"),
    (r"^(board )?waist width", "waist"),
    (r"^underfoot width.*front", "underfoot_front"),
    (r"^underfoot width.*(back|rear)", "underfoot_rear"),
    (r"^(nose|tip) width", "nose_w"),
    (r"^tail width", "tail_w"),
    (r"^sidecut radius", "radius"),
    (r"^sidecut depth", "sidecut_depth"),
    (r"^taper", "taper"),
    (r"^(stance setback|set ?back|stance location)", "setback"),
    (r"^(reference stance|stance width)", "ref_stance"),
    (r"^min\w*\s*-\s*max\w* stance", "stance_range"),
    (r"^board weight", "board_weight"),
    (r"^surface area", "surface"),
]
# Keys holding a single length; these are all converted to millimetres.
LENGTH_KEYS = {"length", "nose_len", "tail_len", "contact", "eff_edge", "waist",
               "underfoot_front", "underfoot_rear", "nose_w", "tail_w",
               "sidecut_depth", "taper", "setback", "ref_stance"}
# Unit assumed when neither the cell nor the row label states one
DEFAULT_UNIT = {"setback": "mm", "taper": "mm", "sidecut_depth": "mm"}
# Multiplier that converts each unit to millimetres.
SCALE = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4}

# A number, allowing a leading minus and either "." or "," as the decimal
# separator (European sites write "7,8").
NUM_RE = re.compile(r"-?\d+(?:[.,]\d+)?")


def nums(v):
    """Return every number in the string `v` as a float."""
    return [float(x.replace(",", ".")) for x in NUM_RE.findall(v)]


def unit_of(value, label):
    """Work out the unit of a cell: first from the value itself ("25 mm"),
    then from the row label ("Waist Width (cm)"). Returns None if neither
    states one."""
    m = re.search(r"\d\s*(mm|cm|m|in)\b", value.lower())
    if m:
        return m.group(1)
    m = re.search(r"\((mm|cm|m)\b", label.lower())
    return m.group(1) if m else None


def to_mm(key, value, label):
    """Convert a length cell to millimetres (rounded to 0.1 mm).

    The unit comes from the cell, the row label, DEFAULT_UNIT, or, as a last
    resort, the magnitude: >= 100 is assumed to be mm (a 250 mm waist),
    smaller is cm (a 25.0 cm waist). Returns None if the cell has no number.
    """
    n = nums(value)
    if not n:
        return None
    u = unit_of(value, label) or DEFAULT_UNIT.get(key)
    x = n[0]
    if u is None:  # guess from magnitude
        u = "mm" if abs(x) >= 100 else "cm"
        if key in ("setback", "taper"):
            u = "mm"
    return round(x * SCALE[u], 1)


def parse_weight(value, label):
    """Parse a rider-weight cell into [lo_kg, hi_kg].

    Handles "54-82", "54–82 kg / 120–180 lbs", "120-180 lbs" and open-ended
    "90+" (hi becomes None). Pounds are converted to kg. Returns None if no
    number is found.
    """
    v = value.lower().replace("–", "-")  # en dash -> hyphen
    parts = v.split("/")                 # "kg part / lbs part"
    kg_part = next((p for p in parts if "kg" in p), None)
    factor = 1.0
    if kg_part is None:
        if "kg" in label.lower() and "lb" not in label.lower():
            kg_part = v
        elif "lb" in v or "lb" in label.lower():
            kg_part, factor = parts[0], 0.4536  # lb -> kg
        else:
            kg_part = v
    # abs() because NUM_RE reads the "-" in a range as a minus sign.
    n = [abs(x) * factor for x in nums(kg_part)]  # "54-82" -> 54, 82
    if not n:
        return None
    lo = round(n[0])
    hi = round(n[1]) if len(n) > 1 else None
    return [lo, hi]


def size_number(label):
    """Leading three digits of a size label as an int ("158W" -> 158), i.e.
    the nominal length in cm. None if the label doesn't start with them."""
    m = re.match(r"(\d{3})", label)
    return int(m.group(1)) if m else None


def build_sizes(order, merged):
    """Turn parse_tables() output into a list of per-size spec records.

    Each record has "label" plus whichever normalized fields the brand
    publishes: lengths in mm, "radius" in metres, "weight_kg" as [lo, hi],
    "stance_range" in mm, "board_weight_kg" and "surface_dm2". Sizes without
    a plausible waist width are dropped, because the outline can't be drawn
    without one.
    """
    # Decide which table row supplies each key (first matching label wins).
    keymap = {}
    for label in merged:
        for rx, key in FIELDS:
            if re.search(rx, label, re.I):
                keymap.setdefault(key, label)
                break
    sizes = []
    for s in order:
        rec = {"label": s}
        for key, label in keymap.items():
            raw = merged[label].get(s)
            # Skip empty cells and dash placeholders.
            if raw is None or not raw.strip() or raw.strip() in ("-", "–"):
                continue
            if key in LENGTH_KEYS:
                val = to_mm(key, raw, label)
                if val is not None:
                    # Some brands publish setback as a negative number.
                    rec[key] = abs(val) if key == "setback" else val
            elif key == "radius":
                n = nums(raw)
                if n:
                    # Radius should be in metres; values in mm (e.g. 7800)
                    # are scaled down.
                    if unit_of(raw, label) == "mm" or n[0] > 100:
                        n = [x / 1000 for x in n]
                    # Progressive sidecuts list several radii ("7.5/8.2");
                    # store their average and keep the original text.
                    rec["radius"] = round(sum(n) / len(n), 2)
                    if len(n) > 1:
                        rec["radius_raw"] = raw
            elif key == "weight":
                w = parse_weight(raw, label)
                if w:
                    rec["weight_kg"] = w
            elif key == "weight_lbs":
                # Only used when the chart has no kg row.
                if "weight_kg" not in rec:
                    w = parse_weight(raw, label + " lbs")
                    if w:
                        rec["weight_kg"] = w
            elif key == "stance_range":
                n = [abs(x) for x in nums(raw)]
                if len(n) >= 2:
                    f = SCALE[unit_of(raw, label) or ("mm" if n[0] > 100 else "cm")]
                    rec["stance_range"] = [round(n[0] * f), round(n[1] * f)]
            elif key == "board_weight":
                m = re.search(r"(\d+(?:[.,]\d+)?)\s*kg", raw.lower())
                if m:
                    rec["board_weight_kg"] = float(m.group(1).replace(",", "."))
            elif key == "surface":
                n = nums(raw)
                if n:
                    rec["surface_dm2"] = n[0]
        # No explicit length row: fall back to the nominal size in cm.
        if "length" not in rec and size_number(s):
            rec["length"] = size_number(s) * 10.0
        # derived / sanity
        if "nose_w" in rec and "tail_w" in rec and "taper" not in rec:
            rec["taper"] = round(rec["nose_w"] - rec["tail_w"], 1)
        if not (150 < rec.get("waist", 0) < 350):
            continue  # no usable width data for this size
        sizes.append(rec)
    return sizes


# --------------------------------------------------------------------------
# Brand-specific metadata (shape / profile / flex / terrain)
# --------------------------------------------------------------------------
# Each meta_<brand>(lines) function takes the page_lines() of a product page
# and returns a dict with any of: shape, profile, flex (1-10), flex_text,
# flex_type, terrain ({park, all_mountain, powder} each 0-10) and level.
def after(lines, pred, start=0, stop=None, offset=1):
    """Find the first line in lines[start:stop] matching `pred` and return
    the line `offset` positions after it (the value under a label), or None.
    """
    stop = len(lines) if stop is None else min(stop, len(lines))
    for i in range(start, stop):
        if pred(lines[i]):
            j = i + offset
            return lines[j] if j < len(lines) else None
    return None


def index_of(lines, pred, start=0):
    """Index of the first line at or after `start` matching `pred`, or None."""
    for i in range(start, len(lines)):
        if pred(lines[i]):
            return i
    return None


def meta_burton(lines):
    """Read Burton's "Tech Specs", "Personality", "Terrain" and "Riding
    Level" sections."""
    m = {}
    # Tech Specs lists "Bend", "Shape" and "Flex", each followed by its
    # value; only the 30 lines after the heading are searched.
    i = index_of(lines, lambda l: l == "Tech Specs")
    if i is not None:
        for key, out in (("Bend", "profile"), ("Shape", "shape"),
                         ("Flex", "flex_type")):
            # k=key binds the current loop value inside the lambda.
            v = after(lines, lambda l, k=key: l == k, i, i + 30)
            if v:
                m[out] = v
    # Personality is a word scale, e.g. "(Soft to Medium)". Each word maps to
    # a number and the average becomes the 1-10 flex rating.
    p = index_of(lines, lambda l: l == "Personality")
    if p is not None and p + 1 < len(lines) and lines[p + 1].startswith("("):
        pers = lines[p + 1].strip("() ")
        m["flex_text"] = pers
        cats = {"soft": 3, "medium": 5.5, "stiff": 8}
        hits = [v for k, v in cats.items() if k in pers.lower()]
        if hits:
            m["flex"] = round(sum(hits) / len(hits), 1)
    # Terrain gives a percentage per category; divide by 10 for a 0-10 score.
    t = index_of(lines, lambda l: l == "Terrain")
    if t is not None:
        terr = {}
        for name, key in (("Park", "park"), ("All Mountain", "all_mountain"),
                          ("Powder", "powder")):
            j = index_of(lines, lambda l, n=name: l == n, t)
            if j is not None and j + 1 < len(lines):
                pct = re.findall(r"(\d+)\s*%", lines[j + 1])
                if pct:
                    terr[key] = round(int(pct[-1]) / 10, 1)
        if terr:
            m["terrain"] = terr
    # Riding Level: whichever level names appear in the next few lines.
    r = index_of(lines, lambda l: l == "Riding Level")
    if r is not None:
        lv = [l for l in lines[r + 1:r + 6] if l in ("Beginner", "Intermediate", "Expert")]
        if lv:
            m["level"] = lv
    return m


def meta_jones(lines):
    """Read Jones's bracketed spec labels ("[Shape]", "[Profile]"), the
    "Personality/Flex" block and the terrain ratings."""
    m = {}
    v = after(lines, lambda l: l == "[Shape]")
    if v:
        m["shape"] = v
    # The site sometimes spells the label "[Pr0file]" with a zero.
    v = after(lines, lambda l: re.fullmatch(r"\[Pr[o0]file\]", l) is not None)
    if v:
        m["profile"] = v
    # "Personality/Flex" is followed by a description, then a numeric rating.
    i = index_of(lines, lambda l: l == "Personality/Flex")
    if i is not None:
        m["flex_text"] = lines[i + 1]
        n = nums(lines[i + 2]) if i + 2 < len(lines) else []
        if n:
            m["flex"] = n[0]
    # Each terrain category is followed by its rating, already out of 10.
    terr = {}
    for name, key in (("All-mountain / Resort", "all_mountain"),
                      ("Freeride / Powder", "powder"),
                      ("Freestyle / Park", "park")):
        j = index_of(lines, lambda l, n=name: l == n)
        if j is not None and j + 1 < len(lines) and nums(lines[j + 1]):
            terr[key] = nums(lines[j + 1])[0]
    if terr:
        m["terrain"] = terr
    return m


def meta_nidecker(lines):
    """Read Nidecker's "Flex rating: x/5"-style lines and the "Shape and
    Profile" block. Ratings out of 5 are rescaled to 0-10."""
    m = {}
    i = index_of(lines, lambda l: l == "Flex")
    if i is not None and i + 1 < len(lines):
        m["flex_text"] = lines[i + 1]
    v = next((l for l in lines if l.startswith("Flex rating:")), None)
    if v:
        n = nums(v)
        if n:
            # "Flex rating: 3/5" -> 6.0 (the denominator defaults to 5).
            m["flex"] = round(n[0] / (n[1] if len(n) > 1 else 5) * 10, 1)
    # "Camber - poppy and precise" -> "Camber"
    v = after(lines, lambda l: l == "Shape and Profile")
    if v:
        m["profile"] = re.split(r"\s+[-–]\s+", v)[0].strip()
    terr = {}
    for name, key in (("Resort", "all_mountain"), ("Pow", "powder"), ("Park", "park")):
        v = next((l for l in lines if l.startswith(name + " rating:")), None)
        if v:
            n = nums(v)
            if n:
                terr[key] = round(n[0] / (n[1] if len(n) > 1 else 5) * 10, 1)
    if terr:
        m["terrain"] = terr
    # The "Key Features" paragraphs (up to the Terrain ratings) describe the
    # shape in more detail than the short description, e.g. "pinched-in
    # swallow tail". Only used to detect the tail style; capped at 15 lines
    # so it can't run on into reviews if the Terrain heading is missing.
    k = index_of(lines, lambda l: l == "Key Features")
    if k is not None:
        end = index_of(lines, lambda l: l == "Terrain", k) or len(lines)
        m["features"] = " ".join(lines[k + 1:min(end, k + 16)])
    return m


# Brand key -> metadata parser.
META = {"burton": meta_burton, "jones": meta_jones, "nidecker": meta_nidecker}


def classify_shape(shape_raw, text, sizes):
    """Bucket a board into "Twin", "Directional Twin" or "Directional".

    Evidence is tried from strongest to weakest:
      1. the brand's own shape label (shape_raw)
      2. keywords in the name/description (`text`)
      3. the geometry of the middle size: taper of 5 mm or more means
         Directional; otherwise the nose-vs-tail length difference decides
      4. any mention of "twin", then a default of Directional
    """
    s = (shape_raw or "").lower()
    if "twin" in s and "directional" in s:
        return "Directional Twin"
    if "twin" in s:
        return "Twin"
    if any(k in s for k in ("directional", "tapered", "freeride", "fish", "pow")):
        return "Directional"
    t = text.lower()
    if "directional twin" in t:
        return "Directional Twin"
    if re.search(r"\btrue twin\b|\bsymmetrical twin\b", t):
        return "Twin"
    mid = sizes[len(sizes) // 2] if sizes else {}
    if mid.get("taper", 0) >= 5:
        return "Directional"
    if mid.get("nose_len") and mid.get("tail_len"):
        d = mid["nose_len"] - mid["tail_len"]  # mm the nose is longer by
        if d <= 2:
            return "Twin"
        return "Directional Twin" if d <= 25 else "Directional"
    if re.search(r"\btwin\b", t):
        return "Twin"
    return "Directional"


def classify_profile(p):
    """Map a brand's free-text profile name to one of the profile keys that
    assets/geometry.js knows how to draw:

      camber, camrock, directional_camrock, directional_camber,
      flat, directional_flat, rocker, hybrid_rocker

    Checks run from most to least specific; unknown or missing values fall
    back to "camber".
    """
    s = (p or "").lower()
    if not s:
        return "camber"
    if "flying v" in s or "hybrid rocker" in s or "rocker/camber/rocker" in s:
        return "hybrid_rocker"
    if "camrock" in s or "hybrid camber" in s or "rocker-camber-rocker" in s:
        return "directional_camrock" if "directional" in s else "camrock"
    if "directional" in s and ("camber" in s or "rocker" in s):
        return "directional_camber"
    if "flat" in s:
        return "directional_flat" if "directional" in s else "flat"
    if "rocker" in s and "camber" not in s:
        return "rocker"
    return "camber"


def detect_tail(text):
    """Spot unusual tail shapes from the name, description and any brand
    feature text: "swallow" (fish or split tail) or "blunt" (squash tail).
    None for a normal rounded tail.
    geometry.js uses this to pick how the tail tip is drawn."""
    t = text.lower()
    if re.search(r"swallow|fish ?tail|\bfish\b|split tail", t):
        return "swallow"
    if re.search(r"blunt(ed)? tail|squash|short, wide tail", t):
        return "blunt"
    return None


def clean_name(raw, brand_name):
    """Reduce a product title to the bare model name.

    e.g. "Men's Burton Custom Camber Snowboard 2026 | Burton" -> "Custom Camber"
    """
    n = raw.split("|")[0]  # drop the " | Site name" suffix
    n = re.sub(r"(?i)\b(men'?s|women'?s|unisex|kids'?)\s+", "", n)
    n = re.sub(r"(?i)\b%s\b\s*" % re.escape(brand_name), "", n)
    n = re.sub(r"(?i)\bsnowboard\b", "", n)
    n = re.sub(r"\b20\d\d(/\d\d)?\b", "", n)  # model year: 2026 or 2025/26
    n = re.sub(r"\s+", " ", n).strip(" -–")
    return n


def slugify(s):
    """Lowercase, hyphen-separated id fragment: "Mind Expander" -> "mind-expander"."""
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


# --------------------------------------------------------------------------
# Main scrape
# --------------------------------------------------------------------------
def collection_links(brand, cfg, gender, path, offline):
    """Collect product links from a brand's collection (listing) pages.

    Follows ?page=N pagination for up to 5 pages, and stops early when a
    page adds no new products or doesn't link to the next page. Returns
    site-relative hrefs such as "/en-us/products/mens-custom-snowboard".
    """
    links, seen = [], set()
    for page_no in range(1, 6):
        url = cfg["base"] + path + (f"?page={page_no}" if page_no > 1 else "")
        page = fetch(url, CACHE / brand / ("collection_" + cache_name(url)),
                     cfg["delay"], offline)
        if not page:
            break
        new = 0
        # Product links, optionally with a locale prefix like /en-us.
        for href in re.findall(r'href="((?:/[a-z]{2}(?:-[a-z]{2,3})?)?/products/[^"?#]+)', page):
            handle = href.rsplit("/", 1)[-1]
            if handle in seen or SKIP_HANDLE.search(handle):
                continue
            # Burton and Jones also list accessories in these collections;
            # their board handles always contain "snowboard".
            if brand in ("burton", "jones") and "snowboard" not in handle:
                continue
            seen.add(handle)
            links.append(href)
            new += 1
        if new == 0 or f"page={page_no + 1}" not in page:
            break
    log(f"  {brand}/{gender}: {len(links)} candidate products")
    return links


def scrape_product(brand, cfg, gender, href, offline):
    """Fetch one product page and parse it into a board record (or None)."""
    url = cfg["base"] + href
    page = fetch(url, CACHE / brand / cache_name(url), cfg["delay"], offline)
    if not page:
        return None
    return parse_product(brand, cfg, gender, url, page)


def detect_brand(page):
    """Work out which brand a saved product page belongs to (for --import-dir)."""
    # The page's own URL is in og:url or the canonical link.
    url = meta_content(page, "og:url")
    if not url:
        m = re.search(r'<link[^>]+rel="canonical"[^>]+href="([^"]+)"', page, re.I)
        url = m.group(1) if m else ""
    for key, cfg in BRANDS.items():
        host = cfg["base"].split("//", 1)[1].replace("www.", "")
        if host in url:
            return key, url
    return None, url


def parse_product(brand, cfg, gender, url, page):
    """Parse a product page into the board record written to boards.json.

    `gender` is the collection the link came from; it is switched to "women"
    if the product name says so. Returns None when the page has no usable
    size chart.
    """
    order, merged = parse_tables(page)
    sizes = build_sizes(order, merged)
    if not sizes:
        log(f"    no spec table: {url}")
        return None
    ld = jsonld_product(page)
    raw_name = ld.get("name") or meta_content(page, "og:title") or url
    name = clean_name(html.unescape(raw_name), cfg["name"])
    lname = raw_name.lower()
    if "women" in lname:
        gender = "women"
    desc = html.unescape(ld.get("description") or meta_content(page, "description") or "")
    lines = page_lines(page)
    meta = META[brand](lines)
    # Normalize the product image to an absolute https URL.
    image = meta_content(page, "og:image") or ""
    if image.startswith("//"):
        image = "https:" + image
    elif image.startswith("http://"):
        image = "https://" + image[len("http://"):]
    text_for_shape = " ".join([name, desc])
    board = {
        # Women's versions often share the model name, so they get a "-w"
        # suffix to keep ids unique.
        "id": f"{brand}-{slugify(name)}" + ("-w" if gender == "women" else ""),
        "brand": cfg["name"],
        "name": name,
        "gender": gender,
        # Saved Burton pages may come from another locale (/en-gb/); link
        # to the US store consistently.
        "url": re.sub(r"/en-[a-z]{2}/", "/en-us/", url) if brand == "burton" else url,
        "image": image,
        "description": desc[:400],
        "shape_raw": meta.get("shape"),
        "shape": classify_shape(meta.get("shape"), text_for_shape, sizes),
        "profile_raw": meta.get("profile"),
        "profile": classify_profile(meta.get("profile")),
        "flex": meta.get("flex"),
        "flex_text": meta.get("flex_text"),
        "flex_type": meta.get("flex_type"),
        "terrain": meta.get("terrain"),
        "level": meta.get("level"),
        # Brand feature text (if the meta parser found any) helps here
        # because tail shapes are often only mentioned there.
        "tail_style": detect_tail(" ".join([text_for_shape, meta.get("features", "")])),
        "popular": any(p in name.lower() for p in POPULAR[brand]),
        "sizes": sizes,
    }
    return board


def main():
    """Command-line entry point: scrape or import, merge, and write the data."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="parse cached HTML only")
    ap.add_argument("--brand", choices=list(BRANDS), action="append")
    ap.add_argument("--import-dir", type=pathlib.Path,
                    help="parse product pages saved locally (e.g. 'Save page as' "
                         "from your browser) instead of fetching; merges into "
                         "the existing data")
    args = ap.parse_args()
    # Brands to crawl this run. An import crawls none: it only adds/replaces
    # the boards found in the saved pages.
    brands = [] if args.import_dir else (args.brand or list(BRANDS))

    old_boards = (json.loads(OUT_JSON.read_text("utf-8"))["boards"]
                  if OUT_JSON.exists() else [])
    # keep existing boards from brands we're not re-scraping
    boards = [b for b in old_boards if b["brand"].lower() not in brands]
    seen = {b["id"] for b in boards}

    if args.import_dir:
        files = sorted(args.import_dir.glob("*.htm*"))
        log(f"== importing {len(files)} saved pages from {args.import_dir}")
        for f in files:
            page = f.read_text("utf-8", errors="replace")
            brand, url = detect_brand(page)
            if not brand:
                log(f"    ? can't tell which brand {f.name} is from - skipped")
                continue
            # Gender defaults to men; parse_product switches it to women if
            # the product name says so.
            b = parse_product(brand, BRANDS[brand], "men", url, page)
            if not b:
                continue
            # An imported page replaces any existing board with the same id.
            boards = [x for x in boards if x["id"] != b["id"]]
            boards.append(b)
            log(f"    + {b['brand']} {b['name']} ({b['gender']}, {len(b['sizes'])} sizes)")

    for brand in brands:
        cfg = BRANDS[brand]
        log(f"== {cfg['name']}")
        got = 0
        for gender, path in cfg["collections"]:
            for href in collection_links(brand, cfg, gender, path, args.offline):
                b = scrape_product(brand, cfg, gender, href, args.offline)
                # Unisex boards appear in both collections; keep the first.
                if not b or b["id"] in seen:
                    continue
                seen.add(b["id"])
                boards.append(b)
                got += 1
                log(f"    + {b['name']} ({b['gender']}, {len(b['sizes'])} sizes)")
        # If the site blocked us entirely, don't wipe that brand from the
        # data; carry over what the previous run found.
        if not got:
            keep = [b for b in old_boards if b["brand"].lower() == brand]
            if keep:
                log(f"  no {cfg['name']} boards scraped - keeping the {len(keep)} already in the data")
                boards += keep
                seen.update(b["id"] for b in keep)

    # manual corrections
    # overrides.json maps board id -> fields to overwrite (whole top-level
    # values are replaced, not deep-merged). Keys starting with "_" are notes.
    if OVERRIDES.exists():
        ov = json.loads(OVERRIDES.read_text("utf-8"))
        for b in boards:
            for k, v in ov.get(b["id"], {}).items():
                if not k.startswith("_"):
                    b[k] = v

    # By brand, then popular models first, then alphabetical.
    boards.sort(key=lambda b: (b["brand"], not b["popular"], b["name"]))
    out = {
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "units": {"lengths": "mm", "radius": "m", "weight": "kg"},
        "boards": boards,
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(out, indent=1, ensure_ascii=False), "utf-8")
    # The .js copy lets index.html load the data with a plain <script> tag,
    # which works from file:// where fetch() of a .json file would be blocked.
    OUT_JS.write_text("window.BOARD_DATA = " + json.dumps(out, ensure_ascii=False)
                      + ";\n", "utf-8")
    log(f"wrote {len(boards)} boards -> {OUT_JSON.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
