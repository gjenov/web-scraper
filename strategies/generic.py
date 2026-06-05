import re
import json
import asyncio
from urllib.parse import urlparse
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright

from utils.price import normalize_price


# ── URL / name helpers ─────────────────────────────────────────────

def _make_absolute(href: str, base_url: str) -> str:
    if not href:
        return ""
    if href.startswith("http"):
        return href
    if href.startswith("/"):
        p = urlparse(base_url)
        return f"{p.scheme}://{p.netloc}{href}"
    return ""


def _find_url(card, base_url: str) -> str:
    link = card.select_one("a[href]")
    if not link:
        return ""
    return _make_absolute(link.get("href", ""), base_url)


# ── Junk filters ───────────────────────────────────────────────────

_JUNK_NAME_RE = re.compile(
    r'\b(checkout|shopping cart|have a question|use code|ends soon|'
    r'gifts? under|under\s*\$?\d|free shipping|purchase over|subscribe|newsletter|'
    r'sign up|log in|sign in|my account|view all|see all|load more|'
    r'add to cart|add to bag|sold out|out of stock|wishlist|'
    r'sweepstakes|gift card|promo code|discount|coupon)\b',
    re.IGNORECASE,
)

_JUNK_URL_RE = re.compile(
    r'/(cart|checkout|promo-codes?|gifts?/under|subscribe|account|login|'
    r'wishlist|compare|faq|contact|about|blog|shipping|returns|offers?)(/|$)',
    re.IGNORECASE,
)


def _is_valid_product(name: str, price: float, url: str = "") -> bool:
    if price <= 0:
        return False
    if not name or len(name) > 150:
        return False
    # Catch UI text like "...Details", "...more", "...See All"
    if name.startswith("...") or name.startswith("…"):
        return False
    if _JUNK_NAME_RE.search(name):
        return False
    if url and _JUNK_URL_RE.search(url):
        return False
    return True


# ── JSON-LD extraction (highest fidelity) ─────────────────────────

def _extract_json_ld(soup: BeautifulSoup, base_url: str) -> list[dict]:
    results = []
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "")
        except (json.JSONDecodeError, TypeError):
            continue

        candidates = []
        if isinstance(data, list):
            candidates = data
        elif isinstance(data, dict):
            t = data.get("@type", "")
            if t == "ItemList":
                candidates = [e.get("item", e) for e in data.get("itemListElement", [])]
            else:
                candidates = [data]

        for item in candidates:
            if not isinstance(item, dict):
                continue
            if item.get("@type") not in ("Product", "IndividualProduct"):
                continue

            name = item.get("name", "").strip()
            if not name:
                continue

            offers = item.get("offers") or {}
            if isinstance(offers, list):
                offers = offers[0] if offers else {}

            price_raw = offers.get("price") or offers.get("lowPrice") or item.get("price")
            try:
                price = float(str(price_raw).replace(",", ""))
            except (TypeError, ValueError):
                continue

            url = item.get("url", "") or offers.get("url", "")
            if url and not url.startswith("http"):
                url = _make_absolute(url, base_url)

            if _is_valid_product(name, price, url):
                results.append({"name": name, "price": price, "url": url})

    return results


# ── data-* attribute JSON extraction ──────────────────────────────
# Some sites (e.g. BrilliantEarth) embed full product data as JSON
# in data-center / data-product / data-item attributes.

_DATA_ATTRS = ["data-center", "data-product", "data-item", "data-product-json"]


def _extract_from_data_attrs(soup: BeautifulSoup, base_url: str) -> list[dict]:
    results = []
    seen = set()
    for attr in _DATA_ATTRS:
        for el in soup.find_all(attrs={attr: True}):
            raw = el.get(attr, "")
            if not raw or raw in seen:
                continue
            seen.add(raw)
            try:
                data = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(data, dict):
                continue

            name = (data.get("title") or data.get("name") or "").strip()
            price_raw = data.get("price")
            if not name or price_raw is None:
                continue
            try:
                price = float(price_raw)
            except (TypeError, ValueError):
                continue

            url = data.get("url", "")
            if url and not url.startswith("http"):
                url = _make_absolute(url, base_url)

            if _is_valid_product(name, price, url):
                results.append({"name": name, "price": price, "url": url})
    return results


# ── CSS-based extraction ───────────────────────────────────────────

_PRICE_RE = re.compile(
    r'[\$£€][\d,]+(?:\.\d{2})?|\d+(?:,\d{3})*(?:\.\d{2})?\s*(?:AUD|USD|NZD|GBP|EUR)',
    re.IGNORECASE,
)

_NEXT_PAGE_TEXTS = re.compile(r'next|›|»|load more', re.IGNORECASE)

_PRODUCT_SELECTORS = [
    "li.product",
    "div.product",
    ".product-item",
    ".product-card",
    ".product-tile",
    ".prod-item",
    ".product__item",
    "[data-product-id]",
    "[data-product]",
    ".grid-item",
    ".collection-item",
    "article.product",
    "[class*='ProductCard']",
    "[class*='product-card']",
    "[class*='ProductItem']",
    "[class*='product-tile']",
    "[class*='per-product']",
]

_TITLE_SELECTORS = ["h2", "h3", "h4", ".product-title", ".product-name", ".item-title", "a"]
_PRICE_SELECTORS = [".price", ".product-price", ".amount", "span.money", "[class*='price']"]


def _find_title(card) -> str | None:
    for sel in _TITLE_SELECTORS:
        el = card.select_one(sel)
        if el:
            text = el.get_text(strip=True)
            if text:
                return text
    return None


def _find_price_text(card) -> str | None:
    for sel in _PRICE_SELECTORS:
        el = card.select_one(sel)
        if el:
            text = el.get_text(strip=True)
            if text:
                return text
    match = _PRICE_RE.search(card.get_text())
    return match.group(0) if match else None


def _extract_from_soup(soup: BeautifulSoup, base_url: str = "") -> list[dict]:
    # 1. JSON-LD structured data — most reliable
    print("  Trying JSON-LD structured data...")
    results = _extract_json_ld(soup, base_url)
    if results:
        print(f"  JSON-LD: {len(results)} products found")
        return results
    print("  JSON-LD: no products found")

    # 2. data-* attribute JSON (e.g. data-center, data-product)
    print("  Trying data-attribute JSON...")
    results = _extract_from_data_attrs(soup, base_url)
    if results:
        print(f"  Data-attr: {len(results)} products found")
        return results
    print("  Data-attr: no products found")

    # 3. Structured product card containers
    print("  Trying CSS product card selectors...")
    for selector in _PRODUCT_SELECTORS:
        cards = soup.select(selector)
        if len(cards) >= 3:
            for card in cards:
                name = _find_title(card)
                price_raw = _find_price_text(card)
                price = normalize_price(price_raw) if price_raw else None
                url = _find_url(card, base_url)
                if name and price is not None and _is_valid_product(name, price, url):
                    results.append({"name": name, "price": price, "url": url})
            if results:
                print(f"  CSS '{selector}': {len(results)} products found")
                return results

    print("  CSS selectors: no products found — falling back to price scan")

    # 4. Last resort: regex scan — strictly validated
    for el in soup.find_all(string=_PRICE_RE):
        price = normalize_price(el.strip())
        if price is None or price <= 0:
            continue
        parent = el.parent
        name = None
        product_url = ""
        for ancestor in [parent] + list(parent.parents)[:3]:
            heading = ancestor.find(re.compile(r'^h[2-5]$'))
            if heading and heading.get_text(strip=True):
                name = heading.get_text(strip=True)
                link = ancestor.find("a", href=True)
                if link:
                    product_url = _make_absolute(link.get("href", ""), base_url)
                break
            link = ancestor.find("a")
            if link and link.get_text(strip=True):
                name = link.get_text(strip=True)
                product_url = _make_absolute(link.get("href", ""), base_url)
                break
        if name and _is_valid_product(name, price, product_url):
            results.append({"name": name, "price": price, "url": product_url})

    if results:
        print(f"  Price scan: {len(results)} products found")
    else:
        print("  Price scan: no products found")

    return results


# ── Bot-detection helpers ──────────────────────────────────────────

_BLOCK_KEYWORDS = ("access denied", "captcha", "robot check",
                   "datadome", "please verify", "challenge")

def _is_blocked(html: str) -> bool:
    if len(html) < 5000:
        return True
    lower = html[:2000].lower()
    return any(kw in lower for kw in _BLOCK_KEYWORDS)


_SFCC_SHOWING_RE = re.compile(r"[Ss]howing\s+[\d,]+\s+of\s+([\d,]+)\s+item", re.IGNORECASE)


def _cffi_fetch(url: str) -> str:
    try:
        from curl_cffi import requests as cffi_req
    except ImportError:
        print("  curl-cffi not installed — run: pip install curl-cffi")
        return ""

    _headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }

    try:
        resp = cffi_req.get(url, impersonate="chrome110", timeout=30, headers=_headers)
        if resp.status_code != 200 or len(resp.text) < 5000:
            print(f"  curl-cffi: status {resp.status_code}")
            return ""

        html = resp.text
        print(f"  curl-cffi: {len(html):,} bytes received")

        # Salesforce Commerce Cloud (Demandware) sites support ?sz=N to return all
        # products in one response. Detect and refetch with the full catalogue size.
        if "/on/demandware" in html:
            m = _SFCC_SHOWING_RE.search(html)
            if m:
                total = int(m.group(1).replace(",", ""))
                if total > 24:
                    sep = "&" if "?" in url else "?"
                    full_url = f"{url}{sep}sz={total}"
                    print(f"  SFCC detected — fetching all {total} products...")
                    r2 = cffi_req.get(full_url, impersonate="chrome110", timeout=60, headers=_headers)
                    if r2.status_code == 200 and len(r2.text) > len(html):
                        print(f"  Full catalogue: {len(r2.text):,} bytes")
                        return r2.text

        return html
    except Exception as e:
        print(f"  curl-cffi error: {e}")
        return ""


# ── Async Playwright driver ────────────────────────────────────────

_MAX_PAGES = 20


async def _scrape_async(url: str) -> list[dict]:
    results = []
    visited = set()

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.set_extra_http_headers({
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            )
        })

        current_url = url
        page_num = 1
        while current_url and current_url not in visited and page_num <= _MAX_PAGES:
            visited.add(current_url)
            print(f"Loading page {page_num} (browser rendering)...")
            try:
                # "load" waits for all scripts — product grids rendered at this point.
                # Avoid networkidle: BE and many sites fire continuous analytics forever.
                await page.goto(current_url, wait_until="load", timeout=30000)
            except Exception:
                pass

            # Wait for price/product content; catches sites that load products via
            # a post-load async API call (gives them up to 20s to appear)
            try:
                await page.wait_for_selector(
                    '[class*="price"], .price, span.money, .item-dis, .product-card, .product-item, [class*="per-product"]',
                    timeout=20000,
                )
                print("  Product elements detected — scrolling to load all content...")
            except Exception:
                print("  Product elements not detected — capturing whatever is rendered...")

            # Scroll to trigger infinite-scroll loading. Stop when page height
            # stops growing for 2 consecutive scrolls (end of content or no infinite scroll).
            prev_height = await page.evaluate("document.body.scrollHeight")
            scroll_count = 0
            stale = 0
            while scroll_count < 50 and stale < 2:
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await page.wait_for_timeout(1500)
                new_height = await page.evaluate("document.body.scrollHeight")
                if new_height > prev_height:
                    scroll_count += 1
                    stale = 0
                    prev_height = new_height
                    print(f"  Scroll {scroll_count}: more content loaded...")
                else:
                    stale += 1

            if scroll_count >= 50:
                print(f"  Reached scroll limit (50) — there may be more products")

            html = await page.content()

            # If Playwright was blocked (Akamai, Cloudflare, DataDome) the response
            # is tiny. Fall back to curl-cffi which mimics Chrome's TLS fingerprint.
            if _is_blocked(html):
                print("  Browser blocked by bot protection — trying curl-cffi...")
                html = _cffi_fetch(current_url)

            soup = BeautifulSoup(html, "lxml")
            page_results = _extract_from_soup(soup, current_url)

            # Detect client-side-only pagination: if every product on this page
            # is already in results, the server is ignoring the page parameter
            if page_num > 1 and page_results:
                seen = {(r["name"], r["price"]) for r in results}
                truly_new = [r for r in page_results if (r["name"], r["price"]) not in seen]
                if not truly_new:
                    print(f"  Page {page_num} identical to previous pages — pagination is client-side, stopping")
                    break

            results.extend(page_results)
            print(f"  Page {page_num} subtotal: {len(results)} products total")

            # Stop paginating if this page had nothing — next link is likely a false positive
            if not page_results:
                break

            # If the page grew via infinite scroll, all content is already loaded —
            # skip URL-based pagination entirely
            if scroll_count > 0:
                print(f"  Infinite scroll detected — no URL pagination needed")
                break

            next_url = None
            for link in soup.find_all("a", string=_NEXT_PAGE_TEXTS):
                href = link.get("href", "")
                if not href:
                    continue
                abs_href = _make_absolute(href, current_url)
                if abs_href and abs_href not in visited:
                    next_url = abs_href
                    break
            current_url = next_url
            page_num += 1

        if page_num > _MAX_PAGES:
            print(f"  Reached page limit ({_MAX_PAGES})")

        await browser.close()

    return results


def scrape(url: str) -> list[dict]:
    return asyncio.run(_scrape_async(url))
