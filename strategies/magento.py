import re
import json
from urllib.parse import urlparse
from bs4 import BeautifulSoup

from utils.price import normalize_price

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


def _cffi_get(url: str, **kwargs):
    from curl_cffi import requests as cffi
    return cffi.get(url, impersonate="chrome110", headers=_HEADERS, timeout=30, **kwargs)


def _cffi_post(url: str, **kwargs):
    from curl_cffi import requests as cffi
    return cffi.post(url, impersonate="chrome110", headers={
        **_HEADERS,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }, timeout=30, **kwargs)


# ── GraphQL helpers ────────────────────────────────────────────────

_URL_RESOLVER_Q = """
{ urlResolver(url: "%s") { id type relative_url } }
"""

_CATEGORY_Q = """
{
  category(id: %d) {
    name
    product_count
    products(pageSize: %d, currentPage: %d) {
      total_count
      page_info { page_size current_page total_pages }
      items {
        name
        sku
        url_key
        url_suffix
        price_range {
          minimum_price {
            final_price { value currency }
            regular_price { value currency }
          }
        }
      }
    }
  }
}
"""

_SEARCH_Q = """
{
  products(
    search: ""
    filter: {}
    pageSize: %d
    currentPage: %d
  ) {
    total_count
    page_info { page_size current_page total_pages }
    items {
      name
      sku
      url_key
      url_suffix
      price_range {
        minimum_price {
          final_price { value currency }
          regular_price { value currency }
        }
      }
    }
  }
}
"""


def _gql(base: str, query: str) -> dict | None:
    endpoint = base.rstrip("/") + "/graphql"
    try:
        r = _cffi_post(endpoint, json={"query": query})
        if r.status_code != 200:
            return None
        data = r.json()
        if "errors" in data and not data.get("data"):
            return None
        return data.get("data")
    except Exception:
        return None


def _item_to_record(item: dict, base_url: str) -> dict | None:
    name = (item.get("name") or "").strip()
    if not name:
        return None

    price_range = item.get("price_range", {})
    min_price = price_range.get("minimum_price", {})
    final = min_price.get("final_price", {})
    regular = min_price.get("regular_price", {})
    price_val = final.get("value") or regular.get("value")
    if not price_val:
        return None
    try:
        price = float(price_val)
    except (TypeError, ValueError):
        return None
    if price <= 0:
        return None

    url_key = item.get("url_key", "")
    suffix = item.get("url_suffix") or ".html"
    p = urlparse(base_url)
    prod_url = f"{p.scheme}://{p.netloc}/{url_key}{suffix}" if url_key else ""

    return {"name": name, "price": price, "url": prod_url}


def _scrape_graphql_category(base: str, page_url: str) -> list[dict]:
    """Resolve page URL → category ID → paginate all products."""
    p = urlparse(page_url)
    path = p.path.lstrip("/")
    if p.query:
        path = path  # strip query for urlResolver

    data = _gql(base, _URL_RESOLVER_Q % path)
    if not data or not data.get("urlResolver"):
        return []

    resolver = data["urlResolver"]
    if resolver.get("type") != "CATEGORY":
        return []

    cat_id = resolver.get("id")
    if not cat_id:
        return []

    # Fetch first page to get total
    first = _gql(base, _CATEGORY_Q % (cat_id, 48, 1))
    if not first or not first.get("category"):
        return []

    cat = first["category"]
    products_data = cat.get("products", {})
    page_info = products_data.get("page_info", {})
    total_pages = page_info.get("total_pages", 1)
    total_count = products_data.get("total_count", 0)
    print(f"  Magento GraphQL: category '{cat.get('name')}' — {total_count} products, {total_pages} pages")

    results = []
    for item in products_data.get("items", []):
        rec = _item_to_record(item, base)
        if rec:
            results.append(rec)

    for page_num in range(2, total_pages + 1):
        data = _gql(base, _CATEGORY_Q % (cat_id, 48, page_num))
        if not data or not data.get("category"):
            break
        for item in data["category"]["products"].get("items", []):
            rec = _item_to_record(item, base)
            if rec:
                results.append(rec)
        if page_num % 10 == 0 or page_num == total_pages:
            print(f"  Page {page_num}/{total_pages}: {len(results)} products so far")

    return results


# ── HTML fallback ──────────────────────────────────────────────────

_PRODUCT_SELECTORS = [
    "li.product-item",
    ".products-grid li.item",
    ".products-list li.item",
    "[class*='product-item']",
]

_NAME_SELECTORS = [
    ".product-item-name a",
    ".product-item-name",
    ".product-name a",
    ".product-name",
    "a.product-item-photo",
    "h2.product-name",
]

_PRICE_SELECTORS = [
    "[data-price-type='finalPrice'] .price",
    ".price-wrapper .price",
    ".special-price .price",
    ".price",
]


def _extract_html(html: str, page_url: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    results = []

    for sel in _PRODUCT_SELECTORS:
        cards = soup.select(sel)
        if len(cards) < 3:
            continue

        for card in cards:
            # Name
            name = None
            for ns in _NAME_SELECTORS:
                el = card.select_one(ns)
                if el:
                    name = el.get_text(strip=True)
                    if name:
                        break

            # URL
            link = card.select_one("a[href]")
            prod_url = link.get("href", "") if link else ""
            if prod_url and not prod_url.startswith("http"):
                p = urlparse(page_url)
                prod_url = f"{p.scheme}://{p.netloc}{prod_url}"

            # Price
            price_text = None
            for ps in _PRICE_SELECTORS:
                el = card.select_one(ps)
                if el:
                    price_text = el.get_text(strip=True)
                    if price_text:
                        break

            price = normalize_price(price_text) if price_text else None
            if name and price and price > 0:
                results.append({"name": name, "price": price, "url": prod_url})

        if results:
            print(f"  Magento HTML '{sel}': {len(results)} products")
            return results

    return results


def _fetch_with_limit(url: str, limit: int) -> str:
    """Fetch Magento category page with product_list_limit param."""
    sep = "&" if "?" in url else "?"
    target = f"{url}{sep}product_list_limit={limit}"
    try:
        r = _cffi_get(target)
        if r.status_code == 200 and len(r.text) > 5000:
            return r.text
    except Exception:
        pass
    return ""


# ── Public entry point ─────────────────────────────────────────────

def scrape(url: str) -> list[dict]:
    p = urlparse(url)
    base = f"{p.scheme}://{p.netloc}"

    # 1. Try GraphQL category resolution
    print("  Trying Magento GraphQL API...")
    results = _scrape_graphql_category(base, url)
    if results:
        print(f"  GraphQL: {len(results)} products found")
        return results
    print("  GraphQL: no results — falling back to HTML")

    # 2. HTML scraping — try large product_list_limit values first
    for limit in [96, 48, 24]:
        print(f"  Fetching with product_list_limit={limit}...")
        html = _fetch_with_limit(url, limit)
        if html:
            results = _extract_html(html, url)
            if results:
                # Check if there's a next page
                soup = BeautifulSoup(html, "lxml")
                next_link = soup.select_one("a.next, .pages a[title='Next'], li.pages-item-next a")
                if next_link:
                    print("  Pagination detected — fetching additional pages...")
                    page_num = 2
                    while next_link and page_num <= 50:
                        href = next_link.get("href", "")
                        if not href or not href.startswith("http"):
                            break
                        r = _cffi_get(href)
                        if r.status_code != 200:
                            break
                        more = _extract_html(r.text, url)
                        seen = {(r2["name"], r2["price"]) for r2 in results}
                        new = [r2 for r2 in more if (r2["name"], r2["price"]) not in seen]
                        if not new:
                            break
                        results.extend(new)
                        print(f"  Page {page_num}: {len(results)} products total")
                        soup2 = BeautifulSoup(r.text, "lxml")
                        next_link = soup2.select_one("a.next, .pages a[title='Next'], li.pages-item-next a")
                        page_num += 1
                return results

    print("  Magento: no products found")
    return []
