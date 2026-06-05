#!/bin/bash
set -e

echo "==> Installing python3.12-venv..."
sudo apt-get install -y python3.12-venv

echo "==> Creating virtual environment..."
python3 -m venv .venv

echo "==> Installing Python dependencies..."
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

echo "==> Installing Playwright browser (Chromium)..."
.venv/bin/playwright install chromium

echo ""
echo "Setup complete. To run the scraper:"
echo "  .venv/bin/python main.py --url https://example-jewellers.com"
