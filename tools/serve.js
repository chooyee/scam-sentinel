#!/usr/bin/env node
'use strict';
/* Tiny static file server so scam-sentinel.html can fetch files from this folder.
   Browsers refuse fetch() from file:// pages, so "Load from path" needs http.

   Usage:  node tools/serve.js [port]        (default 8080)
   Then:   http://localhost:8080/scam-sentinel.html
           http://localhost:8080/scam-sentinel.html?corpus=training-data/ibm-aml-corpus.json
   Serves the project folder read-only, on localhost only. Ctrl+C to stop. */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2]) || 8080;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.normalize(path.join(ROOT, urlPath === '/' ? '/scam-sentinel.html' : urlPath));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Scam Sentinel: http://localhost:${PORT}/scam-sentinel.html`);
  console.log(`auto-load:     http://localhost:${PORT}/scam-sentinel.html?corpus=training-data/ibm-aml-corpus.json`);
  console.log(`serving ${ROOT} (read-only, localhost only). Ctrl+C to stop.`);
});
