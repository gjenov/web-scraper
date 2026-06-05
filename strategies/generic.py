import re
import asyncio
from urllib.parse import urlparse
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright

from utils.price import normalize_price


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


_PRICE_RE = re.compile(r'[\$£€][\d,]+(?:\.\d{2})?|\d+(?:,\d{3})*(?:\.\d{2})?\s*(?:AUD|USD|NZD|GBP|EUR)', re.IGNORECASE)

_NEXT_PAGE_TEXTS = re.compile(r'next|›|»|load more', re.IGNORECASE)

_PRODUCT_SELECTORS = [
    # Common product card containers across WooCommerce, generic themes
    "li.product",
    "div.product",
    ".product-item",
    ".product-card",
    "[data-product-id]",
    ".grid-item",
    ".collection-item",
]

_TITLE_SELECTORS = ["h2", "h3", "h4", ".product-title", ".product-name", ".item-title", "a"]
_PRICE_SELECTORS = [".price", ".product-price", ".amount", "span.money", "[class*='price']"]


def _extract_from_soup(soup: BeautifulSoup, base_url: str = "") -> list[dict]:
    results = []

    # Try structured product containers first
    for selector in _PRODUCT_SELECTORS:
        cards = soup.select(selector)
        if len(cards) >= 3:
            for card in cards:
                name = _find_title(card)
                price_raw = _find_price_text(card)
                price = normalize_price(price_raw) if price_raw else None
                if name and price is not None:
                    results.append({"name": name, "price": price, "url": _find_url(card, base_url)})
            if results:
                return results

    # Fallback: scan all price-like text and grab nearest sibling heading
    for el in soup.find_all(string=_PRICE_RE):
        price = normalize_price(el.strip())
        if price is None:
            continue
        parent = el.parent
        name = None
        product_url = ""
        for ancestor in [parent] + list(parent.parents)[:4]:
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
        if name:
            results.append({"name": name, "price": price, "url": product_url})

    return results


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
    # Fallback: find any price-like text in card
    match = _PRICE_RE.search(card.get_text())
    return match.group(0) if match else None


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
        while current_url and current_url not in visited:
            visited.add(current_url)
            await page.goto(current_url, wait_until="load", timeout=60000)
            await page.wait_for_timeout(2000)
            html = await page.content()
            soup = BeautifulSoup(html, "lxml")
            page_results = _extract_from_soup(soup, current_url)
            results.extend(page_results)

            # Find next page link
            next_url = None
            for link in soup.find_all("a", string=_NEXT_PAGE_TEXTS):
                href = link.get("href", "")
                if href and href not in visited:
                    next_url = href if href.startswith("http") else url.rstrip("/") + "/" + href.lstrip("/")
                    break
            current_url = next_url

        await browser.close()

    return results


def scrape(url: str) -> list[dict]:
    return asyncio.run(_scrape_async(url))
