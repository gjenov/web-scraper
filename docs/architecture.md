# Architecture

## Platform Detection (`scraper.py`)

When given a URL the scraper:

1. Follows redirects to resolve the canonical URL (`requests.head`)
2. Fetches the homepage and probes `/products.json?limit=1`
   - 200 + `"products"` key → **Shopify**
3. Checks HTML for `data-wf-domain` or `"webflow"` string → **Webflow**
4. Otherwise → **generic**

## Strategies

### Shopify (`strategies/shopify.py`)
- Hits `/products.json?limit=250&page=N` until an empty page
- Extracts `title` and the minimum `price` across all variants
- Pure HTTP — no browser needed, fast

### Webflow (`strategies/webflow.py`)
- Uses `requests` + BeautifulSoup
- Finds category links via `/category/` href patterns across common nav paths
- Scrapes each category page, parses product `<a href="/product/...">` links
- Extracts name and price from link text (`"Name$price USDmetal..."` format)

### Generic (`strategies/generic.py`)
- Uses Playwright (headless Chromium) to handle JS-rendered pages
- Tries a ranked list of CSS selectors for product cards: `li.product`, `.product-card`, `[data-product-id]`, etc.
- Falls back to regex price scanning + nearest heading heuristic
- Follows pagination via "Next / › / »" links

## Data Processing (`scraper.py → run()`)

After the strategy returns `list[dict]`:

```python
df = pd.DataFrame(records)
df["price"] = df["price"].apply(normalize_price)   # string prices → float
df = df.dropna(subset=["price"])                   # drop unresolvable prices
df = df.drop_duplicates(subset=["name", "price"])  # deduplicate
df = df.sort_values("name").reset_index(drop=True) # alphabetical
# column order: name, price, [category, ...]
df.to_csv(output_path, index=False)
```

`utils/price.py → normalize_price()` strips currency symbols/codes (`$`, `£`, `€`, `USD`, `AUD`, etc.) and returns the first numeric value as a float. For price ranges it takes the lower value.

## UI Server (`ui/server.js`)

- `GET /api/scrape?url=<url>` — Server-Sent Events (SSE) stream
  - Spawns `python main.py --url <url> --output output/<site>_<timestamp>.csv`
  - Forwards stdout lines as `progress` events
  - On exit: reads CSV with `csv-parse`, sends `complete` event with full product array
  - On error: sends `error` event
  - If the client disconnects the Python process is killed
- `GET /download/:filename` — serves a CSV from `output/` (path traversal protected via `path.basename`)
- Static files served from `ui/public/`

## Frontend (`ui/public/app.js`)

- Opens an `EventSource` to `/api/scrape` on button click
- Streams log lines into a scrollable progress panel
- On `complete`: renders with Tabulator (sortable, paginated table) and Chart.js (price histogram + category bar chart)
- Category dropdown + name search filter the Tabulator data and re-render stats live
- Download button hits `/download/:filename` for the CSV
