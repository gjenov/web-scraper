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
    r'gifts? under|free shipping|purchase over|subscribe|newsletter|'
    r'sign up|log in|sign in|my account|view all|see all|load more|'
    r'add to cart|add to bag|sold out|out of stock|wishlist)\b',
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

    # 2. Structured product card containers
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

    # 3. Last resort: regex scan — strictly validated
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


# ── Async Playwright driver ────────────────────────────────────────

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
        while current_url and current_url not in visited:
            visited.add(current_url)
            print(f"Loading page {page_num} (browser rendering)...")
            # networkidle ensures JS-rendered product grids are present
            await page.goto(current_url, wait_until="networkidle", timeout=60000)
            await page.wait_for_timeout(2000)
            html = await page.content()
            soup = BeautifulSoup(html, "lxml")
            page_results = _extract_from_soup(soup, current_url)
            results.extend(page_results)
            print(f"  Page {page_num} subtotal: {len(results)} products total")

            next_url = None
            for link in soup.find_all("a", string=_NEXT_PAGE_TEXTS):
                href = link.get("href", "")
                if href and href not in visited:
                    next_url = href if href.startswith("http") else url.rstrip("/") + "/" + href.lstrip("/")
                    break
            current_url = next_url
            page_num += 1

        await browser.close()

    return results


def scrape(url: str) -> list[dict]:
    return asyncio.run(_scrape_async(url))
