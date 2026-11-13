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

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / "scraper" / "cache"
OUT_JSON = ROOT / "data" / "boards.json"
OUT_JS = ROOT / "data" / "boards.js"
OVERRIDES = ROOT / "scraper" / "overrides.json"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")

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
    print(*a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# Fetching (polite, cached, honours Retry-After)
# --------------------------------------------------------------------------
def _fetch_curl(url):
    hdr = CACHE / "_hdr.txt"
    hdr.parent.mkdir(parents=True, exist_ok=True)
    p = subprocess.run(
        ["curl", "-s", "-L", "--compressed", "-A", UA,
         "-H", "Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
         "-H", "Accept-Language: en-US,en;q=0.9",
         "-D", str(hdr), "-w", "\n__STATUS__%{http_code}", url],
        capture_output=True, timeout=60)
    out = p.stdout.decode("utf-8", "replace")
    body, _, status = out.rpartition("\n__STATUS__")
    retry = None
    try:
        m = re.findall(r"(?im)^retry-after:\s*(\d+)", hdr.read_text("latin-1"))
        retry = int(m[-1]) if m else None
    except OSError:
        pass
    return int(status or 0), body, retry


def _fetch_urllib(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode("utf-8", "replace"), None
    except urllib.error.HTTPError as e:
        ra = e.headers.get("Retry-After")
        return e.code, "", int(ra) if ra and ra.isdigit() else None


_last_hit = {}
_refused = set()  # hosts that keep refusing us this run


def fetch(url, cache_file, delay, offline=False):
    if cache_file.exists():
        return cache_file.read_text("utf-8")
    if offline:
        return None
    host = url.split("/")[2]
    if host in _refused:
        return None
    wait = _last_hit.get(host, 0) + delay - time.time()
    if wait > 0:
        time.sleep(wait + random.uniform(0, delay * 0.3))
    getter = _fetch_curl if shutil.which("curl") else _fetch_urllib
    for attempt in range(3):
        status, body, retry = getter(url)
        _last_hit[host] = time.time()
        if status == 200 and len(body) > 5000:
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(body, "utf-8")
            return body
        if status == 404:
            log(f"  404 {url}")
            return None
        if attempt < 2:
            backoff = max(retry or 60, 60) * (attempt + 1)
            log(f"  HTTP {status} on {url} -> waiting {backoff}s")
            time.sleep(backoff)
    _refused.add(host)
    log(f"  {host} is refusing requests (HTTP {status}); skipping it for this run.\n"
        f"  Try again later, or save the product pages from your browser and run\n"
        f"  `python scraper/scrape.py --import-dir <folder>`.")
    return None


def cache_name(url):
    path = url.split("://", 1)[1].split("/", 1)[1]
    return re.sub(r"[^a-zA-Z0-9]+", "_", path).strip("_")[:150] + ".html"


# --------------------------------------------------------------------------
# HTML helpers
# --------------------------------------------------------------------------
def strip_tags(s):
    s = re.sub(r"<br\s*/?>", " ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def page_lines(page):
    s = re.sub(r"<(script|style|svg|noscript)\b.*?</\1>", "", page,
               flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", "\n", s)
    return [re.sub(r"\s+", " ", html.unescape(l)).strip()
            for l in s.split("\n") if l.strip()]


def meta_content(page, prop):
    m = re.search(r'<meta[^>]+(?:property|name)="%s"[^>]+content="([^"]*)"'
                  % re.escape(prop), page, re.I)
    if not m:
        m = re.search(r'<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="%s"'
                      % re.escape(prop), page, re.I)
    return html.unescape(m.group(1)).strip() if m else None


def jsonld_product(page):
    for blk in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>',
                          page, re.S | re.I):
        try:
            data = json.loads(blk)
        except ValueError:
            continue
        items = data if isinstance(data, list) else [data]
        for it in items:
            if isinstance(it, dict) and it.get("@type") == "Product":
                return it
    return {}


def parse_tables(page):
    """Merge every size-chart table on the page into {label: {size: value}}."""
    order, merged = [], {}
    for t in re.findall(r"<table\b.*?</table>", page, re.S | re.I):
        rows = re.findall(r"<tr\b[^>]*>(.*?)</tr>", t, re.S | re.I)
        grid = [[strip_tags(c) for c in
                 re.findall(r"<t[hd]\b[^>]*>(.*?)</t[hd]>", r, re.S | re.I)]
                for r in rows]
        grid = [g for g in grid if g]
        if not grid or len(grid[0]) < 2:
            continue
        head = grid[0]
        if not re.search(r"size", head[0], re.I):
            continue
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
LENGTH_KEYS = {"length", "nose_len", "tail_len", "contact", "eff_edge", "waist",
               "underfoot_front", "underfoot_rear", "nose_w", "tail_w",
               "sidecut_depth", "taper", "setback", "ref_stance"}
# Unit assumed when neither the cell nor the row label states one
DEFAULT_UNIT = {"setback": "mm", "taper": "mm", "sidecut_depth": "mm"}
SCALE = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4}

NUM_RE = re.compile(r"-?\d+(?:[.,]\d+)?")


def nums(v):
    return [float(x.replace(",", ".")) for x in NUM_RE.findall(v)]


def unit_of(value, label):
    m = re.search(r"\d\s*(mm|cm|m|in)\b", value.lower())
    if m:
        return m.group(1)
    m = re.search(r"\((mm|cm|m)\b", label.lower())
    return m.group(1) if m else None


def to_mm(key, value, label):
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
    v = value.lower().replace("–", "-")
    parts = v.split("/")
    kg_part = next((p for p in parts if "kg" in p), None)
    factor = 1.0
    if kg_part is None:
        if "kg" in label.lower() and "lb" not in label.lower():
            kg_part = v
        elif "lb" in v or "lb" in label.lower():
            kg_part, factor = parts[0], 0.4536
        else:
            kg_part = v
    n = [abs(x) * factor for x in nums(kg_part)]  # "54-82" -> 54, 82
    if not n:
        return None
    lo = round(n[0])
    hi = round(n[1]) if len(n) > 1 else None
    return [lo, hi]


def size_number(label):
    m = re.match(r"(\d{3})", label)
    return int(m.group(1)) if m else None


def build_sizes(order, merged):
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
            if raw is None or not raw.strip() or raw.strip() in ("-", "–"):
                continue
            if key in LENGTH_KEYS:
                val = to_mm(key, raw, label)
                if val is not None:
                    rec[key] = abs(val) if key == "setback" else val
            elif key == "radius":
                n = nums(raw)
                if n:
                    if unit_of(raw, label) == "mm" or n[0] > 100:
                        n = [x / 1000 for x in n]
                    rec["radius"] = round(sum(n) / len(n), 2)
                    if len(n) > 1:
                        rec["radius_raw"] = raw
            elif key == "weight":
                w = parse_weight(raw, label)
                if w:
                    rec["weight_kg"] = w
            elif key == "weight_lbs":
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
def after(lines, pred, start=0, stop=None, offset=1):
    stop = len(lines) if stop is None else min(stop, len(lines))
    for i in range(start, stop):
        if pred(lines[i]):
            j = i + offset
            return lines[j] if j < len(lines) else None
    return None


def index_of(lines, pred, start=0):
    for i in range(start, len(lines)):
        if pred(lines[i]):
            return i
    return None


def meta_burton(lines):
    m = {}
    i = index_of(lines, lambda l: l == "Tech Specs")
    if i is not None:
        for key, out in (("Bend", "profile"), ("Shape", "shape"),
                         ("Flex", "flex_type")):
            v = after(lines, lambda l, k=key: l == k, i, i + 30)
            if v:
                m[out] = v
    p = index_of(lines, lambda l: l == "Personality")
    if p is not None and p + 1 < len(lines) and lines[p + 1].startswith("("):
        pers = lines[p + 1].strip("() ")
        m["flex_text"] = pers
        cats = {"soft": 3, "medium": 5.5, "stiff": 8}
        hits = [v for k, v in cats.items() if k in pers.lower()]
        if hits:
            m["flex"] = round(sum(hits) / len(hits), 1)
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
    r = index_of(lines, lambda l: l == "Riding Level")
    if r is not None:
        lv = [l for l in lines[r + 1:r + 6] if l in ("Beginner", "Intermediate", "Expert")]
        if lv:
            m["level"] = lv
    return m


def meta_jones(lines):
    m = {}
    v = after(lines, lambda l: l == "[Shape]")
    if v:
        m["shape"] = v
    v = after(lines, lambda l: re.fullmatch(r"\[Pr[o0]file\]", l) is not None)
    if v:
        m["profile"] = v
    i = index_of(lines, lambda l: l == "Personality/Flex")
    if i is not None:
        m["flex_text"] = lines[i + 1]
        n = nums(lines[i + 2]) if i + 2 < len(lines) else []
        if n:
            m["flex"] = n[0]
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
    m = {}
    i = index_of(lines, lambda l: l == "Flex")
    if i is not None and i + 1 < len(lines):
        m["flex_text"] = lines[i + 1]
    v = next((l for l in lines if l.startswith("Flex rating:")), None)
    if v:
        n = nums(v)
        if n:
            m["flex"] = round(n[0] / (n[1] if len(n) > 1 else 5) * 10, 1)
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
    return m


META = {"burton": meta_burton, "jones": meta_jones, "nidecker": meta_nidecker}


def classify_shape(shape_raw, text, sizes):
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
        d = mid["nose_len"] - mid["tail_len"]
        if d <= 2:
            return "Twin"
        return "Directional Twin" if d <= 25 else "Directional"
    if re.search(r"\btwin\b", t):
        return "Twin"
    return "Directional"


def classify_profile(p):
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
    t = text.lower()
    if re.search(r"swallow|fish ?tail|\bfish\b|split tail", t):
        return "swallow"
    if re.search(r"blunt(ed)? tail|squash|short, wide tail", t):
        return "blunt"
    return None


def clean_name(raw, brand_name):
    n = raw.split("|")[0]
    n = re.sub(r"(?i)\b(men'?s|women'?s|unisex|kids'?)\s+", "", n)
    n = re.sub(r"(?i)\b%s\b\s*" % re.escape(brand_name), "", n)
    n = re.sub(r"(?i)\bsnowboard\b", "", n)
    n = re.sub(r"\b20\d\d(/\d\d)?\b", "", n)
    n = re.sub(r"\s+", " ", n).strip(" -–")
    return n


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


# --------------------------------------------------------------------------
# Main scrape
# --------------------------------------------------------------------------
def collection_links(brand, cfg, gender, path, offline):
    links, seen = [], set()
    for page_no in range(1, 6):
        url = cfg["base"] + path + (f"?page={page_no}" if page_no > 1 else "")
        page = fetch(url, CACHE / brand / ("collection_" + cache_name(url)),
                     cfg["delay"], offline)
        if not page:
            break
        new = 0
        for href in re.findall(r'href="((?:/[a-z]{2}(?:-[a-z]{2,3})?)?/products/[^"?#]+)', page):
            handle = href.rsplit("/", 1)[-1]
            if handle in seen or SKIP_HANDLE.search(handle):
                continue
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
    url = cfg["base"] + href
    page = fetch(url, CACHE / brand / cache_name(url), cfg["delay"], offline)
    if not page:
        return None
    return parse_product(brand, cfg, gender, url, page)


def detect_brand(page):
    """Work out which brand a saved product page belongs to (for --import-dir)."""
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
    order, merged = parse_tables(page)
    sizes = build_sizes(order, merged)
    if not sizes:
        log(f"    no spec table: {url}")
        return None
    ld = jsonld_product(page)
    raw_name = ld.get("name") or meta_content(page, "og:title") or href
    name = clean_name(html.unescape(raw_name), cfg["name"])
    lname = raw_name.lower()
    if "women" in lname:
        gender = "women"
    desc = html.unescape(ld.get("description") or meta_content(page, "description") or "")
    lines = page_lines(page)
    meta = META[brand](lines)
    image = meta_content(page, "og:image") or ""
    if image.startswith("//"):
        image = "https:" + image
    elif image.startswith("http://"):
        image = "https://" + image[len("http://"):]
    text_for_shape = " ".join([name, desc])
    board = {
        "id": f"{brand}-{slugify(name)}" + ("-w" if gender == "women" else ""),
        "brand": cfg["name"],
        "name": name,
        "gender": gender,
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
        "tail_style": detect_tail(text_for_shape),
        "popular": any(p in name.lower() for p in POPULAR[brand]),
        "sizes": sizes,
    }
    return board


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="parse cached HTML only")
    ap.add_argument("--brand", choices=list(BRANDS), action="append")
    ap.add_argument("--import-dir", type=pathlib.Path,
                    help="parse product pages saved locally (e.g. 'Save page as' "
                         "from your browser) instead of fetching; merges into "
                         "the existing data")
    args = ap.parse_args()
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
            b = parse_product(brand, BRANDS[brand], "men", url, page)
            if not b:
                continue
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
                if not b or b["id"] in seen:
                    continue
                seen.add(b["id"])
                boards.append(b)
                got += 1
                log(f"    + {b['name']} ({b['gender']}, {len(b['sizes'])} sizes)")
        if not got:
            keep = [b for b in old_boards if b["brand"].lower() == brand]
            if keep:
                log(f"  no {cfg['name']} boards scraped - keeping the {len(keep)} already in the data")
                boards += keep
                seen.update(b["id"] for b in keep)

    # manual corrections
    if OVERRIDES.exists():
        ov = json.loads(OVERRIDES.read_text("utf-8"))
        for b in boards:
            for k, v in ov.get(b["id"], {}).items():
                if not k.startswith("_"):
                    b[k] = v

    boards.sort(key=lambda b: (b["brand"], not b["popular"], b["name"]))
    out = {
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "units": {"lengths": "mm", "radius": "m", "weight": "kg"},
        "boards": boards,
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(out, indent=1, ensure_ascii=False), "utf-8")
    OUT_JS.write_text("window.BOARD_DATA = " + json.dumps(out, ensure_ascii=False)
                      + ";\n", "utf-8")
    log(f"wrote {len(boards)} boards -> {OUT_JSON.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
