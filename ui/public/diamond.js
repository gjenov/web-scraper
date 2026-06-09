/* global Tabulator, Chart */

// ── Tab switching ──────────────────────────────────────────────────
const _tabBtns    = document.querySelectorAll('.tab-btn');
const _scraperTab = document.getElementById('scraper-tab');
const _diamondTab = document.getElementById('diamond-tab');

_tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    _tabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (btn.dataset.tab === 'diamond') {
      _scraperTab.classList.add('hidden');
      _diamondTab.classList.remove('hidden');
      loadDiamondHistory();
    } else {
      _diamondTab.classList.add('hidden');
      _scraperTab.classList.remove('hidden');
    }
  });
});

// ── DOM refs ────────────────────────────────────────────────────────
const dSearchBtn      = document.getElementById('d-search-btn');
const dFullScrapeBtn  = document.getElementById('d-full-scrape-btn');
const dMatrixBtn      = document.getElementById('d-matrix-btn');
const dBatchStatus    = document.getElementById('d-batch-status');
const dMatrixStatus   = document.getElementById('d-matrix-status');
const dResetBtn       = document.getElementById('d-reset-btn');
const dLogCard      = document.getElementById('d-log-card');
const dLogEl        = document.getElementById('d-log');
const dLogSpinner   = document.getElementById('d-log-spinner');
const dLogTimer     = document.getElementById('d-log-timer');
const dLogCount     = document.getElementById('d-log-count');
const dErrorCard    = document.getElementById('d-error-card');
const dErrorMsg     = document.getElementById('d-error-msg');
const dResultsEl    = document.getElementById('d-results');
const dDownloadBtn  = document.getElementById('d-download-btn');
const dHistoryCard  = document.getElementById('d-history-card');
const dHistoryList  = document.getElementById('d-history-list');
const dHistoryTotal = document.getElementById('d-history-total');
const dSearchInput  = document.getElementById('d-search-input');
const dFilterStatus = document.getElementById('d-filter-status');

let dTable        = null;
let dCaratChart   = null;
let dColorChart   = null;
let dClarityChart = null;
let masterData    = [];   // full unfiltered loaded dataset
let dTimerInterval = null;

// ── Helpers ──────────────────────────────────────────────────────────
const dFmt = n => '$' + Math.round(n).toLocaleString('en-US');

function dShow(el) { el.classList.remove('hidden'); }
function dHide(el) { el.classList.add('hidden'); }

function startDTimer() {
  const start = Date.now();
  dLogTimer.textContent = '00:00';
  dTimerInterval = setInterval(() => {
    const s  = Math.floor((Date.now() - start) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    dLogTimer.textContent = `${mm}:${ss}`;
  }, 1000);
}
function stopDTimer() { clearInterval(dTimerInterval); dTimerInterval = null; }

const D_COUNT_RE = [
  /(\d+)\s+diamonds?\s+(?:total|match)/i,
  /Done\s*[—\-]\s*(\d+)\s+diamonds?\s+saved/i,
  /Fetched\s+(\d+)\s*\//i,
];
let _dMaxCount = 0;

function appendDLog(msg, isErr = false) {
  const div = document.createElement('div');
  div.className = 'line' + (isErr ? ' err' : '');
  div.textContent = msg;
  dLogEl.appendChild(div);
  dLogEl.scrollTop = dLogEl.scrollHeight;
  for (const re of D_COUNT_RE) {
    const m = msg.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > _dMaxCount) { _dMaxCount = n; dLogCount.textContent = `${n} found`; }
      break;
    }
  }
}

// ── Filter reading ────────────────────────────────────────────────────
function getCheckedVals(name) {
  return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(el => el.value);
}

function getGroupVals(group) {
  const btns = [...document.querySelectorAll(`.cb-group-pill[data-group="${group}"].selected`)];
  return btns.flatMap(b => b.dataset.values.split(','));
}

// ── Client-side filtering ─────────────────────────────────────────────
function applyFilters() {
  if (!masterData.length) return;

  const shapes    = getCheckedVals('d-shape').map(s => s.toLowerCase());
  const colors    = getGroupVals('color');
  const claritys  = getGroupVals('clarity');
  const cuts      = getCheckedVals('d-cut');
  const type      = document.querySelector('input[name="d-type"]:checked')?.value || 'all';
  const caratFrom = parseFloat(document.getElementById('d-carat-from').value) || null;
  const caratTo   = parseFloat(document.getElementById('d-carat-to').value)   || null;
  const priceFrom = parseFloat(document.getElementById('d-price-from').value) || null;
  const priceTo   = parseFloat(document.getElementById('d-price-to').value)   || null;
  const term      = dSearchInput.value.toLowerCase();

  const filtered = masterData.filter(r => {
    if (shapes.length   && !shapes.includes((r.shape || '').toLowerCase())) return false;
    if (colors.length   && !colors.includes(r.color))            return false;
    if (claritys.length && !claritys.includes(r.clarity))        return false;
    if (cuts.length     && !cuts.includes(r.cut))                return false;
    if (type !== 'all'  && r.natural_or_lab !== type)            return false;
    if (caratFrom != null && (isNaN(r.carat) || r.carat < caratFrom)) return false;
    if (caratTo   != null && (isNaN(r.carat) || r.carat > caratTo))   return false;
    if (priceFrom != null && (isNaN(r.price) || r.price < priceFrom)) return false;
    if (priceTo   != null && (isNaN(r.price) || r.price > priceTo))   return false;
    if (term && !Object.values(r).some(v => String(v).toLowerCase().includes(term))) return false;
    return true;
  });

  renderDTable(filtered);
  renderDStats(filtered);
  buildCaratHistogram(filtered);
  buildColorChart(filtered);
  buildClarityChart(filtered);

  dFilterStatus.textContent =
    `Showing ${filtered.length.toLocaleString()} of ${masterData.length.toLocaleString()} diamonds`;
  dShow(dFilterStatus);
}

// Wire every filter input to applyFilters
document.querySelectorAll(
  'input[name="d-shape"], input[name="d-cut"], input[name="d-type"]'
).forEach(el => el.addEventListener('change', applyFilters));

document.querySelectorAll('.cb-group-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.classList.toggle('selected');
    applyFilters();
  });
});

document.querySelectorAll('.carat-preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const isActive = btn.classList.contains('selected');
    document.querySelectorAll('.carat-preset-btn').forEach(b => b.classList.remove('selected'));
    if (!isActive) {
      btn.classList.add('selected');
      document.getElementById('d-carat-from').value = btn.dataset.from;
      document.getElementById('d-carat-to').value   = btn.dataset.to;
    } else {
      document.getElementById('d-carat-from').value = '';
      document.getElementById('d-carat-to').value   = '';
    }
    applyFilters();
  });
});

['d-carat-from', 'd-carat-to', 'd-price-from', 'd-price-to'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', () => {
    document.querySelectorAll('.carat-preset-btn').forEach(b => b.classList.remove('selected'));
    applyFilters();
  });
});

dSearchInput.addEventListener('input', applyFilters);

// Reset all filters → show full masterData
dResetBtn.addEventListener('click', () => {
  document.querySelectorAll('input[name="d-shape"], input[name="d-cut"]').forEach(el => { el.checked = false; });
  document.querySelectorAll('.cb-group-pill').forEach(btn => btn.classList.remove('selected'));
  document.querySelectorAll('.carat-preset-btn').forEach(btn => btn.classList.remove('selected'));
  document.querySelector('input[name="d-type"][value="all"]').checked = true;
  ['d-carat-from', 'd-carat-to', 'd-price-from', 'd-price-to'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  dSearchInput.value = '';
  applyFilters();
});

// ── Stats ─────────────────────────────────────────────────────────────
function renderDStats(data) {
  const prices = data.map(r => r.price).filter(p => !isNaN(p) && p != null);
  const minP = prices.length ? prices.reduce((m, v) => v < m ? v : m, Infinity)  : null;
  const maxP = prices.length ? prices.reduce((m, v) => v > m ? v : m, -Infinity) : null;
  const avgP = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
  document.getElementById('d-stat-count').textContent = data.length.toLocaleString();
  document.getElementById('d-stat-min').textContent   = minP != null ? dFmt(minP) : '—';
  document.getElementById('d-stat-max').textContent   = maxP != null ? dFmt(maxP) : '—';
  document.getElementById('d-stat-avg').textContent   = avgP != null ? dFmt(avgP) : '—';
}

// ── Table ─────────────────────────────────────────────────────────────
function buildDColumns() {
  return [
    { title: 'Shape',   field: 'shape',           widthGrow: 1, headerSort: true },
    { title: 'Carat',   field: 'carat',            widthGrow: 1, headerSort: true, sorter: 'number',
      formatter: cell => { const v = parseFloat(cell.getValue()); return isNaN(v) ? '—' : v.toFixed(2); } },
    { title: 'Color',   field: 'color',            widthGrow: 1, headerSort: true },
    { title: 'Clarity', field: 'clarity',          widthGrow: 1, headerSort: true },
    { title: 'Cut',     field: 'cut',              widthGrow: 1, headerSort: true },
    { title: 'Type',    field: 'natural_or_lab',   widthGrow: 1, headerSort: true },
    { title: 'Price',   field: 'price',            widthGrow: 1, headerSort: true, sorter: 'number',
      formatter: cell => { const v = parseFloat(cell.getValue()); return isNaN(v) ? '—' : dFmt(v); } },
    { title: 'Link', field: 'url', width: 72, headerSort: false,
      formatter: cell => {
        const url = cell.getValue();
        if (!url) return '<span style="color:#444">—</span>';
        return `<a href="${url}" target="_blank" rel="noopener noreferrer"
          style="color:var(--gold);text-decoration:none;font-size:0.8rem;font-weight:500;">View ↗</a>`;
      } },
  ];
}

function renderDTable(data) {
  if (dTable) {
    dTable.setData(data);
    return;
  }
  dTable = new Tabulator('#d-table', {
    data,
    columns: buildDColumns(),
    layout: 'fitColumns',
    pagination: 'local',
    paginationSize: 25,
    paginationSizeSelector: [10, 25, 50, 100],
    movableColumns: false,
    initialSort: [{ column: 'price', dir: 'asc' }],
    height: '420px',
  });
}

// ── Charts ────────────────────────────────────────────────────────────
const CLARITY_ORDER = ['FL','IF','VVS1','VVS2','VS1','VS2','SI1','SI2','I1','I2','I3'];
const COLOR_ORDER   = ['D','E','F','G','H','I','J','K','L','M'];
const D_PALETTE     = ['#d4a853','#a78bfa','#60a5fa','#34d399','#f472b6',
                       '#fb923c','#fb7185','#38bdf8','#4ade80','#facc15','#e879f9'];

function buildCaratHistogram(data) {
  const carats = data.map(r => r.carat).filter(v => v != null && !isNaN(v));
  if (carats.length < 2) return;

  const min  = carats.reduce((m, v) => v < m ? v : m, Infinity);
  const max  = carats.reduce((m, v) => v > m ? v : m, -Infinity);
  const BINS = Math.min(12, Math.max(5, Math.floor(carats.length / 10)));
  const step = (max - min) / BINS || 0.1;

  const buckets = Array.from({ length: BINS }, (_, i) => {
    const lo = min + i * step;
    return { lo, hi: lo + step, count: 0 };
  });
  carats.forEach(c => {
    const i = Math.min(Math.floor((c - min) / step), BINS - 1);
    buckets[i].count++;
  });

  const ctx = document.getElementById('d-carat-chart').getContext('2d');
  if (dCaratChart) dCaratChart.destroy();
  dCaratChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: buckets.map(b => b.lo.toFixed(2)),
      datasets: [{
        data: buckets.map(b => b.count),
        backgroundColor: 'rgba(212,168,83,0.55)',
        borderColor: '#d4a853',
        borderWidth: 1,
        borderRadius: 4,
        hoverBackgroundColor: 'rgba(212,168,83,0.85)',
      }],
    },
    options: {
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          title: ([item]) => { const b = buckets[item.dataIndex]; return `${b.lo.toFixed(2)} – ${b.hi.toFixed(2)} ct`; },
          label: item => ` ${item.raw} diamond${item.raw !== 1 ? 's' : ''}`,
        }},
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 35 } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { precision: 0 } },
      },
    },
  });
}

function buildColorChart(data) {
  const counts = {};
  data.forEach(r => { if (r.color) counts[r.color] = (counts[r.color] || 0) + 1; });
  const labels = COLOR_ORDER.filter(c => counts[c]);
  if (!labels.length) return;

  const ctx = document.getElementById('d-color-chart').getContext('2d');
  if (dColorChart) dColorChart.destroy();
  dColorChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: labels.map(c => counts[c]),
        backgroundColor: labels.map((_, i) => D_PALETTE[i % D_PALETTE.length] + 'cc'),
        borderColor:     labels.map((_, i) => D_PALETTE[i % D_PALETTE.length]),
        borderWidth: 1.5,
        hoverOffset: 6,
      }],
    },
    options: {
      cutout: '62%',
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 10, color: '#8a8899', boxWidth: 12 } },
        tooltip: { callbacks: { label: item => `  ${item.raw} diamonds` } },
      },
    },
  });
}

function buildClarityChart(data) {
  const counts = {};
  data.forEach(r => { if (r.clarity) counts[r.clarity] = (counts[r.clarity] || 0) + 1; });
  const labels = CLARITY_ORDER.filter(c => counts[c]);
  if (!labels.length) return;

  const ctx = document.getElementById('d-clarity-chart').getContext('2d');
  if (dClarityChart) dClarityChart.destroy();
  dClarityChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: labels.map(c => counts[c]),
        backgroundColor: labels.map((_, i) => D_PALETTE[i % D_PALETTE.length] + '99'),
        borderColor:     labels.map((_, i) => D_PALETTE[i % D_PALETTE.length]),
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: item => ` ${item.raw} diamonds` } },
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { precision: 0 } },
        y: { grid: { display: false } },
      },
    },
  });
}

// ── Load results into masterData ──────────────────────────────────────
function loadIntoMaster(products, filename) {
  masterData = products;

  dHide(dErrorCard);
  dShow(dResultsEl);

  dDownloadBtn.textContent = 'Download Filtered CSV';

  applyFilters();
}

// ── History ───────────────────────────────────────────────────────────
let activeDHistoryFile = null;

async function selectDHistory(filename, itemEl) {
  dHistoryList.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));
  itemEl.classList.add('active');
  activeDHistoryFile = filename;
  try {
    const { products } = await fetch(`/api/results/${encodeURIComponent(filename)}`).then(r => r.json());
    products.forEach(r => { r.price = parseFloat(r.price); r.carat = parseFloat(r.carat); });
    loadIntoMaster(products, filename);
  } catch (e) {
    dErrorMsg.textContent = 'Failed to load: ' + e.message;
    dShow(dErrorCard);
  }
}

async function deleteDHistory(filename, itemEl) {
  try {
    await fetch(`/api/results/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    itemEl.remove();
    if (filename === activeDHistoryFile) { dHide(dResultsEl); activeDHistoryFile = null; masterData = []; }
    const remaining = dHistoryList.querySelectorAll('.history-item').length;
    if (remaining === 0) { dHide(dHistoryCard); } else {
      dHistoryTotal.textContent = `${remaining} file${remaining !== 1 ? 's' : ''}`;
    }
  } catch (e) {
    dErrorMsg.textContent = 'Failed to delete: ' + e.message;
    dShow(dErrorCard);
  }
}

async function loadDiamondHistory() {
  try {
    const results = await fetch('/api/results').then(r => r.json());
    const diamonds = results.filter(r => r.filename.startsWith('diamonds_'));
    if (!diamonds.length) { dHide(dHistoryCard); return; }

    dShow(dHistoryCard);
    dHistoryTotal.textContent = `${diamonds.length} file${diamonds.length !== 1 ? 's' : ''}`;
    dHistoryList.innerHTML = '';

    diamonds.forEach(r => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.dataset.filename = r.filename;

      const date    = new Date(r.timestamp);
      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

      item.innerHTML = `
        <div class="history-item-main">
          <span class="history-site">${r.url || 'Blue Nile search'}</span>
          <span class="history-meta">${dateStr} · ${timeStr}</span>
        </div>
        <div class="history-item-right">
          <span class="history-badge">${r.count} diamonds</span>
          <span class="history-arrow">→</span>
          <button class="history-delete" title="Delete" aria-label="Delete">✕</button>
        </div>`;

      item.querySelector('.history-delete').addEventListener('click', e => {
        e.stopPropagation();
        deleteDHistory(r.filename, item);
      });
      item.addEventListener('click', () => selectDHistory(r.filename, item));
      dHistoryList.appendChild(item);
    });
  } catch {}
}

// ── Download filtered CSV via Tabulator ───────────────────────────────
dDownloadBtn.addEventListener('click', () => {
  if (!dTable) return;
  dTable.download('csv', `diamonds_filtered_${Date.now()}.csv`);
});

function disableActionBtns()  { dSearchBtn.disabled = dFullScrapeBtn.disabled = dMatrixBtn.disabled = true; }
function enableActionBtns()   { dSearchBtn.disabled = dFullScrapeBtn.disabled = dMatrixBtn.disabled = false; }

// ── Full catalog scrape ───────────────────────────────────────────────
function startFullScrape() {
  const p = buildScrapeParams();

  disableActionBtns();
  dHide(dErrorCard);
  dHide(dResultsEl);
  dHide(dFilterStatus);
  dLogEl.innerHTML = '';
  dLogCount.textContent = '';
  _dMaxCount = 0;
  dLogSpinner.classList.remove('done');
  dShow(dLogCard);
  startDTimer();

  dBatchStatus.textContent = 'Discovering buckets…';
  dBatchStatus.classList.add('active');
  dShow(dBatchStatus);

  const qs = new URLSearchParams();
  if (p.shape)     qs.set('shape',     p.shape);
  if (p.caratFrom) qs.set('caratFrom', p.caratFrom);
  if (p.caratTo)   qs.set('caratTo',   p.caratTo);
  if (p.color)     qs.set('color',     p.color);
  if (p.clarity)   qs.set('clarity',   p.clarity);
  if (p.cut)       qs.set('cut',       p.cut);
  qs.set('type', p.type);

  const es = new EventSource(`/api/diamond-scrape-all?${qs.toString()}`);

  es.addEventListener('progress', e => {
    const { message, isError } = JSON.parse(e.data);
    appendDLog(message, isError);
  });

  es.addEventListener('batch-progress', e => {
    const { bucket, total, collected } = JSON.parse(e.data);
    dBatchStatus.textContent = `Bucket ${bucket} / ${total} — ${collected.toLocaleString()} diamonds`;
    dLogCount.textContent = `${collected.toLocaleString()} found`;
  });

  es.addEventListener('complete', e => {
    es.close();
    stopDTimer();
    dLogSpinner.classList.add('done');
    dBatchStatus.classList.remove('active');
    try {
      const { products, downloadUrl: dl } = JSON.parse(e.data);
      const filename = dl.replace('/download/', '');
      products.forEach(r => { r.price = parseFloat(r.price); r.carat = parseFloat(r.carat); });
      loadIntoMaster(products, filename);
      loadDiamondHistory();
    } catch (err) {
      dErrorMsg.textContent = 'Scrape complete — display error: ' + err.message + '. Load from history.';
      dShow(dErrorCard);
    } finally {
      enableActionBtns();
    }
  });

  es.addEventListener('error', e => {
    es.close();
    stopDTimer();
    dLogSpinner.classList.add('done');
    dBatchStatus.textContent = 'Interrupted — retry to resume';
    dBatchStatus.classList.remove('active');
    try {
      const { message } = JSON.parse(e.data);
      dErrorMsg.textContent = message;
      dShow(dErrorCard);
    } catch {
      if (!dResultsEl.classList.contains('hidden')) return;
      dErrorMsg.textContent = 'Connection lost. Please try again.';
      dShow(dErrorCard);
    } finally {
      enableActionBtns();
    }
  });
}

dFullScrapeBtn.addEventListener('click', startFullScrape);

// ── Price matrix scrape ───────────────────────────────────────────────
function startMatrixScrape() {
  const p = buildScrapeParams();

  disableActionBtns();
  dHide(dErrorCard);
  dHide(dResultsEl);
  dHide(dFilterStatus);
  dLogEl.innerHTML = '';
  dLogCount.textContent = '';
  _dMaxCount = 0;
  dLogSpinner.classList.remove('done');
  dShow(dLogCard);
  startDTimer();

  dMatrixStatus.textContent = 'Building combos…';
  dMatrixStatus.classList.add('active');
  dShow(dMatrixStatus);

  const qs = new URLSearchParams();
  if (p.shape)   qs.set('shape',   p.shape);
  if (p.cut)     qs.set('cut',     p.cut);
  qs.set('type', p.type);

  const es = new EventSource(`/api/diamond-matrix?${qs.toString()}`);

  es.addEventListener('progress', e => {
    const { message, isError } = JSON.parse(e.data);
    appendDLog(message, isError);
  });

  es.addEventListener('matrix-progress', e => {
    const { done, total } = JSON.parse(e.data);
    dMatrixStatus.textContent = `${done.toLocaleString()} / ${total.toLocaleString()} combos`;
    dLogCount.textContent = `${done.toLocaleString()} done`;
  });

  es.addEventListener('complete', e => {
    es.close();
    stopDTimer();
    dLogSpinner.classList.add('done');
    dMatrixStatus.classList.remove('active');
    try {
      const { products, downloadUrl: dl } = JSON.parse(e.data);
      const filename = dl.replace('/download/', '');
      products.forEach(r => { r.price = parseFloat(r.price); r.carat = parseFloat(r.carat); });
      loadIntoMaster(products, filename);
      loadDiamondHistory();
    } catch (err) {
      dErrorMsg.textContent = 'Matrix complete — display error: ' + err.message + '. Load from history.';
      dShow(dErrorCard);
    } finally {
      enableActionBtns();
    }
  });

  es.addEventListener('error', e => {
    es.close();
    stopDTimer();
    dLogSpinner.classList.add('done');
    dMatrixStatus.classList.remove('active');
    try {
      const { message } = JSON.parse(e.data);
      dErrorMsg.textContent = message;
      dShow(dErrorCard);
    } catch {
      if (!dResultsEl.classList.contains('hidden')) return;
      dErrorMsg.textContent = 'Connection lost. Please try again.';
      dShow(dErrorCard);
    } finally {
      enableActionBtns();
    }
  });
}

dMatrixBtn.addEventListener('click', startMatrixScrape);

// ── Scrape ────────────────────────────────────────────────────────────
function buildScrapeParams() {
  return {
    shape:     getCheckedVals('d-shape').join(','),
    color:     getGroupVals('color').join(','),
    clarity:   getGroupVals('clarity').join(','),
    cut:       getCheckedVals('d-cut').join(','),
    caratFrom: document.getElementById('d-carat-from').value,
    caratTo:   document.getElementById('d-carat-to').value,
    type:      (() => {
      const v = document.querySelector('input[name="d-type"]:checked')?.value || 'all';
      return v === 'all' ? 'natural' : v;  // API needs a concrete type
    })(),
  };
}

dSearchBtn.addEventListener('click', () => {
  const p = buildScrapeParams();

  disableActionBtns();
  dHide(dErrorCard);
  dHide(dResultsEl);
  dHide(dFilterStatus);
  dLogEl.innerHTML = '';
  dLogCount.textContent = '';
  _dMaxCount = 0;
  dLogSpinner.classList.remove('done');
  dShow(dLogCard);
  startDTimer();

  const qs = new URLSearchParams();
  if (p.shape)     qs.set('shape',     p.shape);
  if (p.caratFrom) qs.set('caratFrom', p.caratFrom);
  if (p.caratTo)   qs.set('caratTo',   p.caratTo);
  if (p.color)     qs.set('color',     p.color);
  if (p.clarity)   qs.set('clarity',   p.clarity);
  if (p.cut)       qs.set('cut',       p.cut);
  qs.set('type', p.type);

  const es = new EventSource(`/api/diamond-search?${qs.toString()}`);

  es.addEventListener('progress', e => {
    const { message, isError } = JSON.parse(e.data);
    appendDLog(message, isError);
  });

  es.addEventListener('complete', e => {
    es.close();
    stopDTimer();
    dLogSpinner.classList.add('done');
    try {
      const { products, downloadUrl: dl } = JSON.parse(e.data);
      const filename = dl.replace('/download/', '');
      products.forEach(r => { r.price = parseFloat(r.price); r.carat = parseFloat(r.carat); });
      loadIntoMaster(products, filename);
      loadDiamondHistory();
    } catch (err) {
      dErrorMsg.textContent = 'Results loaded — display error: ' + err.message;
      dShow(dErrorCard);
    } finally {
      enableActionBtns();
    }
  });

  es.addEventListener('error', e => {
    es.close();
    stopDTimer();
    dLogSpinner.classList.add('done');
    try {
      const { message } = JSON.parse(e.data);
      dErrorMsg.textContent = message;
      dShow(dErrorCard);
    } catch {
      if (!dResultsEl.classList.contains('hidden')) return;
      dErrorMsg.textContent = 'Connection lost. Please try again.';
      dShow(dErrorCard);
    } finally {
      enableActionBtns();
    }
  });
});
