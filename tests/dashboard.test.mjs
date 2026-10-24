// tests/dashboard.test.mjs — the local dashboard serves data from the existing
// files and logic, writes only the URL inbox, and refuses non-local requests.
//
// Run:  node --test tests/dashboard.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createDashboard } from '../dashboard.mjs';

let root, server, base;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'dashboard-test-'));
  for (const dir of ['data', 'reports', 'output']) mkdirSync(join(root, dir));
  writeFileSync(join(root, 'cv.md'), '# CV\n\n## Work Experience\n\n### Acme -- Remote\n\n- Built the search ranking service with learning-to-rank models\n');
  writeFileSync(join(root, 'data', 'applications.md'),
    '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n'
    + '| 1 | 2026-10-01 | Acme | Search Engineer | 4.3/5 | Evaluated | ❌ | [001](../reports/001-acme-2026-10-01.md) | |\n'
    + '| 2 | 2026-10-02 | Globex | Data Analyst | 2.8/5 | SKIP | ❌ | — | |\n');
  writeFileSync(join(root, 'reports', '001-acme-2026-10-01.md'), '# Evaluation: Acme -- Search Engineer\n\n**Score:** 4.3/5\n**URL:** https://jobs.example.com/acme/1\n**Legitimacy:** High Confidence\n');
  writeFileSync(join(root, 'data', 'pipeline.md'), '# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/first | Initech | Engineer\n\n## Processed\n\n- [x] #1 | https://jobs.example.com/acme/1 | Acme | Search Engineer | 4.3/5 | PDF ❌\n');
  writeFileSync(join(root, 'output', 'cv-edits-jane-acme-2026-10-03.md'),
    '# Resume edits — Acme, Search Engineer\n\n| Original text | Replacement text | Justification | Where |\n|---|---|---|---|\n'
    + '| Built the search ranking service with learning-to-rank models | Built the search ranking service using learning-to-rank models | JD wording | Work Experience › Acme › bullet 1 |\n'
    + '| Invented line not in the cv | Something | x | y |\n');
  server = createDashboard({ root });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

const get = (path, headers) => fetch(base + path, { headers });
// fetch() will not send a custom Host header, so spoof it with a raw request.
const getWithHost = (path, host) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: server.address().port, path, headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
});
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('serves the page', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /career-ops/);
});

test('job scores come from the tracker, with the report file resolved', async () => {
  const { jobs } = await (await get('/api/jobs')).json();
  assert.deepEqual(jobs.map((j) => [j.company, j.score, j.status]), [['Acme', 4.3, 'Evaluated'], ['Globex', 2.8, 'SKIP']]);
  assert.equal(jobs[0].report, '001-acme-2026-10-01.md');
  assert.equal(jobs[1].report, null);
});

test('a report is returned with its header fields', async () => {
  const report = await (await get('/api/report/1')).json();
  assert.equal(report.score, '4.3/5');
  assert.equal(report.legitimacy, 'High Confidence');
  assert.equal((await get('/api/report/2')).status, 404);
});

test('edit tables show per-row verification against cv.md', async () => {
  const data = await (await get('/api/improvements/cv-edits-jane-acme-2026-10-03.md')).json();
  assert.deepEqual(data.rows.map((r) => r.ok), [true, false]);
  assert.equal((await get('/api/improvements/..%2Fcv.md')).status, 404);
});

test('import adds new links to Pending and skips duplicates and bad input', async () => {
  const res = await (await post('/api/import', { links: 'https://jobs.example.com/new\nhttps://jobs.example.com/first\nhttps://jobs.example.com/acme/1\nnot-a-url\nftp://x.example/y' })).json();
  assert.deepEqual(res.added, ['https://jobs.example.com/new']);
  assert.equal(res.skipped.length, 4);
  const file = readFileSync(join(root, 'data', 'pipeline.md'), 'utf-8');
  assert.match(file, /## Pending\n\n- \[ \] https:\/\/jobs\.example\.com\/first[^\n]*\n- \[ \] https:\/\/jobs\.example\.com\/new\n\n## Processed/);
  const { items } = await (await get('/api/pipeline')).json();
  assert.deepEqual(items.map((i) => [i.section, i.state]), [['pending', 'pending'], ['pending', 'pending'], ['processed', 'done']]);
});

test('import creates the inbox when it does not exist', async () => {
  rmSync(join(root, 'data', 'pipeline.md'));
  await post('/api/import', { links: 'https://jobs.example.com/solo' });
  assert.match(readFileSync(join(root, 'data', 'pipeline.md'), 'utf-8'), /## Pending\n\n- \[ \] https:\/\/jobs\.example\.com\/solo/);
});

test('requests that are not local or not JSON are refused', async () => {
  assert.equal(await getWithHost('/api/jobs', 'evil.example'), 403);
  assert.equal((await get('/api/jobs', { Origin: 'http://evil.example' })).status, 403);
  const form = await fetch(base + '/api/import', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 415);
  assert.equal((await post('/api/run', { action: 'rm -rf' })).status, 400);
});
