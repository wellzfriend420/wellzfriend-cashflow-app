// Synthetic in-memory API for local visual verification; never a production server.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createBackend } = require('../tests/helpers.cjs');
const root = path.resolve(__dirname, '..');
const backend = createBackend();
backend.post({ action: 'saveReceivable', id: 'sample', partner: '検証用取引先', invoiceDate: '2026-09-01', amount: 500, dueDate: '2026-09-30', account: 'a' });
const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'],
  '/assets/app.js': ['assets/app.js', 'application/javascript'], '/assets/cashflow-math.js': ['assets/cashflow-math.js', 'application/javascript'], '/assets/styles.css': ['assets/styles.css', 'text/css'] };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/api') {
      let result;
      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 100000) throw new Error('Payload too large'); }
        result = backend.post(JSON.parse(body));
      } else result = backend.get(url.searchParams.get('action'), Object.fromEntries(url.searchParams));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result)); return;
    }
    const file = files[url.pathname];
    if (!file) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8' }); res.end(fs.readFileSync(path.join(root, file[0])));
  } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
});
server.listen(8769, '127.0.0.1', () => console.log('Synthetic preview: http://127.0.0.1:8769 (in-memory data only)'));
