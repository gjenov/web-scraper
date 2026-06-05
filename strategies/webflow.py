import re
import time
import requests
from bs4 import BeautifulSoup

from utils.price import normalize_price


_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
}

_PRODUCT_HREF = re.compile(r'^/product/')
_CATEGORY_HREF = re.compile(r'/category/')


def _find_categories(base_url: str) -> list[str]:
    found = set()
    for path in ["", "/shop-menu", "/shop", "/collections"]:
        try:
            resp = requests.get(base_url + path, headers=_HEADERS, timeout=15)
            html = resp.text
            # Relative paths: /category/...
            for h in re.findall(r'href=["\'](/category/[^"\'#?]+)', html):
                found.add(base_url + h)
            # Absolute URLs containing /category/
            for h in re.findall(r'href=["\'](https?://[^"\'#?]+/category/[^"\'#?]+)', html):
                found.add(h.rstrip("/"))
        except Exception:
            pass
    return sorted(found)


def _parse_product_text(text: str) -> tuple[str, float | None]:
    # Link text format: "Product Name$\xa0price\xa0USDmetal/stone info..."
    parts = text.split("$")
    if len(parts) < 2:
        return text.strip(), None
    name = parts[0].strip()
    if not name:
        return "", None
    price = normalize_price("$" + parts[1])
    return name, price


def _scrape_page(url: str, base_url: str, category: str = "") -> list[dict]:
    resp = requests.get(url, headers=_HEADERS, timeout=15)
    soup = BeautifulSoup(resp.text, "lxml")
    results = []
    for link in soup.find_all("a", href=_PRODUCT_HREF):
        name, price = _parse_product_text(link.get_text())
        if name and price is not None:
            href = link.get("href", "")
            product_url = base_url + href if href else ""
            results.append({"name": name, "price": price, "url": product_url, "category": category})
    return results


def scrape(base_url: str) -> list[dict]:
    categories = _find_categories(base_url)
    if not categories:
        return _scrape_page(base_url, base_url)

    print(f"Found {len(categories)} categories: {[c.split('/')[-1] for c in categories]}")
    results = []
    seen = set()
    for cat_url in categories:
        category = cat_url.split("/")[-1]
        page_products = _scrape_page(cat_url, base_url, category=category)
        for p in page_products:
            key = (p["name"], p["price"])
            if key not in seen:
                seen.add(key)
                results.append(p)
        print(f"  {category}: {len(page_products)} products")
        time.sleep(0.5)

    return results
