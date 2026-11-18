#!/usr/bin/env node
'use strict';
/* Lightweight project checks, no dependencies. Node >= 18.

   Usage:  node tools/check.js

   1. Syntax-checks the inline <script> of scam-sentinel.html.
   2. Syntax-checks every .js file in tools/.
   3. Validates the shipped JSON files parse and that the IBM corpus has the
      expected shape (14 transfers per timeline, labels 0/1).
   Exits non-zero on the first category that fails. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;

function ok(message) { console.log(`  ok    ${message}`); }
function fail(message) { console.error(`  FAIL  ${message}`); failures++; }

console.log('scam-sentinel.html');
const html = fs.readFileSync(path.join(ROOT, 'scam-sentinel.html'), 'utf8');
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (inlineScripts.length === 0) fail('no inline <script> found');
inlineScripts.forEach((source, i) => {
  try { new vm.Script(source, { filename: `scam-sentinel.html#script${i}` }); ok(`inline script ${i} parses`); }
  catch (error) { fail(`inline script ${i}: ${error.message}`); }
});

console.log('tools/');
for (const file of fs.readdirSync(path.join(ROOT, 'tools')).filter(f => f.endsWith('.js'))) {
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, 'tools', file)], { stdio: 'pipe' }); ok(file); }
  catch (error) { fail(`${file}: ${String(error.stderr || error.message).trim()}`); }
}

console.log('training-data/');
const dataDir = path.join(ROOT, 'training-data');
for (const file of fs.readdirSync(dataDir).filter(f => f.endsWith('.json'))) {
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8')); }
  catch (error) { fail(`${file}: ${error.message}`); continue; }
  const timelines = Array.isArray(data) ? data : data.timelines;
  if (file.endsWith('-corpus.json') && Array.isArray(timelines)) {
    const bad = timelines.filter(t => !Array.isArray(t.transfers) || t.transfers.length !== 14 || ![0, 1].includes(t.label));
    if (bad.length) fail(`${file}: ${bad.length} of ${timelines.length} timelines malformed`);
    else ok(`${file}: ${timelines.length} timelines, 14 transfers each`);
  } else {
    ok(`${file} parses`);
  }
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
