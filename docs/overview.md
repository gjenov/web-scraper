# Jewelry Scraper — Project Overview

## Goal

Scrape product names, prices, and categories from jewelry e-commerce websites, process the data with pandas, and display it in a Node.js UI.

## Tech Stack

| Layer | Technology |
|---|---|
| Scraper | Python 3.12, requests, Playwright, BeautifulSoup, pandas |
| UI server | Node.js, Express |
| Frontend | Vanilla JS, Tabulator (table), Chart.js (charts) |
| Data exchange | CSV files written by the scraper, read by the server |

## High-Level Flow

```
User enters URL in browser
        │
        ▼
Node.js server (port 3001)
  spawns: python main.py --url <url> --output output/<site>_<ts>.csv
        │
        ▼
Python scraper
  1. Detect platform (Shopify / Webflow / generic)
  2. Run matching strategy → list of {name, price, category?}
  3. Load into pandas DataFrame
  4. Normalize prices, drop duplicates, sort
  5. Write CSV to output/
        │
        ▼
Node.js reads CSV, parses with csv-parse
  streams progress via SSE → browser renders table + charts
```

## Repository Structure

```
scraper/
├── main.py              # CLI entry point (--url, --output)
├── scraper.py           # Platform detection + pandas processing
├── strategies/
│   ├── shopify.py       # Shopify products.json API (paginated)
│   ├── webflow.py       # Webflow sites (requests + BeautifulSoup)
│   └── generic.py       # Fallback: Playwright + heuristic CSS selectors
├── utils/
│   └── price.py         # normalize_price() — strips currency symbols
├── ui/
│   ├── server.js        # Express server, /api/scrape SSE, /download/:file
│   └── public/
│       ├── index.html   # Single-page app shell
│       ├── app.js       # All frontend logic (SSE, Tabulator, Chart.js)
│       └── style.css    # Styles
├── output/              # Generated CSVs (git-ignored)
├── requirements.txt     # Python dependencies
└── docs/                # This folder
```
