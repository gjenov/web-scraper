"""
Blue Nile diamond search strategy using the internal GraphQL API.
API: POST https://www.bluenile.com/service-api/bn-product-api/diamond/v/2/
"""
import time
import re
import json
import hashlib
import os

import pandas as pd

try:
    from curl_cffi import requests as cffi_req
    _HAS_CFFI = True
except ImportError:
    import requests as cffi_req
    _HAS_CFFI = False

_UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
)

_API_URL = 'https://www.bluenile.com/service-api/bn-product-api/diamond/v/2/'

# ── Filter ID mappings (discovered via API introspection) ─────────────────

# color name → id (D best, M worst)
_COLOR_IDS = {'D': 1, 'E': 2, 'F': 3, 'G': 4, 'H': 5, 'I': 6, 'J': 7, 'K': 8, 'L': 12, 'M': 13}
# clarity name → id (FL best, I3 worst)
_CLARITY_IDS = {'FL': 1, 'IF': 2, 'VVS1': 3, 'VVS2': 4, 'VS1': 5, 'VS2': 6, 'SI1': 7, 'SI2': 8,
                'I1': 9, 'I2': 10, 'I3': 11}
# cut name → id
_CUT_IDS = {'Ideal': 1, 'Excellent': 2, 'Very Good': 3, 'Good': 4, 'Fair': 5}
# shape name → id
_SHAPE_IDS = {
    'Round': 1, 'Princess': 2, 'Radiant': 3, 'Emerald': 4, 'Marquise': 5,
    'Oval': 6, 'Pear': 7, 'Heart': 8, 'Asscher': 9, 'Cushion': 33,
}

_EMPTY_COLS = [
    'shape', 'carat', 'color', 'clarity', 'cut', 'polish', 'symmetry',
    'fluorescence', 'cert_type', 'cert_number', 'natural_or_lab',
    'price', 'stock_id', 'url',
]

# The full searchByIDs GraphQL query (extracted from Blue Nile JS bundle)
_GQL_QUERY = (
    'query ('
    '$currency: currencies, $sort: sortBy, $page: pager, '
    '$carat: floatRange, $color: intRange, $cut: intRange, '
    '$shapeID: [Int], $clarity: intRange, '
    '$isLabDiamond: Boolean, $price: intRange'
    ') {\n'
    '    searchByIDs('
    'currency: $currency, sort: $sort, page: $page, '
    'carat: $carat, color: $color, cut: $cut, '
    'shapeID: $shapeID, clarity: $clarity, '
    'isLabDiamond: $isLabDiamond, price: $price'
    ') {\n'
    '        hits total numberOfPages pageNumber\n'
    '        items {\n'
    '            productID price url\n'
    '            stone {\n'
    '                carat\n'
    '                color { name id }\n'
    '                clarity { name id }\n'
    '                cut { name id }\n'
    '                shape { name id }\n'
    '                isLabDiamond\n'
    '                certNumber\n'
    '                polish { name }\n'
    '                symmetry { name }\n'
    '                flour { name }\n'
    '                lab { name }\n'
    '            }\n'
    '        }\n'
    '    }\n'
    '}'
)


# ── Variable builder ──────────────────────────────────────────────────────

def _names_to_id_range(names_input, id_map):
    """
    Convert filter names (list or comma-separated string) to a GraphQL intRange.
    E.g. ['G','H','I'] or 'G,H,I' with _COLOR_IDS → {from: 4, to: 6}
    Returns None if no valid IDs found.
    """
    if not names_input:
        return None
    if isinstance(names_input, list):
        # Each element may itself be comma-separated
        names = []
        for item in names_input:
            names.extend(n.strip() for n in str(item).split(',') if n.strip())
    else:
        names = [n.strip() for n in str(names_input).split(',') if n.strip()]
    ids = [id_map[n] for n in names if n in id_map]
    if not ids:
        return None
    return {'from': min(ids), 'to': max(ids)}


def _build_variables(params, diamond_type, page_num, page_size):
    v = {
        'currency': 'USD',
        'page': {'number': page_num, 'size': page_size},
        'isLabDiamond': diamond_type == 'lab',
    }

    # Carat range
    cf = params.get('carat_from')
    ct = params.get('carat_to')
    if cf or ct:
        v['carat'] = {
            'from': float(cf) if cf else 0.1,
            'to':   float(ct) if ct else 30.0,
        }

    # Price range
    pf = params.get('price_from')
    pt = params.get('price_to')
    if pf or pt:
        v['price'] = {
            'from': int(pf) if pf else 0,
            'to':   int(pt) if pt else 999999,
        }

    # Color
    color_rng = _names_to_id_range(params.get('color', ''), _COLOR_IDS)
    if color_rng:
        v['color'] = color_rng

    # Clarity
    clarity_rng = _names_to_id_range(params.get('clarity', ''), _CLARITY_IDS)
    if clarity_rng:
        v['clarity'] = clarity_rng

    # Cut
    cut_rng = _names_to_id_range(params.get('cut', ''), _CUT_IDS)
    if cut_rng:
        v['cut'] = cut_rng

    # Shape
    shape_input = params.get('shape', '')
    if shape_input:
        if isinstance(shape_input, list):
            raw_shapes = []
            for item in shape_input:
                raw_shapes.extend(s.strip() for s in str(item).split(',') if s.strip())
        else:
            raw_shapes = [s.strip() for s in str(shape_input).split(',') if s.strip()]
        shape_ids = [_SHAPE_IDS[s] for s in raw_shapes if s in _SHAPE_IDS]
        if shape_ids:
            v['shapeID'] = shape_ids

    return v


# ── Item extractor ────────────────────────────────────────────────────────

def _flatten_items(raw_items):
    """
    The API returns items as a list of 10 parallel sub-lists.
    Flatten and deduplicate by productID.
    """
    seen = set()
    out = []
    for group in raw_items:
        if not isinstance(group, list):
            group = [group]
        for item in group:
            if not item or not isinstance(item, dict):
                continue
            pid = item.get('productID')
            if pid and pid not in seen:
                seen.add(pid)
                out.append(item)
    return out


def _extract_row(item, diamond_type):
    stone = item.get('stone') or {}
    raw_url = item.get('url', '')
    if raw_url and not raw_url.startswith('http'):
        full_url = f'https://www.bluenile.com/{raw_url}'
    else:
        full_url = raw_url

    shape_raw = (stone.get('shape') or {}).get('name', '')
    return {
        'shape':          shape_raw.title() if shape_raw else '',
        'carat':          stone.get('carat', ''),
        'color':          (stone.get('color') or {}).get('name', ''),
        'clarity':        (stone.get('clarity') or {}).get('name', ''),
        'cut':            (stone.get('cut') or {}).get('name', ''),
        'polish':         (stone.get('polish') or {}).get('name', ''),
        'symmetry':       (stone.get('symmetry') or {}).get('name', ''),
        'fluorescence':   (stone.get('flour') or {}).get('name', ''),
        'cert_type':      (stone.get('lab') or {}).get('name', ''),
        'cert_number':    stone.get('certNumber', ''),
        'natural_or_lab': 'lab' if stone.get('isLabDiamond') else 'natural',
        'price':          item.get('price', ''),
        'stock_id':       str(item.get('productID', '')),
        'url':            full_url,
    }


# ── Public entry point ────────────────────────────────────────────────────

def scrape(params: dict) -> pd.DataFrame:
    diamond_type = params.get('diamond_type', 'natural')

    print(f'Blue Nile: {diamond_type} diamond search via GraphQL API', flush=True)

    # Build curl-cffi session
    if _HAS_CFFI:
        session = cffi_req.Session(impersonate='chrome124')
    else:
        session = cffi_req.Session()

    req_headers = {
        'User-Agent':      _UA,
        'Accept':          'application/json, */*',
        'Content-Type':    'application/json',
        'Referer':         'https://www.bluenile.com/diamonds',
        'Origin':          'https://www.bluenile.com',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
    }

    # Warm up session on homepage (sets cookies, looks natural)
    print('Warming session on homepage...', flush=True)
    try:
        session.get(
            'https://www.bluenile.com/',
            headers={**req_headers, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8'},
            timeout=20,
        )
        time.sleep(0.8)
    except Exception as e:
        print(f'Warm-up: {e}', flush=True)

    # Page size: 25 items × 10 buckets = 250 unique per request
    # Use 25 to avoid giant payloads while still being efficient
    PAGE_SIZE = 25
    MAX_PAGES = params.get('max_pages', 200)  # Safety cap

    all_diamonds = {}  # productID → row dict

    for page_num in range(1, MAX_PAGES + 1):
        variables = _build_variables(params, diamond_type, page_num, PAGE_SIZE)
        try:
            resp = session.post(
                _API_URL,
                json={'query': _GQL_QUERY, 'variables': variables},
                headers=req_headers,
                timeout=20,
            )
        except Exception as e:
            print(f'Request error (page {page_num}): {e}', flush=True)
            break

        if resp.status_code != 200:
            print(f'API error {resp.status_code}: {resp.text[:200]}', flush=True)
            break

        try:
            body = resp.json()
        except Exception as e:
            print(f'JSON decode error: {e}', flush=True)
            break

        errors = body.get('errors')
        if errors:
            print(f'GraphQL errors: {errors}', flush=True)
            break

        result = (body.get('data') or {}).get('searchByIDs') or {}
        hits         = result.get('hits', 0)
        total_pages  = result.get('numberOfPages', 1)
        raw_items    = result.get('items', [])

        if page_num == 1:
            print(f'Total matching diamonds: {hits:,}', flush=True)

        new_items = _flatten_items(raw_items)
        added = 0
        for item in new_items:
            pid = item.get('productID')
            if pid and pid not in all_diamonds:
                all_diamonds[pid] = _extract_row(item, diamond_type)
                added += 1

        print(
            f'Page {page_num}/{total_pages}: +{added} new  '
            f'(total collected: {len(all_diamonds):,})',
            flush=True,
        )

        # Stop if we have all unique diamonds from filters
        if len(all_diamonds) >= hits or page_num >= total_pages:
            break

        time.sleep(0.3)

    rows = list(all_diamonds.values())
    if not rows:
        print('No diamonds found.', flush=True)
        return pd.DataFrame(columns=_EMPTY_COLS)

    df = pd.DataFrame(rows)
    df['price'] = pd.to_numeric(df['price'], errors='coerce')
    df['carat'] = pd.to_numeric(df['carat'], errors='coerce')

    print(f'Done — {len(df):,} diamonds', flush=True)
    return df


# ── Batch / full-catalog helpers ──────────────────────────────────────

BUCKET_CAP = 750   # max hits per bucket before splitting
MAX_DEPTH  = 15    # at depth 15 the range is ~$15 — treat as atomic

_COUNT_QUERY = (
    'query ('
    '$currency: currencies, $sort: sortBy, $page: pager, '
    '$carat: floatRange, $color: intRange, $cut: intRange, '
    '$shapeID: [Int], $clarity: intRange, '
    '$isLabDiamond: Boolean, $price: intRange'
    ') {\n'
    '    searchByIDs('
    'currency: $currency, sort: $sort, page: $page, '
    'carat: $carat, color: $color, cut: $cut, '
    'shapeID: $shapeID, clarity: $clarity, '
    'isLabDiamond: $isLabDiamond, price: $price'
    ') {\n'
    '        hits\n'
    '    }\n'
    '}'
)


def _run_id(params: dict) -> str:
    clean = {k: v for k, v in sorted(params.items()) if v not in (None, [], '')}
    return hashlib.md5(json.dumps(clean, sort_keys=True).encode()).hexdigest()[:12]


def _probe_count(session, req_headers, params, diamond_type, price_from, price_to) -> int:
    probe_params = dict(params)
    probe_params['price_from'] = price_from
    probe_params['price_to']   = price_to
    variables = _build_variables(probe_params, diamond_type, 1, 1)
    try:
        resp = session.post(
            _API_URL,
            json={'query': _COUNT_QUERY, 'variables': variables},
            headers=req_headers,
            timeout=20,
        )
        if resp.status_code != 200:
            return 0
        body = resp.json()
        result = (body.get('data') or {}).get('searchByIDs') or {}
        return int(result.get('hits', 0))
    except Exception:
        return 0
    finally:
        time.sleep(0.15)


def _discover_buckets(session, req_headers, params, diamond_type, lo, hi, depth=0):
    hits = _probe_count(session, req_headers, params, diamond_type, lo, hi)
    print(f'[probe] ${lo:,}–${hi:,} → {hits:,} hits  (depth {depth})', flush=True)
    if hits <= BUCKET_CAP or depth >= MAX_DEPTH or lo == hi:
        return [(lo, hi)]
    mid = (lo + hi) // 2
    left  = _discover_buckets(session, req_headers, params, diamond_type, lo,     mid,    depth + 1)
    right = _discover_buckets(session, req_headers, params, diamond_type, mid + 1, hi,    depth + 1)
    return left + right


def scrape_all(params: dict, output_path: str, resume: bool = False) -> pd.DataFrame:
    diamond_type = params.get('diamond_type', 'natural')

    output_dir = os.path.dirname(os.path.abspath(output_path))
    run_id     = _run_id(params)
    state_path  = os.path.join(output_dir, f'.batch_{run_id}.state.json')
    partial_path = os.path.join(output_dir, f'.batch_{run_id}_partial.csv')

    if _HAS_CFFI:
        session = cffi_req.Session(impersonate='chrome124')
    else:
        session = cffi_req.Session()

    req_headers = {
        'User-Agent':      _UA,
        'Accept':          'application/json, */*',
        'Content-Type':    'application/json',
        'Referer':         'https://www.bluenile.com/diamonds',
        'Origin':          'https://www.bluenile.com',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
    }

    # ── Load or discover buckets ──────────────────────────────────────
    if resume and os.path.exists(state_path):
        with open(state_path) as f:
            state = json.load(f)
        buckets   = [tuple(b) for b in state['buckets']]
        completed = set(state.get('completed', []))
        seen_ids  = set(state.get('diamonds_seen', []))
        print(f'Resuming — {len(completed)}/{len(buckets)} buckets done  ({len(seen_ids):,} diamonds collected)', flush=True)
    else:
        print('Warming session on homepage...', flush=True)
        try:
            session.get(
                'https://www.bluenile.com/',
                headers={**req_headers, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8'},
                timeout=20,
            )
            time.sleep(0.8)
        except Exception as e:
            print(f'Warm-up: {e}', flush=True)

        print('Discovering price buckets ($0 – $500,000)...', flush=True)
        buckets  = _discover_buckets(session, req_headers, params, diamond_type, 0, 500_000)
        print(f'Discovery complete — {len(buckets)} buckets found', flush=True)

        completed = set()
        seen_ids  = set()

        # Remove stale partial if any
        if os.path.exists(partial_path):
            os.remove(partial_path)

        os.makedirs(output_dir, exist_ok=True)
        with open(state_path, 'w') as f:
            json.dump({
                'run_id':        run_id,
                'buckets':       buckets,
                'completed':     [],
                'diamonds_seen': [],
            }, f)

    # ── Fetch each bucket ─────────────────────────────────────────────
    total = len(buckets)
    for idx, (lo, hi) in enumerate(buckets):
        if idx in completed:
            continue

        print(f'\n── Bucket {idx + 1}/{total}: ${lo:,}–${hi:,} ──', flush=True)
        bucket_params = dict(params)
        bucket_params['price_from'] = lo
        bucket_params['price_to']   = hi

        df_bucket = scrape(bucket_params)

        if not df_bucket.empty:
            new_rows = df_bucket[~df_bucket['stock_id'].isin(seen_ids)]
            if not new_rows.empty:
                write_header = not os.path.exists(partial_path)
                new_rows.to_csv(partial_path, mode='a', header=write_header, index=False)
                seen_ids.update(new_rows['stock_id'].astype(str).tolist())

        completed.add(idx)
        with open(state_path, 'w') as f:
            json.dump({
                'run_id':        run_id,
                'buckets':       buckets,
                'completed':     list(completed),
                'diamonds_seen': list(seen_ids),
            }, f)

        print(f'BATCH:{idx + 1}/{total} — {len(seen_ids):,} diamonds collected', flush=True)

    # ── Merge, deduplicate, save ──────────────────────────────────────
    if not os.path.exists(partial_path):
        print('No diamonds found.', flush=True)
        return pd.DataFrame(columns=_EMPTY_COLS)

    df_final = pd.read_csv(partial_path)
    df_final = df_final.drop_duplicates(subset=['stock_id'])
    df_final['price'] = pd.to_numeric(df_final['price'], errors='coerce')
    df_final['carat'] = pd.to_numeric(df_final['carat'], errors='coerce')

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    df_final.to_csv(output_path, index=False)

    os.remove(partial_path)
    os.remove(state_path)

    print(f'Done — {len(df_final):,} diamonds saved', flush=True)
    return df_final
