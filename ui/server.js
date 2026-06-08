const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { parse } = require('csv-parse/sync');

const app = express();
const PORT = 3001;

const SCRAPER_DIR = path.join(__dirname, '..');
const PYTHON = path.join(SCRAPER_DIR, '.venv/bin/python');
const OUTPUT_DIR = path.join(SCRAPER_DIR, 'output');

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

function siteNameFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host.split('.')[0];
  } catch {
    return 'products';
  }
}

app.get('/api/scrape', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const siteName = siteNameFromUrl(url);
  const outputPath = path.join(OUTPUT_DIR, `${siteName}_${Date.now()}.csv`);

  send('progress', { message: `Starting scrape for ${url}` });

  const proc = spawn(PYTHON, ['-u', 'main.py', '--url', url, '--output', outputPath], {
    cwd: SCRAPER_DIR,
  });

  proc.stdout.on('data', (chunk) => {
    chunk.toString().split('\n').filter(l => l.trim()).forEach(line => {
      send('progress', { message: line });
    });
  });

  proc.stderr.on('data', (chunk) => {
    chunk.toString().split('\n').filter(l => l.trim()).forEach(line => {
      send('progress', { message: line, isError: true });
    });
  });

  proc.on('close', (code) => {
    if (code !== 0 || !fs.existsSync(outputPath)) {
      send('error', { message: 'Scrape failed. Check the URL and try again.' });
      return res.end();
    }

    try {
      const csvText = fs.readFileSync(outputPath, 'utf8');
      const records = parse(csvText, { columns: true, skip_empty_lines: true });
      records.forEach(r => { r.price = parseFloat(r.price); });

      const filename = path.basename(outputPath);
      const metaPath = outputPath + '.meta.json';
      fs.writeFileSync(metaPath, JSON.stringify({ url, siteName }));
      send('complete', {
        products: records,
        downloadUrl: `/download/${filename}`,
        siteName,
        url,
      });
    } catch (e) {
      send('error', { message: 'Failed to parse results: ' + e.message });
    }
    res.end();
  });

  req.on('close', () => { try { proc.kill(); } catch {} });
});

app.get('/api/diamond-search', (req, res) => {
  const { shape, caratFrom, caratTo, color, clarity, cut, type } = req.query;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const timestamp = Date.now();
  const outputPath = path.join(OUTPUT_DIR, `diamonds_bluenile_${timestamp}.csv`);

  const args = ['-u', 'diamond_main.py', '--output', outputPath];
  if (shape) args.push('--shape', ...shape.split(',').map(s => s.trim()).filter(Boolean));
  if (caratFrom) args.push('--carat-from', caratFrom);
  if (caratTo) args.push('--carat-to', caratTo);
  if (color) args.push('--color', ...color.split(',').map(s => s.trim()).filter(Boolean));
  if (clarity) args.push('--clarity', ...clarity.split(',').map(s => s.trim()).filter(Boolean));
  if (cut) args.push('--cut', ...cut.split(',').map(s => s.trim()).filter(Boolean));
  if (type) args.push('--type', type);

  send('progress', { message: `Starting Blue Nile diamond search...` });
  if (shape) send('progress', { message: `Shapes: ${shape}` });
  if (caratFrom || caratTo) send('progress', { message: `Carat: ${caratFrom || '0'} – ${caratTo || '∞'}` });
  if (color) send('progress', { message: `Color: ${color}` });
  if (clarity) send('progress', { message: `Clarity: ${clarity}` });
  if (cut) send('progress', { message: `Cut: ${cut}` });
  send('progress', { message: `Type: ${type || 'natural'}` });

  const proc = spawn(PYTHON, args, { cwd: SCRAPER_DIR });

  proc.stdout.on('data', (chunk) => {
    chunk.toString().split('\n').filter(l => l.trim()).forEach(line => {
      send('progress', { message: line });
    });
  });

  proc.stderr.on('data', (chunk) => {
    chunk.toString().split('\n').filter(l => l.trim()).forEach(line => {
      send('progress', { message: line, isError: true });
    });
  });

  proc.on('close', (code) => {
    if (code !== 0 || !fs.existsSync(outputPath)) {
      send('error', { message: 'Diamond search failed. Check parameters and try again.' });
      return res.end();
    }

    try {
      const csvText = fs.readFileSync(outputPath, 'utf8');
      const records = parse(csvText, { columns: true, skip_empty_lines: true });
      records.forEach(r => {
        r.price = parseFloat(r.price);
        r.carat = parseFloat(r.carat);
      });

      const filename = path.basename(outputPath);
      const parts = [
        shape   ? `Shapes: ${shape}`                              : null,
        (caratFrom || caratTo) ? `Carat: ${caratFrom||''}–${caratTo||''}` : null,
        color   ? `Color: ${color}`                               : null,
        clarity ? `Clarity: ${clarity}`                           : null,
        cut     ? `Cut: ${cut}`                                   : null,
        `Type: ${type || 'natural'}`,
      ].filter(Boolean);
      fs.writeFileSync(outputPath + '.meta.json', JSON.stringify({
        url: parts.join(' | '),
        siteName: 'diamonds_bluenile',
        searchParams: { shape, caratFrom, caratTo, color, clarity, cut, type },
      }));

      send('complete', {
        products: records,
        downloadUrl: `/download/${filename}`,
        siteName: 'diamonds_bluenile',
      });
    } catch (e) {
      send('error', { message: 'Failed to parse results: ' + e.message });
    }
    res.end();
  });

  req.on('close', () => { try { proc.kill(); } catch {} });
});

app.get('/api/diamond-scrape-all', (req, res) => {
  const { shape, caratFrom, caratTo, color, clarity, cut, type, resume } = req.query;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const timestamp = Date.now();
  const outputPath = path.join(OUTPUT_DIR, `diamonds_bluenile_full_${timestamp}.csv`);

  const args = ['-u', 'diamond_main.py', '--output', outputPath, '--full-scrape'];
  if (resume === 'true') args.push('--resume');
  if (shape)   args.push('--shape',   ...shape.split(',').map(s => s.trim()).filter(Boolean));
  if (caratFrom) args.push('--carat-from', caratFrom);
  if (caratTo)   args.push('--carat-to',   caratTo);
  if (color)   args.push('--color',   ...color.split(',').map(s => s.trim()).filter(Boolean));
  if (clarity) args.push('--clarity', ...clarity.split(',').map(s => s.trim()).filter(Boolean));
  if (cut)     args.push('--cut',     ...cut.split(',').map(s => s.trim()).filter(Boolean));
  if (type)    args.push('--type',    type);

  send('progress', { message: 'Starting full catalog scrape...' });
  if (shape)   send('progress', { message: `Shapes: ${shape}` });
  if (caratFrom || caratTo) send('progress', { message: `Carat: ${caratFrom || '0'} – ${caratTo || '∞'}` });
  if (color)   send('progress', { message: `Color: ${color}` });
  if (clarity) send('progress', { message: `Clarity: ${clarity}` });
  if (cut)     send('progress', { message: `Cut: ${cut}` });
  send('progress', { message: `Type: ${type || 'natural'}` });

  const proc = spawn(PYTHON, args, { cwd: SCRAPER_DIR });

  proc.stdout.on('data', (chunk) => {
    chunk.toString().split('\n').filter(l => l.trim()).forEach(line => {
      const batchMatch = line.match(/^BATCH:(\d+)\/(\d+)\s*[—\-]\s*([\d,]+)\s+diamonds/);
      if (batchMatch) {
        send('batch-progress', {
          message:   line,
          bucket:    parseInt(batchMatch[1]),
          total:     parseInt(batchMatch[2]),
          collected: parseInt(batchMatch[3].replace(/,/g, '')),
        });
      } else {
        send('progress', { message: line });
      }
    });
  });

  proc.stderr.on('data', (chunk) => {
    chunk.toString().split('\n').filter(l => l.trim()).forEach(line => {
      send('progress', { message: line, isError: true });
    });
  });

  proc.on('close', (code) => {
    if (code !== 0 || !fs.existsSync(outputPath)) {
      send('error', { message: 'Full catalog scrape failed. Retry with same filters to resume.' });
      return res.end();
    }

    try {
      const csvText = fs.readFileSync(outputPath, 'utf8');
      const records = parse(csvText, { columns: true, skip_empty_lines: true });
      records.forEach(r => {
        r.price = parseFloat(r.price);
        r.carat = parseFloat(r.carat);
      });

      const filename = path.basename(outputPath);
      const parts = [
        shape   ? `Shapes: ${shape}` : null,
        (caratFrom || caratTo) ? `Carat: ${caratFrom||''}–${caratTo||''}` : null,
        color   ? `Color: ${color}`   : null,
        clarity ? `Clarity: ${clarity}` : null,
        cut     ? `Cut: ${cut}`       : null,
        `Type: ${type || 'natural'} | Full Catalog`,
      ].filter(Boolean);
      fs.writeFileSync(outputPath + '.meta.json', JSON.stringify({
        url: parts.join(' | '),
        siteName: 'diamonds_bluenile_full',
        searchParams: { shape, caratFrom, caratTo, color, clarity, cut, type },
      }));

      const totalCount = records.length;
      const truncated  = totalCount > MAX_TABLE_ROWS;
      send('complete', {
        products:   truncated ? records.slice(0, MAX_TABLE_ROWS) : records,
        truncated,
        totalCount,
        downloadUrl: `/download/${filename}`,
        siteName: 'diamonds_bluenile_full',
      });
    } catch (e) {
      send('error', { message: 'Failed to parse results: ' + e.message });
    }
    res.end();
  });

  req.on('close', () => { try { proc.kill(); } catch {} });
});

app.get('/api/results', (req, res) => {
  if (!fs.existsSync(OUTPUT_DIR)) return res.json([]);
  try {
    const files = fs.readdirSync(OUTPUT_DIR)
      .filter(f => f.endsWith('.csv') && !f.startsWith('.'))
      .map(f => {
        const filepath = path.join(OUTPUT_DIR, f);
        const stat = fs.statSync(filepath);
        const match = f.match(/^(.+)_(\d+)\.csv$/);
        const site = match ? match[1] : f.replace('.csv', '');
        const timestamp = match ? parseInt(match[2]) : stat.mtimeMs;
        let count = 0;
        try {
          const lines = fs.readFileSync(filepath, 'utf8').split('\n').filter(l => l.trim());
          count = Math.max(0, lines.length - 1);
        } catch {}
        let url = null;
        try {
          const meta = JSON.parse(fs.readFileSync(filepath + '.meta.json', 'utf8'));
          url = meta.url || null;
        } catch {}
        return { filename: f, site, url, timestamp, count };
      })
      .sort((a, b) => b.timestamp - a.timestamp);
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const MAX_TABLE_ROWS = 10_000;

app.get('/api/results/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!filename.endsWith('.csv')) return res.status(400).json({ error: 'Invalid file' });
  const file = path.join(OUTPUT_DIR, filename);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  try {
    const csvText = fs.readFileSync(file, 'utf8');
    const records = parse(csvText, { columns: true, skip_empty_lines: true });
    records.forEach(r => {
      r.price = parseFloat(r.price);
      if (r.carat !== undefined) r.carat = parseFloat(r.carat);
    });
    const totalCount = records.length;
    const truncated  = totalCount > MAX_TABLE_ROWS;
    res.json({
      products:   truncated ? records.slice(0, MAX_TABLE_ROWS) : records,
      truncated,
      totalCount,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/results/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!filename.endsWith('.csv')) return res.status(400).json({ error: 'Invalid file' });
  const file = path.join(OUTPUT_DIR, filename);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  try {
    fs.unlinkSync(file);
    try { fs.unlinkSync(file + '.meta.json'); } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/download/:filename', (req, res) => {
  // Prevent path traversal
  const filename = path.basename(req.params.filename);
  const file = path.join(OUTPUT_DIR, filename);
  if (!fs.existsSync(file)) return res.status(404).send('Not found');
  res.download(file, `${filename}`);
});

app.listen(PORT, () => {
  console.log(`Jewelry Scraper UI → http://localhost:${PORT}`);
});
