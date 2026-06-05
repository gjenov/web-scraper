/* global Tabulator, Chart */

const urlInput    = document.getElementById('url-input');
const scrapeBtn   = document.getElementById('scrape-btn');
const logCard     = document.getElementById('log-card');
const logEl       = document.getElementById('log');
const logSpinner  = document.getElementById('log-spinner');
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

// ── Helpers ────────────────────────────────────────────────────────────────

const fmt = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function show(el)  { el.classList.remove('hidden'); }
function hide(el)  { el.classList.add('hidden'); }

function appendLog(msg, isErr = false) {
  const div = document.createElement('div');
  div.className = 'line' + (isErr ? ' err' : '');
  div.textContent = msg;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// ── Stats ──────────────────────────────────────────────────────────────────

function renderStats(data) {
  const prices = data.map(r => r.price).filter(p => !isNaN(p));
  document.getElementById('stat-count').textContent = data.length;
  document.getElementById('stat-min').textContent   = prices.length ? fmt(Math.min(...prices)) : '—';
  document.getElementById('stat-max').textContent   = prices.length ? fmt(Math.max(...prices)) : '—';
  document.getElementById('stat-avg').textContent   = prices.length
    ? fmt(prices.reduce((a, b) => a + b, 0) / prices.length)
    : '—';
}

// ── Table ──────────────────────────────────────────────────────────────────

function buildColumns(data) {
  const hasCategory = data.some(r => r.category);
  const cols = [
    { title: 'Name',  field: 'name',  widthGrow: 3, headerSort: true },
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

// ── Filters ────────────────────────────────────────────────────────────────

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

// ── Charts ─────────────────────────────────────────────────────────────────

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
      datasets: [{ data: buckets.map(b => b.count), backgroundColor: '#3b82f6', borderRadius: 4 }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 40 } },
        y: { grid: { color: '#f1f5f9' }, ticks: { precision: 0 } },
      },
    },
  });
}

function categoryChart(data) {
  const cats = {};
  data.forEach(r => { if (r.category) cats[r.category] = (cats[r.category] || 0) + 1; });
  const labels = Object.keys(cats).sort();
  if (!labels.length) return;

  const palette = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4'];
  const ctx = document.getElementById('cat-chart').getContext('2d');
  if (catChart) catChart.destroy();
  catChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels.map(l => l.charAt(0).toUpperCase() + l.slice(1)),
      datasets: [{
        data: labels.map(l => cats[l]),
        backgroundColor: labels.map((_, i) => palette[i % palette.length]),
        borderRadius: 4,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: '#f1f5f9' }, ticks: { precision: 0 } },
      },
    },
  });
}

// ── Scrape ─────────────────────────────────────────────────────────────────

scrapeBtn.addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (!url) { urlInput.focus(); return; }

  // Reset UI
  scrapeBtn.disabled = true;
  hide(errorCard);
  hide(resultsEl);
  logEl.innerHTML = '';
  logSpinner.classList.remove('done');
  show(logCard);

  const es = new EventSource(`/api/scrape?url=${encodeURIComponent(url)}`);

  es.addEventListener('progress', (e) => {
    const { message, isError } = JSON.parse(e.data);
    appendLog(message, isError);
  });

  es.addEventListener('complete', (e) => {
    es.close();
    logSpinner.classList.add('done');

    const { products, downloadUrl: dl, siteName } = JSON.parse(e.data);
    allData = products;
    downloadUrl = dl;

    renderStats(products);
    populateCategoryFilter(products);
    renderTable(products);
    priceHistogram(products);
    categoryChart(products);

    catFilter.value = '';
    searchInput.value = '';

    downloadBtn.onclick = () => { window.location.href = downloadUrl; };
    downloadBtn.textContent = `Download ${siteName}.csv`;

    show(resultsEl);
    scrapeBtn.disabled = false;
  });

  es.addEventListener('error', (e) => {
    es.close();
    logSpinner.classList.add('done');
    scrapeBtn.disabled = false;

    try {
      const { message } = JSON.parse(e.data);
      errorMsg.textContent = message;
      show(errorCard);
    } catch {
      // SSE connection error (not a server-sent error event)
      if (!resultsEl.classList.contains('hidden')) return;
      errorMsg.textContent = 'Connection lost. Please try again.';
      show(errorCard);
    }
  });
});

// Allow pressing Enter in the URL field
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') scrapeBtn.click();
});
