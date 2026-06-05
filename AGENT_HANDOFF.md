# Agent Handoff — Scraper → WordPress Plugin

You are a Claude Code instance running **on the production droplet**. This document tells you exactly what this project is, what decisions have already been made, and what you need to build.

---

## What This Project Is

A product-price scraper with a web UI. The user pastes a jewellery site URL, the scraper runs in the background, streams live progress, and produces a downloadable CSV of `name, price, url` rows.

It currently runs as a **Node.js + Python** stack on the developer's local WSL machine. The goal is to deploy it as a **WordPress plugin** on this droplet, replacing the standalone Node.js UI with a WP admin page.

---

## Current Stack (on developer's machine)

```
scraper/
├── main.py                  # CLI entry point — called by server.js, prints progress to stdout
├── scraper.py               # Orchestrates scraping: platform detection → strategy → dedup → CSV
├── requirements.txt         # Python deps: playwright, beautifulsoup4, requests, pandas, lxml, curl-cffi
├── strategies/
│   ├── generic.py           # Main strategy: Playwright + curl-cffi + JSON API detection
│   ├── shopify.py           # Shopify /products.json API
│   └── webflow.py           # Webflow CMS API
├── utils/
│   └── price.py             # Price string normaliser
└── ui/
    ├── server.js            # Node.js HTTP server: SSE streaming, CSV file management, REST API
    └── public/
        ├── index.html       # Single-page UI
        ├── app.js           # Frontend JS: SSE client, history panel, live count/timer
        └── style.css        # Styles (dark theme, gold accents)
```

### How it works today

1. User opens the Node.js UI in a browser
2. Enters a URL and clicks "Scrape"
3. `server.js` spawns `python3 -u main.py --url <url> --output <path>` as a child process
4. `main.py` prints progress lines to stdout; Node reads them and pushes each line to the browser via **Server-Sent Events (SSE)**
5. When done, Node writes a `.meta.json` sidecar next to the CSV (stores the scraped URL)
6. Browser shows a download link and adds the run to the history panel

### What the scraper actually does

- Detects platform (Shopify → `/products.json` API; Webflow → CMS API; everything else → `generic.py`)
- `generic.py` uses **Playwright** (headless Chromium) to render JS-heavy pages
- If Playwright is blocked (Akamai/Cloudflare): falls back to **curl-cffi** (Chrome TLS impersonation)
- Detects and handles:
  - **Infinite scroll** — polls `scrollHeight` in a loop, up to 50 scrolls
  - **SFCC / Demandware** — detects `/on/demandware`, reads "Showing X of Y" text, refetches with `?sz=Y`
  - **SAP Commerce GLP API** (Shane Co) — detects `data-url="…/glpCategories/…"`, paginates JSON API with `&page=N`
  - **BrilliantEarth** — products embedded as JSON in `data-center` attributes
- Output: deduplicated CSV with columns `name, price, url`

---

## Decisions Already Made

| Question | Answer |
|---|---|
| WP ↔ Python communication | Python runs as a **persistent service** on the droplet (REST API on localhost) |
| Scraped data in WP | **CSV download only** — no custom post types, no WooCommerce import |
| Live progress | **Yes** — real-time SSE, same experience as current UI |
| Node.js fate | **Replace it** with a Python Flask/FastAPI service |
| WP already installed | **Yes** — WordPress is already running on this droplet |
| CSV storage location | **To be decided** — explore and pick what fits: `/wp-content/uploads/scraper/` or keep `/home/gjenov/scraper/output/` |

---

## What You Need to Build

### 1. Python API server (`api_server.py`)

Replace `ui/server.js` with a Python Flask (or FastAPI) server that:

- `POST /api/scrape` — accepts `{ "url": "..." }`, spawns scraper, returns `{ "job_id": "..." }`
- `GET /api/stream/{job_id}` — SSE endpoint, streams stdout lines from the running scraper
- `GET /api/results` — lists past CSV files (with metadata from `.meta.json` sidecars)
- `GET /api/download/{filename}` — serves a CSV file
- `DELETE /api/results/{filename}` — deletes a CSV and its sidecar
- Run on **localhost only** (e.g. `127.0.0.1:5001`) — never expose directly to internet

Use `flask` or `fastapi` + `uvicorn`. Prefer Flask for simplicity (fewer dependencies).

### 2. Systemd service

A `.service` file so the Python API server starts on boot and restarts on crash:

```
/etc/systemd/system/scraper-api.service
```

### 3. Web server proxy

Add a location block so the WP admin page JS can reach the Python service without CORS issues:

**If Nginx:**
```nginx
location /scraper-api/ {
    proxy_pass http://127.0.0.1:5001/;
    proxy_http_version 1.1;
    proxy_set_header Connection '';          # needed for SSE
    proxy_set_header Cache-Control 'no-cache';
    proxy_buffering off;                     # critical for SSE streaming
    proxy_read_timeout 600s;
    chunked_transfer_encoding on;
}
```

**If Apache:**
```apache
ProxyPass /scraper-api/ http://127.0.0.1:5001/
ProxyPassReverse /scraper-api/ http://127.0.0.1:5001/
```

### 4. WordPress plugin (`wp-content/plugins/scraper/`)

```
scraper/
├── scraper.php          # Main plugin file: registers admin menu, enqueues assets
├── admin-page.php       # Admin page HTML (URL input, log panel, history)
├── assets/
│   ├── app.js           # Ported from ui/public/app.js — calls /scraper-api/* instead of relative paths
│   └── style.css        # Ported from ui/public/style.css
└── readme.txt
```

Key plugin behaviours:
- Admin menu entry: **Scraper** under the WP admin sidebar
- Capability check: only `manage_options` (admins) can use it
- JS makes requests to `/scraper-api/api/scrape`, `/scraper-api/api/stream/{id}`, etc.
- Live count + timer in the log header (port the existing `app.js` logic exactly)
- History panel with delete buttons and CSV download links

---

## Your First Steps on the Droplet

Before writing any code, **explore the environment**:

1. `nginx -v` or `apache2 -V` — which web server?
2. `python3 --version` — Python 3.10+?
3. `pip3 list | grep -E 'flask|fastapi|playwright'` — what's already installed?
4. `ls /var/www/` or `ls /srv/www/` — where is WordPress?
5. `cat /etc/nginx/sites-enabled/*` or `apachectl -S` — find the active vhost config file
6. `wp --info` (if WP-CLI installed) — confirm WP setup
7. Check if Playwright browsers are installed: `python3 -c "from playwright.sync_api import sync_playwright; print('ok')"`
8. Check ports in use: `ss -tlnp | grep -E '80|443|5001'`

Then:
- Install Python deps if missing: `pip3 install flask curl-cffi playwright pandas beautifulsoup4 lxml requests`
- Install Playwright browsers if missing: `playwright install chromium`
- Verify the scraper works standalone: `cd /path/to/scraper && python3 main.py --url https://www.brilliantearth.com/engagement-rings/shop-all/ --output /tmp/test.csv`

---

## Important Implementation Notes

### SSE streaming from Python Flask

```python
from flask import Flask, Response, stream_with_context
import subprocess, queue, threading

jobs = {}  # job_id → {'process': ..., 'queue': Queue()}

@app.route('/api/stream/<job_id>')
def stream(job_id):
    q = jobs.get(job_id, {}).get('queue')
    if not q:
        return 'not found', 404

    def generate():
        while True:
            line = q.get()
            if line is None:  # sentinel: job finished
                yield 'data: [DONE]\n\n'
                break
            yield f'data: {line}\n\n'

    return Response(stream_with_context(generate()),
                    mimetype='text/event-stream',
                    headers={'X-Accel-Buffering': 'no'})  # tells Nginx not to buffer
```

The `X-Accel-Buffering: no` header is critical — without it Nginx will buffer SSE and the UI won't see real-time output.

### Spawn scraper with `-u` (unbuffered stdout)

```python
proc = subprocess.Popen(
    ['python3', '-u', 'main.py', '--url', url, '--output', output_path],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    cwd='/path/to/scraper', text=True, bufsize=1,
)
```

The `-u` flag is **mandatory** — without it Python buffers stdout in 8KB blocks and SSE lines arrive in batches instead of one at a time.

### WordPress plugin admin page JS

The current `app.js` uses relative URLs like `/api/scrape`. In the plugin, change these to `/scraper-api/api/scrape` (or make the base URL a JS variable injected via `wp_localize_script`).

```php
wp_localize_script('scraper-app', 'scraperConfig', [
    'apiBase' => home_url('/scraper-api'),
]);
```

Then in JS: `const API = scraperConfig.apiBase;`

### Playwright on a headless server

On a Linux server without a display, Playwright needs system dependencies:

```bash
playwright install-deps chromium
# or if that fails:
apt-get install -y libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 libpango-1.0-0 libcairo2 libasound2
```

Test with: `python3 -c "from playwright.sync_api import sync_playwright; p = sync_playwright().start(); b = p.chromium.launch(); print('browser ok'); b.close(); p.stop()"`

---

## Repo Structure After Port

```
scraper/                        ← Python backend (unchanged)
├── main.py
├── scraper.py
├── api_server.py               ← NEW: replaces server.js
├── strategies/
├── utils/
└── requirements.txt            ← add: flask

wordpress-plugin/               ← NEW
└── scraper/
    ├── scraper.php
    ├── admin-page.php
    └── assets/
        ├── app.js
        └── style.css

deploy/                         ← NEW: deployment helpers
├── scraper-api.service         ← systemd unit
└── nginx-location.conf         ← Nginx snippet to paste into vhost
```

---

## What to Ask the User If Stuck

- "What path is WordPress installed at?" (if `ls /var/www/` isn't obvious)
- "What's the domain/subdomain for this WP site?" (for Nginx vhost location)
- "Should I create a new output directory for CSVs, or use an existing one?"
- "Should the plugin be network-activated or single-site?" (usually single-site)

Do **not** ask about Python version, web server type, or installed packages — just check those yourself with the commands above.
