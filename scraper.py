import sys
import re
import requests
import pandas as pd
from pathlib import Path
from urllib.parse import urlparse

from strategies import shopify, generic, webflow
from utils.price import normalize_price


def _normalize_url(url: str) -> str:
    url = url.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    return url


def _resolve_url(url: str) -> str:
    """Follow redirects and return the final canonical URL."""
    try:
        resp = requests.head(url, allow_redirects=True, timeout=10)
        return resp.url
    except Exception:
        return url


def _detect_platform(url: str) -> tuple[str, str]:
    """Returns (platform, resolved_url)."""
    resolved = _resolve_url(url)

    # Fetch homepage once — used for both Shopify and Webflow detection
    try:
        resp = requests.get(resolved, timeout=15)
        html = resp.text

        # Shopify: check products.json endpoint
        pj = requests.get(f"{resolved}/products.json?limit=1", timeout=10)
        if pj.status_code == 200:
            try:
                data = pj.json()
                if "products" in data:
                    return "shopify", resolved
            except Exception:
                pass

        # Webflow: data-wf-domain attribute in HTML
        if "data-wf-domain" in html or "webflow" in html.lower():
            return "webflow", resolved

    except Exception:
        pass

    return "generic", resolved


def _site_name(url: str) -> str:
    host = urlparse(url).netloc or url
    host = re.sub(r'^www\.', '', host)
    return host.split(".")[0]


def run(url: str, output_path: str | None) -> None:
    url = _normalize_url(url)
    print(f"Target: {url}")
    print("Resolving URL and detecting platform...")

    platform, url = _detect_platform(url)
    print(f"Platform detected: {platform}")
    print(f"Resolved URL: {url}")
    print(f"Starting {platform} scrape...")

    if platform == "shopify":
        records = shopify.scrape(url)
    elif platform == "webflow":
        records = webflow.scrape(url)
    else:
        records = generic.scrape(url)

    if not records:
        print("No products found.", file=sys.stderr)
        sys.exit(1)

    raw = len(records)
    print(f"Collected {raw} raw records — cleaning...")

    df = pd.DataFrame(records)

    # Normalize any prices that came in as strings (generic strategy may return strings)
    if df["price"].dtype == object:
        df["price"] = df["price"].apply(lambda v: normalize_price(str(v)) if isinstance(v, str) else v)

    df = df.dropna(subset=["price"])
    after_price = len(df)
    if raw - after_price:
        print(f"Dropped {raw - after_price} rows with unparseable prices")

    df = df.drop_duplicates(subset=["name", "price"])
    dupes = after_price - len(df)
    if dupes:
        print(f"Removed {dupes} duplicate{'s' if dupes != 1 else ''}")

    df = df.sort_values("name").reset_index(drop=True)

    # Ensure consistent column order: name, url, price, category (if present)
    fixed = ["name", "url", "price"]
    cols = fixed + [c for c in df.columns if c not in fixed]
    df = df[cols]

    if output_path is None:
        output_path = f"output/{_site_name(url)}.csv"

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out, index=False)

    print(f"Done — {len(df)} products saved to {out}")
