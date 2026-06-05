/* global Tabulator, Chart */

const urlInput    = document.getElementById('url-input');
const scrapeBtn   = document.getElementById('scrape-btn');
const historyCard = document.getElementById('history-card');
const historyList = document.getElementById('history-list');
const historyTotal = document.getElementById('history-total');
const logCard     = document.getElementById('log-card');
const logEl       = document.getElementById('log');
const logSpinner  = document.getElementById('log-spinner');
const logTimer    = document.getElementById('log-timer');
const logCount    = document.getElementById('log-count');
const errorCard   = document.getElementById('error-card');
const errorMsg    = document.getElementById('error-msg');
const resultsEl   = document.getElementById('results');
const catFilter   = document.getElementById('category-filter');
const searchInput = document.getElementById('search-input');
const downloadBtn = document.getElementById('download-btn');

let table = null;
let priceChart = null;
let catChart = null;
let allData = [];
let downloadUrl = '';

// ── Timer ──────────────────────────────────────────────────────────

let timerInterval = null;

function startTimer() {
  const start = Date.now();
  logTimer.textContent = '00:00';
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - start) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    logTimer.textContent = `${mm}:${ss}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

// ── Chart.js dark theme defaults ───────────────────────────────────
Chart.defaults.color = '#8a8899';
Chart.defaults.borderColor = 'rgba(255,255,255,0.05)';

// ── Helpers ────────────────────────────────────────────────────────

const fmt = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function show(el)  { el.classList.remove('hidden'); }
function hide(el)  { el.classList.add('hidden'); }

// Patterns that carry a product count — ordered most-specific first
const COUNT_RE = [
  /subtotal:\s*(\d+)\s+products?\s+total/i,    // "Page N subtotal: 25 products total"
  /running total:\s*(\d+)/i,                    // shopify "(running total: 42)"
  /^Done\s*[—-]\s*(\d+)\s+products?\s+saved/i, // "Done — 21 products saved"
  /:\s*(\d+)\s+products?\s+found/i,             // "Price scan: 25 products found"
  /:\s*(\d+)\s+products?\s+across/i,            // "Shopify: 48 products across 3 pages"
];

let _maxCount = 0;

function updateCount(msg) {
  for (const re of COUNT_RE) {
    const m = msg.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > _maxCount) {
        _maxCount = n;
        logCount.textContent = `${n} found`;
      }
      return;
    }
  }
}

function appendLog(msg, isErr = false) {
  const div = document.createElement('div');
  div.className = 'line' + (isErr ? ' err' : '');
  div.textContent = msg;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  updateCount(msg);
}

// ── Stats ──────────────────────────────────────────────────────────

function renderStats(data) {
  const prices = data.map(r => r.price).filter(p => !isNaN(p));
  document.getElementById('stat-count').textContent = data.length;
  document.getElementById('stat-min').textContent   = prices.length ? fmt(Math.min(...prices)) : '—';
  document.getElementById('stat-max').textContent   = prices.length ? fmt(Math.max(...prices)) : '—';
  document.getElementById('stat-avg').textContent   = prices.length
    ? fmt(prices.reduce((a, b) => a + b, 0) / prices.length)
    : '—';
}

// ── Table ──────────────────────────────────────────────────────────

function buildColumns(data) {
  const hasCategory = data.some(r => r.category);
  const cols = [
    { title: 'Name', field: 'name', widthGrow: 3, headerSort: true },
    {
      title: 'Link', field: 'url', width: 72, headerSort: false,
      formatter: (cell) => {
        const url = cell.getValue();
        if (!url) return '<span style="color:#444">—</span>';
        return `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:var(--gold);text-decoration:none;font-size:0.8rem;font-weight:500;letter-spacing:0.01em;">View ↗</a>`;
      },
    },
    {
      title: 'Price', field: 'price', widthGrow: 1, headerSort: true,
      formatter: (cell) => fmt(cell.getValue()),
      sorter: 'number',
    },
  ];
  if (hasCategory) {
    cols.push({ title: 'Category', field: 'category', widthGrow: 1, headerSort: true });
  }
  return cols;
}

function renderTable(data) {
  if (table) {
    table.setData(data);
    table.setColumns(buildColumns(data));
    return;
  }
  table = new Tabulator('#table', {
    data,
    columns: buildColumns(data),
    layout: 'fitColumns',
    pagination: 'local',
    paginationSize: 25,
    paginationSizeSelector: [10, 25, 50, 100],
    movableColumns: false,
    initialSort: [{ column: 'name', dir: 'asc' }],
    height: '420px',
  });
}

// ── Filters ────────────────────────────────────────────────────────

function populateCategoryFilter(data) {
  const cats = [...new Set(data.map(r => r.category).filter(Boolean))].sort();
  catFilter.innerHTML = '<option value="">All Categories</option>';
  cats.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c.charAt(0).toUpperCase() + c.slice(1);
    catFilter.appendChild(opt);
  });
  const hasCats = cats.length > 0;
  catFilter.style.display = hasCats ? '' : 'none';
  document.getElementById('cat-chart-card').style.display = hasCats ? '' : 'none';
}

function applyFilters() {
  const cat = catFilter.value;
  const search = searchInput.value.toLowerCase();
  const filtered = allData.filter(r => {
    const matchCat    = !cat || r.category === cat;
    const matchSearch = !search || r.name.toLowerCase().includes(search);
    return matchCat && matchSearch;
  });
  table.setData(filtered);
  renderStats(filtered);
}

catFilter.addEventListener('change', applyFilters);
searchInput.addEventListener('input', applyFilters);

// ── Charts ─────────────────────────────────────────────────────────

const JEWEL_PALETTE = ['#d4a853', '#a78bfa', '#60a5fa', '#34d399', '#f472b6', '#fb923c'];

function priceHistogram(data) {
  const prices = data.map(r => r.price).filter(p => !isNaN(p));
  if (!prices.length) return;

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const BINS = 10;
  const step = (max - min) / BINS || 1;
  const buckets = Array.from({ length: BINS }, (_, i) => ({ label: fmt(min + i * step), count: 0 }));

  prices.forEach(p => {
    const i = Math.min(Math.floor((p - min) / step), BINS - 1);
    buckets[i].count++;
  });

  const ctx = document.getElementById('price-chart').getContext('2d');
  if (priceChart) priceChart.destroy();
  priceChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: buckets.map(b => b.label),
      datasets: [{
        data: buckets.map(b => b.count),
        backgroundColor: 'rgba(212, 168, 83, 0.65)',
        borderColor: '#d4a853',
        borderWidth: 1,
        borderRadius: 5,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 10 }, maxRotation: 40 },
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { precision: 0 },
        },
      },
    },
  });
}

function categoryChart(data) {
  const cats = {};
  data.forEach(r => { if (r.category) cats[r.category] = (cats[r.category] || 0) + 1; });
  const labels = Object.keys(cats).sort();
  if (!labels.length) return;

  const ctx = document.getElementById('cat-chart').getContext('2d');
  if (catChart) catChart.destroy();
  catChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels.map(l => l.charAt(0).toUpperCase() + l.slice(1)),
      datasets: [{
        data: labels.map(l => cats[l]),
        backgroundColor: labels.map((_, i) => JEWEL_PALETTE[i % JEWEL_PALETTE.length] + 'b0'),
        borderColor:     labels.map((_, i) => JEWEL_PALETTE[i % JEWEL_PALETTE.length]),
        borderWidth: 1,
        borderRadius: 5,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { precision: 0 },
        },
      },
    },
  });
}

// ── History ────────────────────────────────────────────────────────

function renderResults(products, filename) {
  const siteName = filename.replace(/_\d+\.csv$/, '');
  allData = products;
  downloadUrl = `/download/${filename}`;

  renderStats(products);
  populateCategoryFilter(products);
  renderTable(products);
  priceHistogram(products);
  categoryChart(products);

  catFilter.value = '';
  searchInput.value = '';

  downloadBtn.onclick = () => { window.location.href = downloadUrl; };
  downloadBtn.textContent = `Download ${siteName}.csv`;

  hide(errorCard);
  show(resultsEl);
}

let activeHistoryFile = null;

async function selectHistory(filename, itemEl) {
  historyList.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));
  itemEl.classList.add('active');
  activeHistoryFile = filename;
  try {
    const { products } = await fetch(`/api/results/${encodeURIComponent(filename)}`).then(r => r.json());
    renderResults(products, filename);
  } catch (e) {
    errorMsg.textContent = 'Failed to load: ' + e.message;
    show(errorCard);
  }
}

async function deleteHistory(filename, itemEl) {
  try {
    await fetch(`/api/results/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    itemEl.remove();
    if (filename === activeHistoryFile) {
      hide(resultsEl);
      activeHistoryFile = null;
    }
    const remaining = historyList.querySelectorAll('.history-item').length;
    if (remaining === 0) {
      hide(historyCard);
    } else {
      historyTotal.textContent = `${remaining} file${remaining !== 1 ? 's' : ''}`;
    }
  } catch (e) {
    errorMsg.textContent = 'Failed to delete: ' + e.message;
    show(errorCard);
  }
}

async function loadHistory() {
  try {
    const results = await fetch('/api/results').then(r => r.json());
    if (!results.length) { hide(historyCard); return; }

    show(historyCard);
    historyTotal.textContent = `${results.length} file${results.length !== 1 ? 's' : ''}`;
    historyList.innerHTML = '';

    results.forEach(r => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.dataset.filename = r.filename;

      const date = new Date(r.timestamp);
      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

      item.innerHTML = `
        <div class="history-item-main">
          <span class="history-site">${r.site}</span>
          <span class="history-meta">${dateStr} · ${timeStr}</span>
        </div>
        <div class="history-item-right">
          <span class="history-badge">${r.count} products</span>
          <span class="history-arrow">→</span>
          <button class="history-delete" title="Delete" aria-label="Delete">✕</button>
        </div>`;

      item.querySelector('.history-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteHistory(r.filename, item);
      });
      item.addEventListener('click', () => selectHistory(r.filename, item));
      historyList.appendChild(item);
    });
  } catch {}
}

loadHistory();

// ── Scrape ─────────────────────────────────────────────────────────

scrapeBtn.addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (!url) { urlInput.focus(); return; }

  scrapeBtn.disabled = true;
  hide(errorCard);
  hide(resultsEl);
  logEl.innerHTML = '';
  logCount.textContent = '';
  _maxCount = 0;
  logSpinner.classList.remove('done');
  show(logCard);
  startTimer();

  const es = new EventSource(`/api/scrape?url=${encodeURIComponent(url)}`);

  es.addEventListener('progress', (e) => {
    const { message, isError } = JSON.parse(e.data);
    appendLog(message, isError);
  });

  es.addEventListener('complete', (e) => {
    es.close();
    stopTimer();
    logSpinner.classList.add('done');

    const { products, downloadUrl: dl } = JSON.parse(e.data);
    const filename = dl.replace('/download/', '');
    renderResults(products, filename);
    loadHistory();
    scrapeBtn.disabled = false;
  });

  es.addEventListener('error', (e) => {
    es.close();
    stopTimer();
    logSpinner.classList.add('done');
    scrapeBtn.disabled = false;

    try {
      const { message } = JSON.parse(e.data);
      errorMsg.textContent = message;
      show(errorCard);
    } catch {
      if (!resultsEl.classList.contains('hidden')) return;
      errorMsg.textContent = 'Connection lost. Please try again.';
      show(errorCard);
    }
  });
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') scrapeBtn.click();
});
