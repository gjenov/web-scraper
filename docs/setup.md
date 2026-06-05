# Setup & Running

## Prerequisites

- Python 3.12+ (inside WSL Ubuntu)
- Node.js 18+ (inside WSL Ubuntu)
- Playwright browsers installed (see below)

## First-time Install

### Python

```bash
cd /home/gjenov/scraper
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium
```

### Node.js UI

```bash
cd /home/gjenov/scraper/ui
npm install
```

## Running

### Start the UI (includes the scraper as a subprocess)

```bash
cd /home/gjenov/scraper/ui
npm start
# → http://localhost:3001
```

The Node server spawns the Python scraper automatically when you submit a URL.
The `.venv` Python binary is hardcoded at `../.venv/bin/python` relative to `ui/`.

### Run the scraper directly (CLI)

```bash
cd /home/gjenov/scraper
source .venv/bin/activate
python main.py --url https://example-jewelry-store.com
# Output written to output/<sitename>.csv
```

Optional flag: `--output path/to/file.csv`

## Output

CSVs are written to `output/` (git-ignored). Columns:

| Column | Type | Notes |
|---|---|---|
| name | string | Product title |
| price | float | Lowest variant price, currency stripped |
| category | string | Present for Webflow and generic sites only |
