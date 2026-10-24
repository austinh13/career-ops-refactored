#!/usr/bin/env node

/**
 * dashboard.mjs — local-only web dashboard over career-ops' existing files and scripts.
 *
 * Three views, all read from the same sources the CLI modes use:
 *   Import   data/pipeline.md (the URL inbox), deduplicated against the tracker
 *   Scores   the tracker (tracker-parse.mjs) and the evaluation reports in reports/
 *   Resume   the `improve` edit tables in output/cv-edits-*.md, checked by verify-edit-table.mjs
 * Grading and resume improvement are run by the user's agent CLI, exactly as
 * AGENTS.md describes; the dashboard only starts that CLI and shows its log.
 *
 * It binds to 127.0.0.1 and rejects requests whose Host or Origin is not local.
 *
 * Usage:
 *   node dashboard.mjs [--port 4173]
 */

import http from 'http';
import { spawn, spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isMainModule } from './lib/is-main-module.mjs';
import { atomicWriteFile } from './lib/atomic-write.mjs';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { parseTrackerRow, resolveColumns, parseScore } from './tracker-parse.mjs';
import { sectionKind } from './lib/pipeline-sections.mjs';
import { normalizeUrl } from './url-key.mjs';
import { parseEditTable, verifyEditTable } from './verify-edit-table.mjs';
import { readRememberedCli } from './lib/agent-cli.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 4173;
const MAX_BODY = 256 * 1024;
const MAX_LOG_LINES = 400;

// Headless invocation per CLI, from AGENTS.md → Headless / Batch Mode.
const AGENT_RUNNERS = {
  claude: { bin: 'claude', args: (p) => ['-p', p] },
  codex: { bin: 'codex', args: (p) => ['exec', p] },
  opencode: { bin: 'opencode', args: (p) => ['run', p] },
  pi: { bin: 'pi', args: (p) => ['-p', p] },
  copilot: { bin: 'copilot', args: (p) => ['-p', p] },
  qwen: { bin: 'qwen', args: (p) => ['-p', p] },
  antigravity: { bin: 'agy', args: (p) => ['-p', p] },
  grok: { bin: 'grok', args: (p) => ['-p', p] },
};

const onPath = (bin) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }).status === 0;

/** The runner for the CLI the user chose (CAREER_OPS_CLI), else the first installed one. */
function resolveRunner(root) {
  const chosen = readRememberedCli(root);
  const name = AGENT_RUNNERS[chosen] ? chosen : Object.keys(AGENT_RUNNERS).find((key) => onPath(AGENT_RUNNERS[key].bin));
  return name ? { name, ...AGENT_RUNNERS[name] } : null;
}

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf-8') : '');

/* ---------- data readers (existing logic) ---------- */

function readTracker(root) {
  const lines = read(resolveTrackerPath(root)).split(/\r?\n/);
  const colmap = resolveColumns(lines);
  return lines.map((line) => parseTrackerRow(line, colmap)).filter(Boolean).map((row) => ({
    num: row.num,
    date: row.date,
    company: row.company,
    role: row.role,
    score: parseScore(row.score),
    scoreText: row.score,
    status: row.status,
    pdf: row.pdf,
    notes: row.notes,
    url: row.url,
    report: reportFileFor(root, row.num),
  }));
}

function reportFileFor(root, num) {
  const dir = join(root, 'reports');
  if (!existsSync(dir)) return null;
  const prefix = String(num).padStart(3, '0') + '-';
  return readdirSync(dir).find((name) => name.startsWith(prefix) && name.endsWith('.md')) ?? null;
}

function parsePipeline(root) {
  const items = [];
  let kind = null;
  for (const line of read(join(root, 'data', 'pipeline.md')).split(/\r?\n/)) {
    const heading = sectionKind(line);
    if (heading) { kind = heading; continue; }
    const m = /^- \[( |x|X|!)\]\s+(.*)$/.exec(line);
    if (!m || !kind) continue;
    const url = /https?:\/\/[^\s|]+/.exec(m[2])?.[0] ?? '';
    const detail = m[2].split('|').map((part) => part.trim()).filter((part) => part && !part.startsWith('http'));
    items.push({ section: kind, state: m[1] === ' ' ? 'pending' : m[1] === '!' ? 'blocked' : 'done', url, text: detail.join(' · ') || m[2] });
  }
  return items;
}

function listImprovements(root) {
  const dir = join(root, 'output');
  if (!existsSync(dir)) return [];
  const cv = read(join(root, 'cv.md'));
  return readdirSync(dir)
    .filter((name) => /^cv-edits-.*\.md$/.test(name))
    .map((file) => {
      const markdown = read(join(dir, file));
      const title = /^#\s+(.+)$/m.exec(markdown)?.[1] ?? file;
      const rows = parseEditTable(markdown) ?? [];
      const { findings } = verifyEditTable(markdown, cv);
      return { file, title, rows: rows.length, issues: findings.length, date: /(\d{4}-\d{2}-\d{2})\.md$/.exec(file)?.[1] ?? '' };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.file.localeCompare(b.file));
}

function readImprovement(root, file) {
  if (!/^cv-edits-[\w.-]+\.md$/.test(file)) return null;
  const path = join(root, 'output', file);
  if (!existsSync(path)) return null;
  const markdown = read(path);
  const table = parseEditTable(markdown);
  if (!table) return { file, title: file, rows: [], findings: ['No edit table found in this file'] };
  const { findings } = verifyEditTable(markdown, read(join(root, 'cv.md')));
  const failed = new Set(findings.map((finding) => /^row (\d+):/.exec(finding)?.[1]).filter(Boolean).map(Number));
  return {
    file,
    title: /^#\s+(.+)$/m.exec(markdown)?.[1] ?? file,
    findings,
    rows: table.map(([original = '', replacement = '', justification = '', where = ''], i) => ({
      original, replacement, justification, where, ok: !failed.has(i + 1),
    })),
  };
}

function readReport(root, num) {
  const file = reportFileFor(root, num);
  if (!file) return null;
  const markdown = read(join(root, 'reports', file));
  const header = (label) => new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, 'i').exec(markdown)?.[1]?.trim() ?? '';
  return { file, markdown, score: header('Score'), url: header('URL'), archetype: header('Archetype'), legitimacy: header('Legitimacy') };
}

/* ---------- import ---------- */

function importLinks(root, input) {
  const wanted = [...new Set(String(input).split(/[\s,]+/).filter(Boolean))];
  const known = new Set([...parsePipeline(root).map((item) => item.url), ...readTracker(root).map((row) => row.url)].filter(Boolean).map(normalizeUrl));
  const added = [], skipped = [];
  for (const raw of wanted) {
    let url;
    try { url = new URL(raw); } catch { skipped.push({ url: raw, reason: 'not a valid URL' }); continue; }
    if (!/^https?:$/.test(url.protocol)) { skipped.push({ url: raw, reason: 'only http(s) links' }); continue; }
    const key = normalizeUrl(url.href);
    if (known.has(key)) { skipped.push({ url: raw, reason: 'already in the pipeline or tracker' }); continue; }
    known.add(key);
    added.push(url.href);
  }
  if (added.length) writePending(root, added);
  return { added, skipped };
}

function writePending(root, urls) {
  const path = join(root, 'data', 'pipeline.md');
  mkdirSync(dirname(path), { recursive: true });
  const lines = read(path) ? read(path).split('\n') : ['# Pipeline', '', '## Pending', '', '## Processed', ''];
  const heading = lines.findIndex((line) => sectionKind(line) === 'pending');
  const entries = urls.map((url) => `- [ ] ${url}`);
  if (heading === -1) {
    lines.push('', '## Pending', '', ...entries, '');
  } else {
    let end = lines.findIndex((line, i) => i > heading && /^##\s/.test(line));
    if (end === -1) end = lines.length;
    while (end > heading + 1 && lines[end - 1].trim() === '') end--;
    lines.splice(end, 0, ...(end === heading + 1 ? [''] : []), ...entries);
  }
  atomicWriteFile(path, lines.join('\n').replace(/\n*$/, '\n'));
}

/* ---------- agent runs ---------- */

function createRunner(root) {
  let current = null;
  return {
    status: () => current && { ...current, child: undefined },
    start(action, report) {
      if (current?.state === 'running') return { error: 'A run is already in progress' };
      const runner = resolveRunner(root);
      const prompt = action === 'grade'
        ? 'Run the career-ops pipeline mode for data/pipeline.md.'
        : `Run the career-ops improve mode for the evaluated role in report ${String(report).padStart(3, '0')}.`;
      if (!runner) return { error: 'No agent CLI found. Install one, or run this prompt in your CLI yourself.', prompt };
      const args = runner.args(prompt);
      const child = spawn(runner.bin, args, { cwd: CODE_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      current = { action, cli: runner.name, prompt, state: 'running', startedAt: new Date().toISOString(), log: [], child };
      const push = (chunk) => {
        current.log.push(...chunk.toString().split(/\r?\n/).filter(Boolean));
        if (current.log.length > MAX_LOG_LINES) current.log.splice(0, current.log.length - MAX_LOG_LINES);
      };
      child.stdout.on('data', push);
      child.stderr.on('data', push);
      child.on('error', (error) => { push(`Could not start ${runner.bin}: ${error.message}`); current.state = 'failed'; });
      child.on('close', (code) => { if (current.state === 'running') current.state = code === 0 ? 'done' : 'failed'; });
      return { started: true, cli: runner.name, prompt };
    },
    stop() {
      if (current?.state === 'running') { current.state = 'stopped'; current.child.kill(); }
      return this.status();
    },
  };
}

/* ---------- http ---------- */

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(chunk);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new Error('Invalid JSON')); } });
  });
}

export function createDashboard({ root = getCareerOpsRoot() } = {}) {
  const runner = createRunner(root);
  const page = () => readFileSync(join(CODE_ROOT, 'dashboard', 'index.html'), 'utf-8');

  return http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      const origin = req.headers.origin;
      if (!LOCAL_HOST.test(host) || (origin && origin !== `http://${host}`)) return send(res, 403, { error: 'Local access only' });
      const url = new URL(req.url, `http://${host}`);
      const path = url.pathname;

      if (req.method === 'GET') {
        if (path === '/') return send(res, 200, page(), 'text/html; charset=utf-8');
        if (path === '/api/jobs') return send(res, 200, { jobs: readTracker(root), improvements: listImprovements(root) });
        if (path === '/api/pipeline') return send(res, 200, { items: parsePipeline(root) });
        if (path === '/api/run') return send(res, 200, { run: runner.status() ?? null, cli: resolveRunner(root)?.name ?? null });
        if (path === '/api/improvements') return send(res, 200, { improvements: listImprovements(root) });
        let m = /^\/api\/improvements\/([^/]+)$/.exec(path);
        if (m) {
          const data = readImprovement(root, decodeURIComponent(m[1]));
          return data ? send(res, 200, data) : send(res, 404, { error: 'Not found' });
        }
        m = /^\/api\/report\/(\d+)$/.exec(path);
        if (m) {
          const data = readReport(root, Number(m[1]));
          return data ? send(res, 200, data) : send(res, 404, { error: 'No report file for this row' });
        }
        return send(res, 404, { error: 'Not found' });
      }

      if (req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'JSON only' });
        const body = await readJson(req);
        if (path === '/api/import') return send(res, 200, importLinks(root, body.links ?? ''));
        if (path === '/api/run') {
          if (body.action !== 'grade' && !(body.action === 'improve' && Number.isInteger(body.report))) return send(res, 400, { error: 'action must be grade, or improve with a report number' });
          const result = runner.start(body.action, body.report);
          return send(res, result.error ? 409 : 200, result);
        }
        if (path === '/api/run/stop') return send(res, 200, { run: runner.stop() ?? null });
        return send(res, 404, { error: 'Not found' });
      }

      send(res, 405, { error: 'Method not allowed' });
    } catch (error) {
      send(res, 400, { error: error.message });
    }
  });
}

if (isMainModule(import.meta.url)) {
  const portArg = process.argv.indexOf('--port');
  const port = portArg === -1 ? DEFAULT_PORT : Number(process.argv[portArg + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('Usage: node dashboard.mjs [--port 4173]');
    process.exit(1);
  }
  createDashboard().listen(port, '127.0.0.1', function () {
    console.log(`career-ops dashboard: http://localhost:${this.address().port}  (this computer only; Ctrl+C to stop)`);
  });
}
