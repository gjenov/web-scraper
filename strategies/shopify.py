import time
import requests


_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
}


def scrape(base_url: str) -> list[dict]:
    products = []
    page = 1

    while True:
        url = f"{base_url}/products.json?limit=250&page={page}"
        resp = requests.get(url, headers=_HEADERS, timeout=15)
        resp.raise_for_status()
        data = resp.json()

        page_products = data.get("products", [])
        if not page_products:
            break

        before = len(products)
        for product in page_products:
            name = product.get("title", "").strip()
            variants = product.get("variants", [])
            if not variants:
                continue
            # Take the lowest price across all variants
            prices = []
            for v in variants:
                try:
                    prices.append(float(v.get("price", 0) or 0))
                except (ValueError, TypeError):
                    pass
            if not prices:
                continue
            handle = product.get("handle", "")
            products.append({
                "name": name,
                "price": min(prices),
                "url": f"{base_url}/products/{handle}" if handle else "",
            })

        added = len(products) - before
        print(f"  Page {page}: {added} products  (running total: {len(products)})")
        page += 1
        time.sleep(0.5)

    print(f"Shopify: {len(products)} products across {page - 1} page{'s' if page - 1 != 1 else ''}")
    return products
