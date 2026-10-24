#!/usr/bin/env node

/**
 * test-all.mjs — Comprehensive test suite for career-ops
 *
 * Run before merging any PR or pushing changes.
 * Tests: syntax, scripts, dashboard, data contract, personal data, paths.
 *
 * Usage:
 *   node test-all.mjs                        # Run all tests
 *   node test-all.mjs --quick                # Skip dashboard build (faster)
 *   node test-all.mjs --only <substring>      # Run ONLY discovered tests/**\/*.test.mjs
 *                                             # files whose path contains <substring>
 *                                             # (e.g. --only providers/themuse).
 *   node test-all.mjs --jobs <N>              # Run at most N discovered suites at a time,
 *                                             # one process each. Default: every available
 *                                             # CPU, or CAREER_OPS_TEST_JOBS when set.
 *                                             # 1 imports them into this process in turn.
 *                                             # With more than 1, the inline sections
 *                                             # below run at the same time as the
 *                                             # discovered suites, in one of the N slots.
 *
 *   `--inline-child <result.json>` is how a run with more than one job starts
 *   those inline sections in a process of their own. It is not a way to run
 *   part of the suite: it prints no summary and its exit code says nothing
 *   about what failed.
 *
 *   LOUD WARNING: `--only` runs ONLY discovered tests/ files — every inline
 *   core section above (syntax, scripts, dashboard, data contract, personal
 *   data, paths, etc.) is SKIPPED. A green `--only` run is NOT a green
 *   suite. Always run the full suite (no flags) before pushing.
 *
 * NEW TESTS GO IN A FILE OF THEIR OWN, NOT IN A SECTION HERE.
 * Node tests matching tests/**\/*.test.mjs are auto-discovered — no
 * registration, no section number. The CV visual Playwright suite is the
 * exception: its dedicated workflow discovers tests/cv-visual/cv-visual.test.mjs.
 * Provider tests are one case of Node test auto-discovery
 * (tests/providers/{name}.test.mjs), not the only one.
 *
 * Why it matters beyond tidiness: a numbered section means editing the end of
 * this file, and the section number is a global label picked by hand. Six
 * contributors doing that at once in Aug-2026 all picked `60a` and each merge
 * forced a rebase on the other five - about fifteen rebases and six serialized
 * CI runs for six lines of test code. A new file collides with nobody, so
 * those PRs can all land in parallel.
 *
 * The inline sections below are history, not a pattern to copy.
 */


import { execSync, execFileSync, spawn, spawnSync } from 'child_process';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync as _rmSync, statSync, unlinkSync, realpathSync, symlinkSync, copyFileSync, openSync, closeSync } from 'fs';

// Windows keeps a handle open on a just-exited child process's working files
// for a short window (antivirus and Search Indexer widen it), so removing a
// fixture directory the suite created inside the repo can fail with EPERM even
// though every assertion passed. `force: true` does not cover that — it
// suppresses ENOENT, not EPERM — and most of these removals sit in `finally`
// blocks, so one unlucky cleanup aborted the whole run with a stack trace and
// a non-zero exit. That reads as a broken test suite on Windows when nothing
// is broken, and it leaves the fixture dir behind for the next run to trip on.
//
// Node retries exactly this class of error (EBUSY/EMFILE/ENFILE/ENOTEMPTY/
// EPERM) with linear backoff when given maxRetries, so default it everywhere
// rather than at ~95 individual call sites. An explicit option still wins.
const rmSync = (target, opts = {}) => _rmSync(target, { maxRetries: 10, retryDelay: 100, ...opts });
import { join, dirname, basename, relative, delimiter } from 'path';
import { tmpdir, availableParallelism } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import * as yaml from 'js-yaml';
import { pass, fail, warn, run, runAcrossUtcDay, runAcrossLocalDay, lastRunFailure, formatRunFailure, fileExists, finish, results, absorbResults, importSuiteContained, linkNodeModules, ROOT, QUICK, NODE, DEFAULT_SCRIPT_TIMEOUT_MS, getBash, toBashPath, hermeticGitEnv, pinSandboxDataRoot, exitOnInterrupt, ownRootEnv } from './tests/helpers.mjs';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { collectMjsFiles } from './lib/mjs-files.mjs';
import { checkSyntax, NODE_CHECK_TIMEOUT_MS } from './lib/syntax-check.mjs';
import { walkTree, listTree } from './lib/walk-tree.mjs';
import { FROZEN_EVALUATION_MODES, KNOWN_EVALUATION_MODES, discoverEvaluationModes, readModeText, structuralGaps } from './tests/evaluation-mode-parity-helpers.mjs';
import { childFailureExcerpt } from './lib/failure-excerpt.mjs';
import { SCRATCH_PREFIX, markScratchOwner, sweepScratchDirs } from './lib/scratch-dirs.mjs';
import { MARKER_FILE } from './tests/data-root-guard.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

/**
 * Read a repo-relative text file as UTF-8.
 *
 * @param {string} path - Path relative to the career-ops repository root.
 * @returns {string} File contents.
 */
function readFile(path) {
  // Several earlier checks walk modes before the parity gate. They must use
  // the same contained reader or a pointer could escape before parity runs.
  if (/^modes[\\/]/.test(path)) return readModeText(ROOT, path);
  const fullPath = join(ROOT, path);
  let content = readFileSync(fullPath, 'utf-8');
  if (content.trim().startsWith('..') && content.trim().split('\n').length === 1) {
    const target = join(dirname(fullPath), content.trim());
    if (existsSync(target)) {
      content = readFileSync(target, 'utf-8');
    }
  }
  return content;
}

function readOfertaMode() {
  return readFile('modes/oferta.md')
    .replace(/^\*\*\d+\. .+?\*\*\. Read `(modes\/oferta-signals\/[^`]+)` when .*$/gm, (_, file) => readFile(file));
}

/**
 * Normalize CRLF line endings to LF (#1771).
 *
 * On Windows checkouts with core.autocrlf=true, repo text files arrive with
 * CRLF endings. Doc assertions that anchor on `\n` (JS `.` never matches `\r`)
 * then fail on pristine main. Normalizing at read time keeps the assertions
 * byte-ending agnostic without touching any regex.
 *
 * @param {string} text - Raw file contents.
 * @returns {string} Contents with LF-only line endings.
 */
const normalizeEol = (text) => text.replace(/\r\n/g, '\n');

/**
 * Read a repo text file with line endings normalized to LF (#1771).
 * Use for doc-content reads that feed `\n`-anchored regex assertions.
 * Do NOT use where byte-exact content matters.
 *
 * @param {string} path - Path relative to the career-ops repository root.
 * @returns {string} File contents with LF-only line endings.
 */
const readTextLF = (path) => normalizeEol(readFile(path));

// An interrupted run still answers for the developer's data (#5113). A signal
// handler only runs between two turns of the event loop, and most of this file
// is synchronous: every discovered suite is awaited, so the loop turns there,
// and the script smoke tests yield between scripts for the same reason.
//
// Not in the inline sections' child (`--inline-child`, #5146): the run that
// started it answers for the data and stops the child on its way out, so a
// handler there would only print the notice a second time.
if (!hasFlag(process.argv, '--inline-child')) exitOnInterrupt();

// ── Auto-discovered test files (issue #1440) ─────────────────────────────
// Deterministic: recursive readdirSync with default lexicographic sort of
// entry names — same order on every run and OS. No glob library, no
// registration list. Discovery is limited to tests/ so root-level
// standalone *.test.mjs files are never picked up.
const TESTS_DIR = join(ROOT, 'tests');

function discoverTests(dir) {
  // walkTree sorts every level by name, so the run order is identical on every
  // run and OS — the property #1440 asked for. It also refuses to descend into
  // a nested checkout, which matters more here than anywhere else in this file:
  // this walk does not READ what it finds, it hands it to the runner. A
  // worktree parked under tests/ executed a stale checkout's suites against the
  // current tree, and test-all.mjs printed "🟢 All tests passed — safe to
  // push/merge" for them (#3762).
  return listTree(dir, { match: /\.test\.mjs$/ })
    // This is a Playwright suite, run by the dedicated CV visual job. It is
    // named .test.mjs for the repository convention, but node --test cannot
    // execute Playwright's test registration API.
    .filter((f) => f !== join(TESTS_DIR, 'cv-visual', 'cv-visual.test.mjs'));
}

// Strip comment lines before grepping a discovered suite's source for a
// forbidden call: a suite that only MENTIONS a call in a comment (e.g.
// documenting why it doesn't make it) must not be flagged.
//
// Removed: whole-line `//` comments, and every line of a `/* ... */` block,
// including unstarred interior lines. Kept: any code that shares a line with a
// comment, on either side of it, so a real call can never hide behind one:
// `/* why */ process.exit(1)` and `*gen() { finish() }` are still scanned.
// Trailing `//` comments on a code line are deliberately still scanned,
// erring toward a loud false positive, never a silent miss.
//
// Comment markers inside a multi-line template literal are text, not
// comments, and an interpolation there IS executable — so nothing is stripped
// while the kept code has an odd number of unescaped backticks (quoted
// strings and trailing `//` comments excluded from the count). An opener that
// never closes is not a comment we understand either; the raw source is
// scanned instead. Both limits fail loud, never silent.
function stripCommentLines(src) {
  let inBlock = false;
  let inTemplate = false;
  const kept = [];
  for (const line of src.split('\n')) {
    let rest = line;
    if (!inTemplate) {
      if (inBlock) {
        const end = rest.indexOf('*/');
        if (end === -1) continue;
        inBlock = false;
        rest = rest.slice(end + 2);
      }
      // A block comment opening at the start of the (remaining) line: drop it,
      // then look again — `/* a */ /* b */ code` keeps `code`.
      let open;
      while ((open = /^\s*\/\*/.exec(rest))) {
        const end = rest.indexOf('*/', open[0].length);
        if (end === -1) { inBlock = true; rest = ''; break; }
        rest = rest.slice(end + 2);
      }
      if (/^\s*(\/\/|$)/.test(rest)) continue;
    }
    kept.push(rest);
    const code = rest
      .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '')
      .replace(/\/\/.*$/, '');
    if (((code.match(/(?<!\\)`/g) ?? []).length) % 2 === 1) inTemplate = !inTemplate;
  }
  if (inBlock) return src;
  return kept.join('\n');
}

// What the runner may do with a discovered suite, read off its source. Shared
// by the in-process loop and the --jobs runner, so both refuse and route the
// same files for the same reasons.
//
//   'calls-exit'    Discovered suites share the runner's counters (in-process)
//                   or report to it (in a child). A process.exit() inside one
//                   would terminate test-all mid-run with a forged exit code —
//                   every later section (and finish()) would silently never
//                   run. Refuse to import such a suite and fail loudly instead
//                   (#1916 regression).
//   'node-test'     A node:test suite reports through node's OWN runner, which
//                   touches none of the counters, and it runs its tests
//                   asynchronously AFTER the import resolves — so finish()'s
//                   process.exit() killed them mid-flight and discarded the
//                   result. A deliberately failing suite dropped into tests/
//                   printed "2049 passed, 0 failed / All tests passed" and
//                   exited 0 (verified 2026-08-03). That silently covered all
//                   16 node:test suites here, including every provider test:
//                   they only ever reported under a direct `node --test`. They
//                   run in a child process and the real exit code is folded
//                   into the counters. Importing them is what loses the
//                   result, so this cannot be fixed in finish(); it has to
//                   happen where the suite is invoked.
//   'calls-finish'  finish() prints the global summary and exits — inside a
//                   discovered suite it forges the verdict line and
//                   decapitates every suite sorting after it, sailing past the
//                   process.exit() check (the exit lives in helpers).
//   'pass-fail'     Everything else: imported, with a throw contained
//                   (importSuiteContained in tests/helpers.mjs).
//
// stripCommentLines() first for both forbidden calls: a suite that only
// MENTIONS one in a comment (e.g. documenting why it doesn't make it) must not
// be flagged. The order is the order the checks have always run in.
function discoveredSuiteKind(src) {
  if (/\bprocess\.exit\s*\(/.test(stripCommentLines(src))) return 'calls-exit';
  if (/from ['"]node:test['"]/.test(src)) return 'node-test';
  if (/\bfinish\s*\(\s*\)/.test(stripCommentLines(src))) return 'calls-finish';
  return 'pass-fail';
}

const SUITE_REFUSALS = {
  'calls-exit': (rel) => `${rel} calls process.exit() — discovered suites must use pass/fail from tests/helpers.mjs and never exit`,
  'calls-finish': (rel) => `${rel} calls finish() — only test-all.mjs may print the global summary; discovered suites use pass/fail and return`,
};

/**
 * Report one finished node:test suite: a single pass line, or a fail line with
 * an excerpt of what the child printed.
 *
 * @param {string} rel - Repo-relative path of the suite.
 * @param {boolean} ok - Whether the child exited 0.
 * @param {string} stdout - The child's stdout (read for the pass count).
 * @param {{stdout?: string, stderr?: string}|null} detail - Streams of a failed run.
 * @param {string} how - How it ended, for the fail line (`exit 1`, `killed after 120s`).
 * @returns {void}
 */
function reportNodeTestSuite(rel, ok, stdout, detail, how) {
  if (ok) {
    // Both reporters: TAP prints "# pass N", the default spec reporter
    // prints "ℹ pass N". Cosmetic — the pass/fail verdict is the exit code.
    const count = (stdout.match(/^(?:#|ℹ) pass (\d+)/m) ?? [])[1];
    pass(`${rel} — node:test suite passed${count ? ` (${count} tests)` : ''}`);
    return;
  }
  fail(`${rel} — node:test suite failed (${how})`);
  // Surface the runner's own summary; a bare "failed" is not actionable.
  // The trailing window alone is not actionable either: node prints the
  // error message above the frames, so a twelve-line tail kept
  // `actual: false, expected: true` and dropped the interpolated value
  // that says WHICH assertion and by how much (#4017).
  for (const line of childFailureExcerpt(detail)) {
    console.log(`      ${line}`);
  }
}

async function runDiscovered(filter = null) {
  let files = discoverTests(TESTS_DIR);
  if (filter) {
    const norm = (p) => p.slice(TESTS_DIR.length + 1).replace(/\\/g, '/');
    files = files.filter((f) => norm(f).includes(filter));
  }
  if (files.length === 0) {
    // Fail hard: a path typo must never silently turn CI green.
    console.log(`  ❌ no test files matched${filter ? ` --only "${filter}"` : ''} under tests/`);
    process.exit(1);
  }
  // One file gains nothing from a child process, and --jobs 1 is the original
  // in-process loop below: the fallback when a parallel run looks wrong, and
  // the reference a parallel run is compared against.
  if (JOBS > 1 && files.length > 1) {
    await runDiscoveredParallel(files, Math.min(JOBS, files.length));
    return;
  }
  for (const f of files) {
    const rel = f.slice(ROOT.length + 1);
    // In-process suites share this process's environment. One that moves the
    // data root for its own fixture and leaves it there, or deletes the
    // variable to "restore" it, would hand every suite after it a different
    // root — the developer's own, in the second case (#5113).
    pinSandboxDataRoot();
    const kind = discoveredSuiteKind(readFileSync(f, 'utf-8'));
    if (SUITE_REFUSALS[kind]) {
      fail(SUITE_REFUSALS[kind](rel));
      continue;
    }
    if (kind === 'node-test') {
      const out = run(NODE, ['--test', f]);
      reportNodeTestSuite(rel, out !== null, out ?? '', lastRunFailure(), `exit ${lastRunFailure()?.status ?? '?'}`);
      continue;
    }
    await importSuiteContained(f, rel);
  }
}

// ── Discovered suites, several at a time (--jobs N) ──────────────────────
//
// The loop above runs ~600 files one after another in this process, which is
// most of a full run's wall time on a machine with idle cores. Here each suite
// gets a process of its own and N run at once.
//
// What stays the same as the serial loop, on purpose:
//   - the order of the output. Each suite's output is buffered and printed when
//     its turn in discovery order comes, so two runs of the same tree print the
//     same log whatever finished first;
//   - the source guards (process.exit, finish()) and their messages;
//   - node:test suites run under `node --test` and report one line each;
//   - the totals. A pass/fail-style suite counts in its own process and hands
//     results() back (tests/run-discovered-child.mjs); absorbResults() adds
//     them here, so finish() prints the same numbers and exit code.
//
// What differs: suites no longer share a process. One that relied on state an
// earlier suite left behind (an env var, a module-level cache) finds it gone,
// and one that keeps the event loop open is cut off after a grace period
// instead of riding along until finish(). Both are reported, not hidden.

// A node:test suite gets the same 30s budget run() gives it, times this, when
// it shares the machine with N-1 others. Measured on 8 cores: a file takes
// about 1.7x as long at 8 jobs as it does alone, and the slowest is 16s alone.
const PARALLEL_NODE_TEST_BUDGET_FACTOR = 4;
// The serial loop has no limit for an imported suite at all; a child that never
// exits must not hang the whole run, so this one is only a backstop.
const PARALLEL_SUITE_TIMEOUT_MS = 5 * 60_000;

/**
 * Spawn node on one suite and collect what it printed.
 *
 * @param {string[]} args - Arguments after the node binary.
 * @param {number} timeoutMs - Kill the child after this long.
 * @returns {Promise<{status: number|null, signal: string|null, timedOut: boolean, stdout: string, stderr: string, merged: string, ms: number}>}
 *   `merged` is both streams in arrival order, which is what a terminal shows.
 */
function spawnSuite(args, timeoutMs, captureFile = null) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const out = [];
    const err = [];
    let timedOut = false;
    // With a capture file, both of the child's streams are the SAME descriptor,
    // exactly as `> file 2>&1` makes them. Two pipes cannot do this: each is
    // read when its data happens to arrive, so a line a suite wrote to stderr
    // could land before or after the stdout lines around it, and the log would
    // differ from a serial run's (and from the previous parallel run's).
    const fd = captureFile ? openSync(captureFile, 'w') : null;
    // Nested test-all runs (some suites start one) must not fan out again
    // inside a worker slot: JOBS is pinned to 1 in the environment below.
    const child = spawn(NODE, args, { cwd: ROOT, env: process.env, stdio: ['ignore', fd ?? 'pipe', fd ?? 'pipe'] });
    const killer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout?.on('data', (d) => out.push(d));
    child.stderr?.on('data', (d) => err.push(d));
    // Once only. A child that fails to spawn emits 'error' and may emit 'close'
    // after it; a second closeSync() on the same descriptor throws EBADF from
    // inside an event handler, which would take the runner down before
    // finish() prints anything.
    let settled = false;
    const done = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      if (fd !== null) closeSync(fd);
      let merged = '';
      if (captureFile) {
        try { merged = readFileSync(captureFile, 'utf-8'); } catch { /* reported by the caller as a dead suite */ }
      }
      resolve({
        status, signal, timedOut, merged,
        stdout: Buffer.concat(out).toString('utf-8'),
        stderr: Buffer.concat(err).toString('utf-8'),
        ms: Date.now() - startedAt,
      });
    };
    child.on('error', (e) => { err.push(Buffer.from(String(e?.message ?? e))); done(null, null); });
    child.on('close', done);
  });
}

/**
 * Run one discovered suite in a child and return a function that reports it.
 *
 * Reporting is deferred so the caller can apply results in discovery order:
 * nothing here touches the counters or stdout.
 *
 * @param {string} f - Absolute path of the suite.
 * @param {string} scratch - Directory for this run's result files.
 * @param {number} index - Position in discovery order (names the result file).
 * @returns {Promise<{report: () => void, ms: number, lingered: boolean}>}
 */
async function runSuiteInChild(f, scratch, index) {
  const rel = f.slice(ROOT.length + 1);
  const kind = discoveredSuiteKind(readFileSync(f, 'utf-8'));
  if (SUITE_REFUSALS[kind]) {
    return { ms: 0, lingered: false, report: () => fail(SUITE_REFUSALS[kind](rel)) };
  }
  if (kind === 'node-test') {
    const r = await spawnSuite(['--test', f], DEFAULT_SCRIPT_TIMEOUT_MS * PARALLEL_NODE_TEST_BUDGET_FACTOR);
    const how = r.timedOut ? `killed after ${Math.round(r.ms / 1000)}s` : `exit ${r.status ?? '?'}`;
    return { ms: r.ms, lingered: false, report: () => reportNodeTestSuite(rel, r.status === 0, r.stdout, r, how) };
  }
  const resultFile = join(scratch, `${index}.json`);
  const args = [join(TESTS_DIR, 'run-discovered-child.mjs'), f, resultFile];
  if (QUICK) args.push('--quick');
  const r = await spawnSuite(args, PARALLEL_SUITE_TIMEOUT_MS, join(scratch, `${index}.out`));
  let counts = null;
  try { counts = JSON.parse(readFileSync(resultFile, 'utf-8')); } catch { /* reported below */ }
  return {
    ms: r.ms,
    lingered: counts?.lingered === true,
    report: () => {
      if (r.merged) process.stdout.write(r.merged.endsWith('\n') ? r.merged : `${r.merged}\n`);
      if (counts) absorbResults(counts);
      if (r.timedOut) {
        fail(`${rel} — suite was killed after ${Math.round(r.ms / 1000)}s without finishing`);
      } else if (!counts) {
        // No result file: the process died before its exit handler ran, so
        // however many assertions printed above, none of them were counted.
        fail(`${rel} — suite process died without reporting (exit ${r.status ?? '?'}${r.signal ? `, ${r.signal}` : ''}); its assertions above are not in the totals`);
      } else if (r.status !== 0) {
        // The suite reported, then the process ended badly anyway: an error
        // thrown from async work after the import resolved. In the serial loop
        // that same error takes the whole run down with it.
        fail(`${rel} — suite process exited ${r.status ?? r.signal ?? '?'} after reporting (an error outside its awaited work)`);
        // Nothing to excerpt: the error is already in the suite's output above.
      }
    },
  };
}

// ── The inline sections, at the same time as the suites (#5146) ──────────
//
// Everything between the two INLINE SECTIONS markers further down predates
// tests/: sections that run one after another in one process. They were a
// little under 30% of a full run, and no discovered suite started until the
// last of them had finished.
//
// With more than one job, this process starts a second copy of itself that
// runs only those sections (`--inline-child`), and runs the discovered suites
// in the pool meanwhile. The child takes one of the N slots while it runs.
//
// What stays the same as running them first:
//   - the log. The child writes to this process's own stdout and stderr, so
//     the sections stream as they always did. Every suite's output is held
//     until the child has exited, which is the buffering the pool already does
//     to keep discovery order;
//   - the totals and the exit code. The child hands results() back through a
//     file, the way a suite's child does;
//   - `--jobs 1`, where everything still runs in this process, in order.
//
// What differs: the sections and the suites are in the working tree at the
// same time. Neither may leave something in the repository where the other
// can find it: see "Parallel runs" in tests/README.md.

/**
 * Start this file's inline sections in a process of their own.
 *
 * @param {string} resultFile - Where the child writes its counters.
 * @returns {Promise<{status: number|null, signal: string|null, error: string|null, ms: number}>}
 *   Resolves when the child has ended, however it ended.
 */
function startInlineSections(resultFile) {
  const startedAt = Date.now();
  // The command line this process was given, plus the one flag: the sections
  // read --quick from it, and a flag added later reaches them without a list
  // here to keep up to date. No `cwd`: the sections have always run wherever
  // the runner was started from.
  const child = spawn(NODE, [fileURLToPath(import.meta.url), ...process.argv.slice(2), '--inline-child', resultFile], {
    env: process.env,
    stdio: 'inherit',
  });
  let exited = false;
  // Still running when this process exits only if the run was cut short, by
  // an error thrown in the pool for one. Left alone the child would go on
  // printing sections into a terminal whose run is over. A signal that kills
  // this process outright does not come through here; Ctrl-C reaches the
  // child by itself, as part of the same foreground process group.
  process.on('exit', () => { if (!exited) child.kill('SIGKILL'); });
  return new Promise((resolve) => {
    // Once only, for the reason spawnSuite() gives: a child that fails to
    // spawn emits 'error' and may emit 'close' after it.
    const settle = (status, signal, error = null) => {
      if (exited) return;
      exited = true;
      resolve({ status, signal, error, ms: Date.now() - startedAt });
    };
    child.on('error', (e) => settle(null, null, String(e?.message ?? e)));
    child.on('close', (status, signal) => settle(status, signal));
  });
}

/**
 * Fold the inline sections' child into this run: its counters, and one failure
 * if it stopped before the last section.
 *
 * @param {{status: number|null, signal: string|null, error: string|null}} r - How the child ended.
 * @param {string} resultFile - Where it wrote its counters.
 * @returns {void}
 */
function reportInlineSections(r, resultFile) {
  let counts = null;
  try { counts = JSON.parse(readFileSync(resultFile, 'utf-8')); } catch { /* reported below */ }
  if (counts) absorbResults(counts);
  if (counts?.completed) {
    // finish() reads process.exitCode for a failure the counters never saw.
    // In one process a section that set it reached finish() directly.
    if (counts.runnerFailed) process.exitCode = 1;
    return;
  }
  // An uncaught throw or an exit call in a section. In one process that ended
  // the run on the spot, with no summary and nothing after it run. Here the
  // suites have run regardless, so the run goes on to report them, and this is
  // the line that says the sections above are not all of them.
  const how = r.error ? `could not start: ${r.error}` : `exit ${r.status ?? '?'}${r.signal ? `, ${r.signal}` : ''}`;
  fail(`the inline sections stopped before the last one (${how}) — every section after the output above did not run`
    + (counts ? '' : ', and none of the assertions above are in the totals'));
}

/**
 * Run the discovered suites `jobs` at a time and report them in discovery order.
 *
 * @param {string[]} files - Suites, already in discovery order.
 * @param {number} jobs - How many children to keep running.
 * @param {object} [options]
 * @param {boolean} [options.withInlineSections] - Also run this file's inline
 *   sections, in one of the `jobs` slots, and print them before any suite.
 * @returns {Promise<void>}
 */
async function runDiscoveredParallel(files, jobs, { withInlineSections = false } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'career-ops-test-jobs-'));
  const startedAt = Date.now();
  const finished = new Array(files.length).fill(null);
  let next = 0;
  let reported = 0;
  // While the sections are still printing, nothing else may: a suite that has
  // finished waits in `finished` exactly as one waiting for its turn does.
  let held = withInlineSections;
  const flush = () => {
    if (held) return;
    while (reported < files.length && finished[reported]) {
      finished[reported].report();
      reported++;
    }
  };
  const worker = async () => {
    while (next < files.length) {
      const index = next++;
      finished[index] = await runSuiteInChild(files[index], scratch, index);
      flush();
    }
  };
  const pool = Math.min(jobs, files.length);
  let inlineMs = 0;
  try {
    if (withInlineSections) {
      const resultFile = join(scratch, 'inline.json');
      // One slot is the sections' until they finish; then the pool gets it.
      const meanwhile = Math.min(jobs - 1, files.length);
      const sections = startInlineSections(resultFile).then((r) => {
        inlineMs = r.ms;
        reportInlineSections(r, resultFile);
        held = false;
        flush();
        return meanwhile < pool ? worker() : undefined;
      });
      await Promise.all([sections, ...Array.from({ length: meanwhile }, worker)]);
    } else {
      await Promise.all(Array.from({ length: pool }, worker));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const wall = (Date.now() - startedAt) / 1000;
  const summed = finished.reduce((n, r) => n + (r?.ms ?? 0), 0) / 1000;
  console.log(`\n  ⏱  ${files.length} discovered suites in ${wall.toFixed(0)}s, ${pool} at a time (${summed.toFixed(0)}s of suite time; --jobs N or CAREER_OPS_TEST_JOBS to change, 1 runs them in-process)`);
  if (withInlineSections) {
    console.log(`  ⏱  the inline sections ran at the same time, for the first ${(inlineMs / 1000).toFixed(0)}s, in one of the ${jobs} slots`);
  }
  const lingering = files.filter((_, i) => finished[i]?.lingered).map((f) => f.slice(ROOT.length + 1));
  if (lingering.length) {
    // Not a failure: the serial loop never notices these. Named because each
    // one holds a worker for the whole grace period, and because a handle left
    // open is usually a server or timer the suite meant to close.
    console.log(`  ⏱  ${lingering.length} suite(s) kept their process alive after finishing and were cut off: ${lingering.join(', ')}`);
  }
}

// Set in the process a run with more than one job starts for the inline
// sections: the file its counters go to. See startInlineSections().
const INLINE_CHILD = hasFlag(process.argv, '--inline-child') ? (flagValue(process.argv, '--inline-child') ?? '') : null;
if (INLINE_CHILD === '' || INLINE_CHILD?.startsWith('--')) {
  console.log('  ❌ --inline-child requires a result file; it is how test-all.mjs starts its own inline sections, not a flag to pass by hand');
  process.exit(1);
}

// A scratch copy left by a killed run used to poison every walker that follows:
// `.gitignore` hides it and the copy carries no `.git`, so neither `git status`
// nor `isNestedCheckout()` could see it, and the layout guards read a second
// copy of `tests/` as several hundred misplaced suites (#3940).
//
// What makes the run correct is `isScratchDir` in the walkers, not this sweep —
// they skip a leftover whether it gets removed or not. This only reclaims the
// disk, which is why it can afford the age gate that keeps it off a scratch a
// concurrent run is still writing into.
//
// Placed before the `--only` exit below: the 264-failure run is exactly the one
// a developer then re-runs with `--only core-test-layout` to look closer, and a
// sweep they skip past would leave that second run behaving differently again.
//
// Not in the inline sections' child: the run that started it has just swept,
// and a directory it could not remove would be warned about, and counted, twice.
{
  const { removed, failed } = INLINE_CHILD === null ? sweepScratchDirs(ROOT) : { removed: [], failed: [] };
  // Only speak when there was something to say. A sweep is silent on the
  // overwhelming majority of runs, and a line reporting that nothing happened
  // would be noise at the top of every one of them. `kept` is deliberately not
  // reported: a young scratch is somebody else's live run, and it is none of
  // this run's business.
  for (const name of removed) {
    console.log(`  🧹 removed a stale scratch copy from an interrupted run: ${name}/`);
  }
  for (const { name, error } of failed) {
    // Not fatal — the walkers skip it, so every guard below still grades the
    // real tree — but not silent either: something is holding a directory this
    // run tried to delete, and that is worth knowing before it becomes a
    // disk-space question.
    warn(`could not remove the stale scratch copy ${name}/ (${error}) — the guards skip it, so this run is unaffected`);
  }
}

// `--only=providers/x` must not read as "no filter": the discovered-test
// runner exits 1 when a filter matches nothing, precisely so a path typo can
// never turn CI green — and a silently dropped filter runs the whole suite
// instead, which looks like a pass of the subset that was asked for.
// `--only` supplied without a value must stay a usage error, not fall through
// to "no filter": that would run everything and read as a pass of the subset
// that was asked for — the same silent substitution this file's flag reading
// was fixed for.
// How many discovered suites run at once. In order of precedence:
//   --jobs N                 this run
//   CAREER_OPS_TEST_JOBS=N   this machine (a shell profile, a CI job)
//   every available CPU      the default
// 1 keeps the original loop: every suite imported into this process, in order.
// A value that is not a positive integer is a usage error either way, for the
// reason --only's is below: a typo that silently falls back to the default
// reads as the run that was asked for.
const JOBS = (() => {
  const fromFlag = hasFlag(process.argv, '--jobs');
  const raw = fromFlag ? (flagValue(process.argv, '--jobs') ?? '') : (process.env.CAREER_OPS_TEST_JOBS ?? '').trim();
  if (!fromFlag && raw === '') return availableParallelism();
  if (!/^[1-9]\d*$/.test(raw)) {
    console.log(`  ❌ ${fromFlag ? '--jobs' : 'CAREER_OPS_TEST_JOBS'} must be a positive integer, e.g. ${fromFlag ? '--jobs 4' : 'CAREER_OPS_TEST_JOBS=4'} (got "${raw}")`);
    process.exit(1);
  }
  return Number(raw);
})();
// Everything this run starts inherits a serial default. Some suites launch a
// test-all of their own; one that fanned out again inside a worker slot would
// put N x N processes on N cores, and its output would stop being comparable
// with the serial runs those suites were written against.
process.env.CAREER_OPS_TEST_JOBS = '1';

const ONLY = hasFlag(process.argv, '--only') ? (flagValue(process.argv, '--only') ?? '') : null;
if (ONLY !== null) {
  if (ONLY === '' || ONLY.startsWith('--')) {
    console.log('  ❌ --only requires a path substring, e.g. --only providers/themuse');
    process.exit(1);
  }
  console.log('\n🧪 career-ops test suite (--only ' + ONLY + ')\n');
  await runDiscovered(ONLY);
  finish();
}

// More than one job: the inline sections go to a child and the discovered
// suites start now, not after them. One suite gains nothing from a process of
// its own, as in runDiscovered(), and none at all is the hard failure
// runDiscovered() reports once the sections have run.
if (INLINE_CHILD === null && JOBS > 1) {
  const files = discoverTests(TESTS_DIR);
  if (files.length > 1) {
    await runDiscoveredParallel(files, JOBS, { withInlineSections: true });
    finish();
  }
}

// What the inline sections' child reports back, written as the process ends
// so that a section that threw or exited still hands over what it counted;
// `completed` is how the parent tells that from a run that reached the end.
let inlineSectionsCompleted = false;
let inlineRunnerFailed = false;
if (INLINE_CHILD !== null) {
  process.on('exit', () => {
    try {
      writeFileSync(INLINE_CHILD, JSON.stringify({ ...results(), completed: inlineSectionsCompleted, runnerFailed: inlineRunnerFailed }));
    } catch {
      // Nothing to report to: the parent reads a missing file as sections that died.
    }
  });
}

// ── INLINE SECTIONS: BEGIN ──────────────────────────────────────
// From here to the END marker is what `--inline-child` runs.
// tests/test-all-inline-jobs.test.mjs replaces this stretch with fixture
// sections, so both markers have to stay where the stretch starts and ends.

console.log('\n🧪 career-ops test suite\n');

// ── 1. SYNTAX CHECKS ────────────────────────────────────────────

console.log('1. Syntax checks');

// RECURSIVE, and sharing its walk with `npm run lint` (#3419). This read the
// repository root non-recursively, which covered 121 of the ~575 .mjs files
// here and printed a `syntax OK` line for each one — so the 263 files under
// tests/ were absent from a log that looked complete. It also narrowed by one
// every time a file moved out of the root, silently: #3306 moved eleven suites
// into tests/ and #3388 nine, and the shortfall was only noticed later as a
// two-check arithmetic discrepancy in #3411. Both scopes now come from the
// same collector, so neither can drift from the other again.
const mjsFiles = collectMjsFiles(ROOT).map(f => f.slice(ROOT.length + 1).replace(/\\/g, '/'));

// State the scope in one line. The per-file `syntax OK` output is what hid the
// old shortfall: a number the reader can compare against `npm run lint`'s own
// total makes a narrowing visible at a glance instead of requiring someone to
// diff two runs' pass labels.
console.log(`  (${mjsFiles.length} .mjs files, recursive from the repository root)`);

// One process parses all of them, and `node --check` then runs only on a file
// that pass did not vouch for, so a failure below carries the diagnostic it
// always carried (lib/syntax-check.mjs, #5078). One `node --check` per file,
// even eight at a time (#2387), was 22 s of starting node for 0.3 s of parsing.
// Results come back by index and are reported in collector order, so the log
// does not depend on what finished first.
const { errors: syntaxErrors, fastPassUnavailable } = await checkSyntax(mjsFiles, { cwd: ROOT, node: NODE });
if (fastPassUnavailable) {
  // Not a failure and not a narrower check: every file went through
  // `node --check` instead. Said out loud because it costs about 20 s a run,
  // and nothing else here would show where they went.
  console.log(`  (the single-process parse did not run: ${fastPassUnavailable}; each file was checked with node --check instead)`);
}

// A bare catch reports a child killed on timeout, or one that never spawned, as
// "has syntax errors" — sending the reader hunting for a parse error that does
// not exist. Keep enough of the child's own diagnosis to tell those apart.
const describeCheckFailure = (err) => {
  if (err?.killed || err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT') {
    return `node --check timed out after ${NODE_CHECK_TIMEOUT_MS}ms${err.signal ? ` (signal ${err.signal})` : ''}`;
  }
  const stderr = String(err?.stderr ?? '').trim();
  if (!stderr) return `no stderr (exit ${err?.code ?? 'unknown'})`;
  const clipped = stderr.length > 2000
    ? `${stderr.slice(0, 2000)}\n    ... (${stderr.length - 2000} more chars)`
    : stderr;
  return clipped.replace(/\n/g, '\n    ');
};

mjsFiles.forEach((f, i) => {
  if (!syntaxErrors[i]) {
    pass(`${f} syntax OK`);
  } else {
    fail(`${f} has syntax errors\n    ${describeCheckFailure(syntaxErrors[i])}`);
  }
});

// ── 2. SCRIPT EXECUTION ─────────────────────────────────────────

console.log('\n2. Script execution (graceful on empty data)');

// How much of its budget a script may consume before the suite says so. High
// enough that ordinary CI variance stays quiet, low enough to leave room to act
// before the kill: at 0.75 a 30s script warns at 22.5s, nearly a full run of
// headroom.
const SLOW_SCRIPT_WARN_FRACTION = 0.75;

/**
 * Whether a failed run died with an UNCAUGHT exception rather than exiting.
 *
 * The two are not the same outcome and only one of them is ever "expected".
 * Node prints an uncaught error as `SomeError: message` at the start of a line
 * followed by a stack; a script reporting its own problem and exiting non-zero
 * prints neither. Both parts are required, so a script whose own diagnostic
 * happens to start with "Error: " is not mistaken for a crash.
 *
 * @param {{stderr?: string}|null} failure
 * @returns {boolean}
 */
function crashedBeforeRunning(failure) {
  const stderr = String(failure?.stderr ?? '');
  return /^[A-Za-z]*Error(?: \[[^\]]+\])?: /m.test(stderr) && /\n\s+at /.test(stderr);
}

const scripts = [
  { name: 'cv-sync-check.mjs', expectExit: 1, allowFail: true }, // fails without cv.md (normal in repo)
  { name: 'verify-pipeline.mjs', expectExit: 0 },
  // --dry-run: these scripts resolve ROOT from import.meta.url and write
  // data/applications.md (or data/pipeline.md) in place. On a provisioned working
  // copy with a real tracker present, running them without --dry-run mutates user
  // data. Harmless in this repo (no tracker shipped), risky for end users who run
  // tests inside their active career-ops workspace.
  { name: 'normalize-statuses.mjs --dry-run', expectExit: 0 },
  { name: 'dedup-tracker.mjs --dry-run', expectExit: 0 },
  { name: 'merge-tracker.mjs --dry-run', expectExit: 0 },
  { name: 'reconcile-pipeline.mjs --dry-run', expectExit: 0 },
  { name: 'keyword-match.mjs --self-test', expectExit: 0 },
  { name: 'check-table-freshness.mjs --self-test', expectExit: 0 },
  { name: 'check-jd-archive.mjs --self-test', expectExit: 0 },
  { name: 'rank-pipeline.mjs --self-test', expectExit: 0 },
  { name: 'salary-gap.mjs --self-test', expectExit: 0 },
  { name: 'build-cv-html.mjs --test', expectExit: 0 },
  { name: 'jd-skill-gap.mjs --self-test', expectExit: 0 },
  { name: 'cv-title-check.mjs --self-test', expectExit: 0 },
  { name: 'verify-cv-facts.mjs --self-test', expectExit: 0 },
  { name: 'verify-cv-structure.mjs --self-test', expectExit: 0 },
  { name: 'verify-ats.mjs --self-test', expectExit: 0 },
  { name: 'ats-payload.mjs --self-test', expectExit: 0 },
  { name: 'validate-profile.mjs --self-test', expectExit: 0 },
  // The bare coverage run is NOT here on purpose: this section executes each
  // script from a throwaway copy of the repo, and the coverage check needs
  // `git ls-files` on the REAL tree. Running it here validated nothing and
  // exited 0 no matter what, which is how five unregistered files shipped.
  // It now runs from ROOT in section 5.
  { name: 'validate-untrusted-content-coverage.mjs --self-test', expectExit: 0 },
  // Same reasoning as above: the bare run needs AGENTS.md and the real
  // modes/ tree sitting next to it, which this throwaway single-file copy
  // does not have. It runs from ROOT alongside the SYSTEM_PATHS coverage
  // check below.
  // Missing-file run: must exit 0 gracefully and hit no network. Do not use the
  // default portals.yml because end-user workspaces often have a real user-layer
  // portals file that would trigger a live remote sweep during tests.
  // Pins #4250: --help must exit fast on its own, never fall through to the
  // full network sweep (which is what "no output for minutes" looks like).
  { name: 'archive-posting.mjs --help', expectExit: 0 },
];

const scriptTmp = mkdtempSync(join(ROOT, SCRATCH_PREFIX));
try {
  // Claim before copying or running scripts. If this fails, stop and let the
  // finally below remove the unused directory rather than run without an owner.
  markScratchOwner(scriptTmp);
  // Never copied, at any depth: dependency trees and git metadata. Nothing run
  // from the throwaway copy reads them (module resolution walks up into the
  // real ROOT/node_modules, which is how the root-level exclusion already
  // worked), and a nested web/node_modules is ~400 MB on a machine that has
  // installed the web app's deps — copying it dominated this section (#2387).
  const EXCLUDE_AT_ANY_DEPTH = new Set(['node_modules', '.git']);

  // Mirror `src` into `dest`. The nested-checkout skip this used to spell out
  // is walkTree's now, applied on every descent and never to the walk root —
  // which is exactly the asymmetry this needed (#3499). A linked worktree
  // carries a `.git` FILE, so EXCLUDE_AT_ANY_DEPTH never fires on one, and
  // copying it doubles this section's cost while seeding the throwaway tree
  // with a stale duplicate of every script; but ROOT's own `.git` is
  // legitimately a file when the suite is run FROM a worktree, where testing it
  // would copy nothing at all.
  const copyDirSync = (src, dest, exclude = []) => {
    mkdirSync(dest, { recursive: true });
    // A leftover scratch copy from an interrupted run is skipped by walkTree at
    // any depth, so this copy can no longer nest it inside its own — which is
    // how #3940's `.tmp-script-test-OP9Bzd/.tmp-script-test-tBjFgy/…` came to
    // exist. That includes the directory a concurrent run is writing into right
    // now, which the startup sweep deliberately leaves alone. Directories only:
    // a source FILE carrying the prefix is still copied, so no script check can
    // pass by not running.
    const mirror = (abs) => join(dest, relative(src, abs));
    walkTree(src, {
      // statSync semantics: a symlinked directory is descended and copied, as
      // this has always done.
      links: 'follow',
      skip: (entry, _dir, depth) =>
        EXCLUDE_AT_ANY_DEPTH.has(entry.name)
        // Everything else is a top-level workspace dir (data/, reports/, …) and
        // is matched by basename ONLY at the repo root (depth 0), so nested
        // fixture subdirs such as test-fixtures/upgrade/state-*/data and
        // .../reports still get copied.
        || (depth === 0 && exclude.includes(entry.name)),
      // Directories are materialised even when empty, which the old recursion
      // did by mkdir-ing before it read.
      onDir: (abs) => mkdirSync(mirror(abs), { recursive: true }),
      // A file that is gone by the time it is copied was never part of the
      // tree under test: the discovered suites run during this copy (#5146),
      // and some keep a lock, a probe or a fixture in the checkout for a
      // moment. The walk already passes over a directory that vanishes under
      // it; anything else that goes wrong with a copy still stops the run.
      onFile: (abs) => {
        try {
          copyFileSync(abs, mirror(abs));
        } catch (err) {
          if (err?.code !== 'ENOENT' || existsSync(abs)) throw err;
        }
      },
    });
  };

  const excludeDirs = [
    // node_modules and .git are not listed here — EXCLUDE_AT_ANY_DEPTH above
    // drops them wherever they occur, root included.
    'data',
    'reports',
    '.update-lock',
    '.career-ops-web',
    '.playwright-mcp',
    '.agents',
    'cdp-diff.patch',
    'cdp-diff-focused.patch',
    'test_diff.patch',
    'test_diff_utf8.patch',
    // A marker redirects the data root, and the copy would follow the
    // developer's to their real data (#5113).
    MARKER_FILE,
    basename(scriptTmp),
  ];
  copyDirSync(ROOT, scriptTmp, excludeDirs);

  mkdirSync(join(scriptTmp, 'data'), { recursive: true });
  mkdirSync(join(scriptTmp, 'reports'), { recursive: true });
  // The throwaway copy excludes user data, but these exact empty scaffolds are
  // system-owned updater files. Keep them in the fixture so the migration
  // check can validate every SYSTEM_PATHS entry without copying user content.
  mkdirSync(join(scriptTmp, 'data', 'offers'), { recursive: true });
  mkdirSync(join(scriptTmp, 'data', 'parser-output'), { recursive: true });
  for (const file of [
    'data/.gitkeep',
    'data/offers/.gitkeep',
    'data/parser-output/.gitkeep',
    'reports/.gitkeep',
  ]) {
    writeFileSync(join(scriptTmp, file), '', 'utf-8');
  }
  writeFileSync(
    join(scriptTmp, 'data', 'applications.md'),
    '# Applications\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n',
    'utf-8'
  );

  // The copy is its own data root: no override, and no marker copied in, so
  // each script falls through to the directory it runs from. Passed
  // explicitly because a child inherits the environment otherwise, and an
  // inherited CAREER_OPS_ROOT outranks the script's own location — these
  // smoke tests appended a fixture row to the developer's real
  // data/assessments.tsv that way, on every run (#5113).
  const scratchEnv = ownRootEnv();

  for (const script of scripts) {
    // Let a pending SIGINT/SIGTERM land between scripts. This loop is otherwise
    // one synchronous stretch, the longest in the file, and a signal handler
    // cannot run inside one.
    await new Promise((resolve) => setImmediate(resolve));
    const { name, allowFail, timeoutMs } = script;
    const parts = name.split(' ');
    const scriptFile = parts[0];
    const args = parts.slice(1);
    // WHETHER a budget was declared is read from the key's presence, never
    // inferred from its value. Every in-band sentinel here is also a value
    // somebody could write, and each one costs a bug: the first draft used
    // `??` for the budget and truthiness for the override, so `timeoutMs: 0`
    // meant "no budget" to one line and "default" to the next; the second used
    // `null` as its absent-marker, so an explicit `timeoutMs: null` skipped
    // validation and silently took the default. `hasOwn` cannot be spoofed by
    // a value, so the question has one answer.
    //
    // A declared-but-unusable value then fails loudly rather than falling back.
    // This list is hand-edited, so a bad entry is a typo in the suite's own
    // definition, and quietly substituting the default would hide it behind the
    // very budget it was trying to set. `timeoutMs: undefined` is caught too —
    // writing the key at all is a claim, and an unusable claim is a mistake.
    // Integer, not merely finite: execFileSync rejects a fractional timeout with
    // ERR_OUT_OF_RANGE, so `timeoutMs: 0.5` would pass a "looks like a number"
    // check here and then blow up inside the run with an error about neither
    // this list nor this script. Validation that stops short of what the
    // consumer accepts just moves the failure somewhere less legible.
    const declared = Object.hasOwn(script, 'timeoutMs');
    if (declared && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
      fail(`${name} declares an unusable timeoutMs (${String(timeoutMs)}) — must be a positive integer number of milliseconds`);
      continue;
    }
    // Same rule for the declared exit status. Every entry wrote `expectExit`
    // and nothing read it: a pass meant exit 0 whatever the entry said, so
    // cv-sync-check.mjs's `expectExit: 1` was a claim no check stood behind.
    const expectExit = Object.hasOwn(script, 'expectExit') ? script.expectExit : 0;
    if (!Number.isInteger(expectExit) || expectExit < 0) {
      fail(`${name} declares an unusable expectExit (${String(expectExit)}) — must be a non-negative integer exit status`);
      continue;
    }
    const budgetMs = declared ? timeoutMs : DEFAULT_SCRIPT_TIMEOUT_MS;
    const startedAt = Date.now();
    // Spread rather than defaulted: `{ timeout: undefined }` reads to
    // execFileSync as "no timeout at all", which would turn a hung script into
    // a hung CI job. Absent means absent, so run()'s own default stands.
    const result = run(NODE, [join(scriptTmp, scriptFile), ...args], {
      cwd: scriptTmp,
      env: scratchEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(declared ? { timeout: timeoutMs } : {}),
    });
    const elapsedMs = Date.now() - startedAt;
    // A budget a script can raise for itself is a place to hide in, unless
    // something still notices it creeping. Nothing did: the reason
    // tracker-writer-lock-tests.mjs was killed rather than flagged is that
    // spending 29 of its 30 seconds looked exactly like spending 2 — the suite
    // reported "runs OK" either way, right up to the run where it did not.
    //
    // So the ceiling is not the only signal any more. A script that eats most
    // of its budget says so while it is still passing, which is the point at
    // which someone can act. This is a WARNING rather than a failure on
    // purpose: a loaded runner is a normal reason to be slow, and turning that
    // into a red run would trade one false failure for another.
    if (result !== null && elapsedMs > budgetMs * SLOW_SCRIPT_WARN_FRACTION) {
      warn(`${name} used ${(elapsedMs / 1000).toFixed(1)}s of its ${(budgetMs / 1000).toFixed(0)}s budget `
        + `(${Math.round((elapsedMs / budgetMs) * 100)}%) — it is passing, but it is close to being killed for time`);
    }
    // A signal kill (a timeout) has no exit status, so it can never match.
    const failure = result === null ? lastRunFailure() : null;
    const status = result !== null ? 0 : (failure?.status ?? null);
    const crashed = result === null && crashedBeforeRunning(failure);
    if (status === expectExit && !crashed) {
      pass(expectExit === 0 ? `${name} runs OK` : `${name} exits ${expectExit} as declared`);
    } else if (allowFail && status !== null && !crashed) {
      // Allowed, not confirmed: the exit depends on user data a developer's
      // copy may carry, so say what happened rather than why it might have.
      warn(`${name} exited ${status}, not the declared ${expectExit} (allowFail: its exit depends on user data)`);
    } else if (allowFail && crashed) {
      // allowFail says "a non-zero exit is expected here", never "any outcome
      // is fine". A script that dies with an uncaught exception did not run at
      // all, and reporting that as the expected failure is how #3440 sat in
      // main: cv-sync-check.mjs threw a ReferenceError at module scope, exited
      // 1 like a missing cv.md, and the suite printed the reassuring warning
      // for a script that never reached a single check.
      fail(`${name} crashed before running — allowFail covers an expected exit, not an uncaught error${formatRunFailure()}`);
    } else {
      // Include the child's exit status and streams. Without them a CI-only
      // failure arrives as a bare `<name> crashed`: no stack, no assertion
      // text, no exit code, and nothing a reader can act on.
      fail(`${name} ${crashed || status === null ? 'crashed' : `exited ${status}, not the declared ${expectExit}`}${formatRunFailure()}`);
    }
  }
} finally {
  rmSync(scriptTmp, { recursive: true, force: true });
}

try {
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-cv-facts-'));
  const hiddenScriptMetric = join(tmp, 'hidden-script-metric.html');
  const visibleMetric = join(tmp, 'visible-metric.html');
  writeFileSync(
    hiddenScriptMetric,
    '<html><body><script>const claim = "500 users";</script\t\n bar><p>Generated CV</p></body></html>'
  );
  // The metric must be one NO real cv.md can support. verify-cv-facts.mjs
  // validates against the LIVE source files, so a plausible fixture number
  // silently inverts this assertion for any user whose CV happens to contain
  // it: on a checkout whose cv.md read "~500 active users/month", the old
  // "500 users" fixture was genuinely SUPPORTED, verify-cv-facts correctly
  // declined to flag it, and this test reported that correct behaviour as a
  // miss. The test passed or failed depending on whose CV was checked out.
  writeFileSync(
    visibleMetric,
    '<html><body><p>Improved onboarding for 918273645 users.</p></body></html>'
  );

  const hiddenResult = run(NODE, ['verify-cv-facts.mjs', hiddenScriptMetric], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (hiddenResult !== null) {
    pass('verify-cv-facts strips script tags with irregular closing tags');
  } else {
    fail('verify-cv-facts treated script contents as visible CV facts');
  }

  const visibleResult = run(NODE, ['verify-cv-facts.mjs', visibleMetric], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (visibleResult === null) {
    pass('verify-cv-facts still flags visible unsupported metrics');
  } else {
    fail('verify-cv-facts missed a visible unsupported metric');
  }

  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  fail(`verify-cv-facts regression tests crashed: ${e.message}`);
}

// verify-ats.mjs: a clean single-column CV must score high and exit 0; an
// ATS-hostile CV (table layout + content image + missing headings) must exit 1
// and surface the specific issues. --json prints the full result on both paths,
// so we can assert on the reported issues even when the process exits non-zero.
let atsTmp;
try {
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-ats-'));
  atsTmp = tmp;
  const cleanCv = join(tmp, 'clean-cv.html');
  const hostileCv = join(tmp, 'hostile-cv.html');

  writeFileSync(
    cleanCv,
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>body{font-family:'Liberation Sans',Arial,sans-serif;} .section-title{font-weight:700;}</style></head><body>
<div class="header"><h1>Jane Smith</h1>
<div class="contact-row"><a href="mailto:jane@example.com">jane@example.com</a> | +1 415 555 0100 | Remote</div></div>
<div class="section"><div class="section-title">Professional Summary</div><p>Senior backend engineer with a
decade building reliable, high-throughput distributed systems on Kubernetes, with a focus on observability,
cost efficiency and clean, well-tested Python services used daily across the organization.</p></div>
<div class="section"><div class="section-title">Work Experience</div><p>Staff Engineer, Acme Corp
(2020-present). Built and operated the core payments platform across multiple engineering teams.</p></div>
<div class="section"><div class="section-title">Education</div><p>B.S. Computer Science, 2018.</p></div>
<div class="section"><div class="section-title">Skills</div><p>Python, Kubernetes, Docker, PostgreSQL.</p></div>
</body></html>`
  );
  writeFileSync(
    hostileCv,
    `<html><head><style>body{font-family:'Comic Sans MS',cursive;}</style></head><body>
<table><tr><td><img src="skills.png"></td><td><h1>John</h1></td></tr>
<tr><td>Experience</td><td>2020</td></tr></table></body></html>`
  );

  const cleanRes = spawnSync(NODE, ['verify-ats.mjs', cleanCv, '--json'], { cwd: ROOT, encoding: 'utf-8' });
  const cleanJson = JSON.parse(cleanRes.stdout);
  if (cleanRes.status === 0 && cleanJson.pass === true && cleanJson.score >= 80) {
    pass('verify-ats scores a clean single-column CV high and exits 0');
  } else {
    fail(`verify-ats mis-scored a clean CV (status=${cleanRes.status}, score=${cleanJson.score})`);
  }

  const hostileRes = spawnSync(NODE, ['verify-ats.mjs', hostileCv, '--json'], { cwd: ROOT, encoding: 'utf-8' });
  const hostileJson = JSON.parse(hostileRes.stdout);
  const messages = hostileJson.issues.map(i => i.message.toLowerCase());
  const flaggedTable = messages.some(m => m.includes('<table>'));
  const flaggedSections = messages.some(m => m.includes('education') || m.includes('skills'));
  if (hostileRes.status === 1 && hostileJson.pass === false && flaggedTable && flaggedSections) {
    pass('verify-ats fails an ATS-hostile CV and flags the table layout + missing sections');
  } else {
    fail(`verify-ats did not properly flag a hostile CV (status=${hostileRes.status}, table=${flaggedTable}, sections=${flaggedSections})`);
  }
} catch (e) {
  fail(`verify-ats regression tests crashed: ${e.message}`);
} finally {
  if (atsTmp) rmSync(atsTmp, { recursive: true, force: true });
}

// ── 3. LIVENESS CLASSIFICATION ──────────────────────────────────

console.log('\n3. Liveness classification');

try {
  const { classifyLiveness } = await import(pathToFileURL(join(ROOT, 'liveness-core.mjs')).href);

  const expiredChromeApply = classifyLiveness({
    finalUrl: 'https://example.com/jobs/closed-role',
    bodyText: 'Company Careers\nApply\nThe job you are looking for is no longer open.',
    applyControls: [],
  });
  if (expiredChromeApply.result === 'expired') {
    pass('Expired pages are not revived by nav/footer "Apply" text');
  } else {
    fail(`Expired page misclassified as ${expiredChromeApply.result}`);
  }

  const activeWorkdayPage = classifyLiveness({
    finalUrl: 'https://example.workday.com/job/123',
    bodyText: [
      '663 JOBS FOUND',
      'Senior AI Engineer',
      'Join our applied AI team to ship production systems, partner with customers, and own delivery across evaluation, deployment, and reliability.',
    ].join('\n'),
    applyControls: ['Apply for this Job'],
  });
  if (activeWorkdayPage.result === 'active') {
    pass('Visible apply controls still keep real job pages active');
  } else {
    fail(`Active job page misclassified as ${activeWorkdayPage.result}`);
  }

  const closedMycareersfuture = classifyLiveness({
    finalUrl: 'https://www.mycareersfuture.gov.sg/job/engineering/senior-staff-embedded-software-engineer',
    bodyText: [
      'Senior Staff Embedded Software Engineer',
      'MaxLinear Asia Singapore Private Limited',
      '9 applications    Posted 27 Oct 2025    Closed on 26 Nov 2025',
      'Applications have closed for this job',
      'Log in to Apply',
      "You'll need to log in with Singpass to verify your identity.",
      'Roles & Responsibilities: design, develop and maintain embedded firmware for broadband communications ICs.',
    ].join('\n'),
    applyControls: ['Log in to Apply'],
  });
  if (closedMycareersfuture.result === 'expired') {
    pass('Closed postings with "Applications have closed" banner are detected');
  } else {
    fail(`Closed mycareersfuture posting misclassified as ${closedMycareersfuture.result}`);
  }

  // Welcome to the Jungle renders its closure banner with a typographic
  // apostrophe (U+2019), not the ASCII one the pattern was spelled with, so the
  // banner never matched and a closed posting came back "uncertain".
  const closedWttjTypographicApostrophe = classifyLiveness({
    status: 200,
    finalUrl: 'https://www.welcometothejungle.com/fr/companies/acme/jobs/graphiste_paris',
    bodyText: [
      'Cette offre n’est plus disponible.',
      'ACME',
      'Graphiste & Motion Designer',
      'CDI    Paris    Télétravail fréquent',
      'Descriptif du poste : conception d’identités visuelles et d’animations pour les campagnes de la marque.',
      'Profil recherché : 3 ans d’expérience minimum, maîtrise de la suite Adobe et d’After Effects.',
    ].join('\n'),
    applyControls: [],
  });
  if (closedWttjTypographicApostrophe.result === 'expired') {
    pass('Closure banners written with a typographic apostrophe are detected');
  } else {
    fail(`WTTJ closed posting misclassified as ${closedWttjTypographicApostrophe.result}`);
  }

  // Same normalization, accent side: the pattern is spelled "pourvu" but the
  // page says "pourvue"/"déjà" with diacritics.
  const closedAccentedBanner = classifyLiveness({
    status: 200,
    finalUrl: 'https://example.fr/offres/directeur-artistique',
    bodyText: [
      'Offre déjà pourvue',
      'Directeur artistique',
      'Cette annonce est conservée à titre d’archive.',
      'Missions : direction de création, suivi de production, relation client sur les campagnes annuelles.',
    ].join('\n'),
    applyControls: [],
  });
  if (closedAccentedBanner.result === 'expired') {
    pass('Accented French closure banners are detected');
  } else {
    fail(`Accented French banner misclassified as ${closedAccentedBanner.result}`);
  }

  const cloudflareChallenge = classifyLiveness({
    status: 403,
    finalUrl: 'https://www.pracuj.pl/praca/sap-consultant,oferta,1004870954',
    bodyText: 'www.pracuj.pl\nJust a moment...\nPerforming security verification\nThis website uses a security service to protect against malicious bots.\nRay ID: a06489bab8bc4cd7\nPerformance and Security by Cloudflare',
    applyControls: [],
  });
  if (cloudflareChallenge.result === 'uncertain' && cloudflareChallenge.code === 'bot_challenge') {
    pass('Cloudflare anti-bot challenge pages are uncertain, not expired');
  } else {
    fail(`Cloudflare challenge misclassified as ${cloudflareChallenge.result} (${cloudflareChallenge.code})`);
  }

  const blocked403 = classifyLiveness({
    status: 403,
    finalUrl: 'https://www.pracuj.pl/praca/sap-consultant,oferta,1004870954',
    bodyText: 'Access denied',
    applyControls: [],
  });
  if (blocked403.result === 'uncertain' && blocked403.code === 'access_blocked') {
    pass('HTTP 403 is treated as access-blocked (uncertain), not expired');
  } else {
    fail(`HTTP 403 misclassified as ${blocked403.result} (${blocked403.code})`);
  }

  const activePolishPosting = classifyLiveness({
    status: 200,
    finalUrl: 'https://www.pracuj.pl/praca/administrator-sap-utilities-warszawa,oferta,1004870954',
    bodyText: 'Administrator SAP Utilities. Connectis_. Siedziba firmy: Chmielna 71, Warszawa. '.repeat(6),
    applyControls: ['Aplikuj Aplikuj na ogłoszenie'],
  });
  if (activePolishPosting.result === 'active') {
    pass('Polish "Aplikuj" apply control marks a loaded posting active');
  } else {
    fail(`Polish apply control not recognized: ${activePolishPosting.result} (${activePolishPosting.code})`);
  }

  const redirectedOffPosting = classifyLiveness({
    status: 200,
    requestedUrl: 'https://jobs.careers.microsoft.com/professionals/us/en/job/1399802/Intune-Support-Engineer',
    finalUrl: 'https://apply.careers.microsoft.com/careers?start=0&sort_by=timestamp',
    bodyText: 'Search jobs. Partner Marketing Manager. Software Engineer II. Browse all open positions at Microsoft. '.repeat(6),
    applyControls: ['Apply now', 'Apply now', 'Apply now'],
  });
  if (redirectedOffPosting.result === 'uncertain' && redirectedOffPosting.code === 'redirected_off_posting') {
    pass('Dead permalink 301 to a generic listing is uncertain, not revived by other jobs\' Apply buttons');
  } else {
    fail(`Off-posting redirect misclassified as ${redirectedOffPosting.result} (${redirectedOffPosting.code})`);
  }

  const redirectKeepingJobId = classifyLiveness({
    status: 200,
    requestedUrl: 'https://boards.greenhouse.io/acme/jobs/4567890',
    finalUrl: 'https://job-boards.greenhouse.io/acme/jobs/4567890',
    bodyText: 'Senior AI Engineer. Own delivery across evaluation, deployment, and reliability at Acme. '.repeat(6),
    applyControls: ['Apply for this Job'],
  });
  if (redirectKeepingJobId.result === 'active') {
    pass('Redirect that keeps the job id (board migration) still classifies active');
  } else {
    fail(`Same-job redirect misclassified as ${redirectKeepingJobId.result} (${redirectKeepingJobId.code})`);
  }

  // Liveness API rung (liveness-api.mjs) — the zero-token ATS first rung. We test the
  // pure URL→API resolution + SSRF guard; the network fetch is conservative by
  // construction (only 404/410→expired, 200→active, else null→Playwright fallback).
  const { resolveAtsApi, classifyAshbyBoard, checkLivenessViaApi } = await import(pathToFileURL(join(ROOT, 'liveness-api.mjs')).href);
  const ghApi = resolveAtsApi('https://boards.greenhouse.io/acme/jobs/4567890');
  if (ghApi?.ats === 'greenhouse' && ghApi.apiUrl === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/4567890') {
    pass('resolveAtsApi maps a Greenhouse posting to its per-job API URL');
  } else {
    fail(`Greenhouse API URL wrong: ${JSON.stringify(ghApi)}`);
  }
  const lvApi = resolveAtsApi('https://jobs.lever.co/acme/abc-123-def');
  if (lvApi?.ats === 'lever' && lvApi.apiUrl === 'https://api.lever.co/v0/postings/acme/abc-123-def') {
    pass('resolveAtsApi maps a Lever posting to its per-job API URL');
  } else {
    fail(`Lever API URL wrong: ${JSON.stringify(lvApi)}`);
  }
  const lvEuApi = resolveAtsApi('https://jobs.eu.lever.co/acme-eu/abc-123-def');
  if (lvEuApi?.ats === 'lever' && lvEuApi.apiUrl === 'https://api.eu.lever.co/v0/postings/acme-eu/abc-123-def') {
    pass('resolveAtsApi maps an EU Lever posting to api.eu.lever.co');
  } else {
    fail(`Lever EU API URL wrong: ${JSON.stringify(lvEuApi)}`);
  }
  if (resolveAtsApi('https://example.com/jobs/123') === null) {
    pass('resolveAtsApi returns null for non-ATS URLs (→ Playwright fallback)');
  } else {
    fail('resolveAtsApi should return null for an unknown host');
  }
  if (resolveAtsApi('https://boards.greenhouse.io/acme/jobs/not-a-number') === null
      && resolveAtsApi('http://boards.greenhouse.io/acme/jobs/123') === null) {
    pass('resolveAtsApi rejects non-numeric Greenhouse ids and non-https (SSRF guard)');
  } else {
    fail('resolveAtsApi guard failed (bad id or http accepted)');
  }
  // Workday: per-job CXS endpoint. Job path is genuinely multi-segment (a location
  // slug + a title slug), which is why resolveAtsApi's SSRF guard uses isSafeValue
  // (component-by-component) instead of the single-segment SAFE_SEGMENT check.
  const wdApi = resolveAtsApi('https://acme.wd1.myworkdayjobs.com/en-US/External/job/Toronto-ON-CAN/Agentic-AI-Engineer_R260010125');
  if (wdApi?.ats === 'workday'
      && wdApi.apiUrl === 'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External/job/Toronto-ON-CAN/Agentic-AI-Engineer_R260010125'
      && wdApi.parts?.jobPath === 'Toronto-ON-CAN/Agentic-AI-Engineer_R260010125') {
    pass('resolveAtsApi maps a Workday posting (with locale prefix) to its per-job CXS API URL');
  } else {
    fail(`Workday API URL wrong: ${JSON.stringify(wdApi)}`);
  }
  // Same tenant, no locale prefix in the URL.
  const wdApiNoLocale = resolveAtsApi('https://acme.wd5.myworkdayjobs.com/External/job/Toronto-ON-CAN/Agentic-AI-Engineer_R260010125');
  if (wdApiNoLocale?.ats === 'workday'
      && wdApiNoLocale.apiUrl === 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/job/Toronto-ON-CAN/Agentic-AI-Engineer_R260010125') {
    pass('resolveAtsApi maps a Workday posting without a locale prefix');
  } else {
    fail(`Workday (no locale) API URL wrong: ${JSON.stringify(wdApiNoLocale)}`);
  }
  // Directory traversal embedded inside one segment (not a bare ".." dot-segment,
  // which the URL parser itself would normalize away before we ever see it) must
  // still be rejected by isSafeValue's per-segment "..": ownership check.
  if (resolveAtsApi('https://acme.wd1.myworkdayjobs.com/External/job/Toronto-ON-CAN/Role..R1') === null) {
    pass('resolveAtsApi rejects ".." embedded in a Workday jobPath segment (SSRF guard)');
  } else {
    fail('resolveAtsApi should reject ".." embedded in a Workday jobPath segment');
  }
  if (resolveAtsApi('https://acme.notworkdayjobs.com/External/job/Toronto-ON-CAN/Role_R1') === null) {
    pass('resolveAtsApi returns null for a myworkdayjobs.com lookalike host');
  } else {
    fail('resolveAtsApi should not match a lookalike Workday host');
  }

  // Ashby: org-level board endpoint. Ashby pages are JS-rendered, so the browser/
  // static rung sees only nav/footer and false-reports live postings as expired —
  // the API rung must resolve the org board and confirm the specific job id.
  const AS_UUID = '00fd8024-7804-4278-a38b-c9d60d929dbb';
  const asApi = resolveAtsApi(`https://jobs.ashbyhq.com/deepgram/${AS_UUID}`);
  if (asApi?.ats === 'ashby'
      && asApi.apiUrl === 'https://api.ashbyhq.com/posting-api/job-board/deepgram'
      && asApi.parts?.jobId === AS_UUID
      && typeof asApi.interpret === 'function') {
    pass('resolveAtsApi maps an Ashby posting to its org job-board API URL');
  } else {
    fail(`Ashby API URL wrong: ${JSON.stringify(asApi)}`);
  }
  // The /application apply-link variant must resolve to the same org + job id.
  const asApply = resolveAtsApi(`https://jobs.ashbyhq.com/deepgram/${AS_UUID}/application`);
  if (asApply?.ats === 'ashby' && asApply.parts?.org === 'deepgram' && asApply.parts?.jobId === AS_UUID) {
    pass('resolveAtsApi handles the Ashby /application apply-link variant');
  } else {
    fail(`Ashby /application variant not resolved: ${JSON.stringify(asApply)}`);
  }
  // A bare board root (no job id) isn't a specific posting → null → Playwright.
  if (resolveAtsApi('https://jobs.ashbyhq.com/deepgram') === null) {
    pass('resolveAtsApi returns null for an Ashby board root (no job id)');
  } else {
    fail('resolveAtsApi should not treat an Ashby board root as a posting');
  }
  // classifyAshbyBoard — pure per-job liveness from the board payload.
  const asListed = classifyAshbyBoard({ jobs: [{ id: AS_UUID, isListed: true }] }, AS_UUID);
  const asAbsent = classifyAshbyBoard({ jobs: [{ id: 'other-id', isListed: true }] }, AS_UUID);
  const asUnlisted = classifyAshbyBoard({ jobs: [{ id: AS_UUID, isListed: false }] }, AS_UUID);
  const asBadShape = classifyAshbyBoard({ notJobs: [] }, AS_UUID);
  if (asListed?.result === 'active'
      && asAbsent?.result === 'expired'
      && asUnlisted?.result === 'expired'
      && asBadShape === null) {
    pass('classifyAshbyBoard: listed→active, absent/unlisted→expired, bad shape→null');
  } else {
    fail(`classifyAshbyBoard wrong: listed=${JSON.stringify(asListed)} absent=${JSON.stringify(asAbsent)} unlisted=${JSON.stringify(asUnlisted)} badShape=${JSON.stringify(asBadShape)}`);
  }
  // checkLivenessViaApi — the fetch/Response orchestration around the pure helpers:
  // a 200 with an org-level `interpret` (Ashby) is awaited and parsed, a per-job 200
  // (Greenhouse) is live as-is, 404 is expired, and a rejected fetch (network error,
  // or an aborted timeout — same code path) is inconclusive → null. Mock global.fetch
  // so no network is hit; restore it in finally.
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ status: 200, json: async () => ({ jobs: [{ id: AS_UUID, isListed: true }] }) });
    const cvAshbyLive = await checkLivenessViaApi(`https://jobs.ashbyhq.com/deepgram/${AS_UUID}`);
    globalThis.fetch = async () => ({ status: 200, json: async () => ({ jobs: [] }) });
    const cvAshbyGone = await checkLivenessViaApi(`https://jobs.ashbyhq.com/deepgram/${AS_UUID}`);
    // 200 but a malformed board (no `jobs` array): interpret returns null, so the
    // orchestration must fall through to null (→ Playwright), not a false verdict.
    globalThis.fetch = async () => ({ status: 200, json: async () => ({}) });
    const cvAshbyMalformed = await checkLivenessViaApi(`https://jobs.ashbyhq.com/deepgram/${AS_UUID}`);
    globalThis.fetch = async () => ({ status: 200 });
    const cvGhLive = await checkLivenessViaApi('https://boards.greenhouse.io/acme/jobs/4567890');
    globalThis.fetch = async () => ({ status: 404 });
    const cvGone = await checkLivenessViaApi('https://boards.greenhouse.io/acme/jobs/4567890');
    globalThis.fetch = async () => { throw new Error('network down'); };
    const cvErr = await checkLivenessViaApi('https://boards.greenhouse.io/acme/jobs/4567890');
    const wdUrl = 'https://acme.wd1.myworkdayjobs.com/External/job/Toronto-ON-CAN/Agentic-AI-Engineer_R260010125';
    globalThis.fetch = async () => ({ status: 200 });
    const cvWdLive = await checkLivenessViaApi(wdUrl);
    globalThis.fetch = async () => ({ status: 404 });
    const cvWdGone = await checkLivenessViaApi(wdUrl);
    // Lever: unlike Greenhouse/Workday, a 404 on the public postings API is NOT
    // authoritative proof of removal. Lever's Confidential/Internal Postings
    // feature explicitly excludes some live postings from the public API while
    // the direct jobs.lever.co page keeps serving them (real-world repro:
    // Simbe Robotics and Enable postings, 2026-08-09 — api.lever.co 404s, the
    // live page renders the real title with a working Apply control). So a
    // Lever 404/410 must fall through to Playwright (null), not conclude
    // expired outright, the same "let the browser decide" treatment other
    // ambiguous cases already get.
    const lvUrl = 'https://jobs.lever.co/acme/abc-123-def';
    globalThis.fetch = async () => ({ status: 200 });
    const cvLvLive = await checkLivenessViaApi(lvUrl);
    globalThis.fetch = async () => ({ status: 404 });
    const cvLvGone = await checkLivenessViaApi(lvUrl);
    globalThis.fetch = async () => ({ status: 410 });
    const cvLvGone410 = await checkLivenessViaApi(lvUrl);
    if (cvAshbyLive?.result === 'active' && cvAshbyLive?.code === 'ashby_api_ok'
        && cvAshbyGone?.result === 'expired' && cvAshbyGone?.code === 'ashby_api_unlisted'
        && cvAshbyMalformed === null
        && cvGhLive?.result === 'active'
        && cvGone?.result === 'expired'
        && cvErr === null
        && cvWdLive?.result === 'active' && cvWdLive?.code === 'workday_api_ok'
        && cvWdGone?.result === 'expired' && cvWdGone?.code === 'workday_api_gone') {
      pass('checkLivenessViaApi: 200→interpret (Ashby), malformed→null, greenhouse/workday 200→active, 404→expired, fetch error→null');
    } else {
      fail(`checkLivenessViaApi wrong: ashbyLive=${JSON.stringify(cvAshbyLive)} ashbyGone=${JSON.stringify(cvAshbyGone)} malformed=${JSON.stringify(cvAshbyMalformed)} ghLive=${JSON.stringify(cvGhLive)} gone=${JSON.stringify(cvGone)} err=${JSON.stringify(cvErr)} wdLive=${JSON.stringify(cvWdLive)} wdGone=${JSON.stringify(cvWdGone)}`);
    }
    if (cvLvLive?.result === 'active' && cvLvLive?.code === 'lever_api_ok'
        && cvLvGone === null
        && cvLvGone410 === null) {
      pass('checkLivenessViaApi: Lever 200→active, 404/410→null (inconclusive, unlike Greenhouse/Workday — Confidential Postings can 404 on the public API while still live)');
    } else {
      fail(`checkLivenessViaApi (Lever) wrong: live=${JSON.stringify(cvLvLive)} gone404=${JSON.stringify(cvLvGone)} gone410=${JSON.stringify(cvLvGone410)}`);
    }
  } finally {
    globalThis.fetch = origFetch;
  }

  // Headed-fallback-on-challenge path (liveness-browser.mjs). Fake Playwright
  // pages script the goto/evaluate calls so we can exercise the wrapper without
  // launching a browser. checkUrlLiveness reads the page repeatedly while it
  // hydrates, so the fakes tell the two reads apart by the extractor passed in:
  // only the apply-control extractor calls querySelectorAll.
  const { checkUrlLiveness, checkUrlLivenessWithFallback, isChallengeResult, jitteredDelayMs } =
    await import(pathToFileURL(join(ROOT, 'liveness-browser.mjs')).href);

  const disabled = jitteredDelayMs(0) === 0 && jitteredDelayMs(-1) === 0;
  let inRange = true;
  for (let i = 0; i < 200; i += 1) {
    const d = jitteredDelayMs(5000);
    if (d < 5000 || d >= 10000) { inRange = false; break; }
  }
  if (disabled && inRange) {
    pass('jitteredDelayMs returns 0 when disabled and stays in [base, 2*base)');
  } else {
    fail(`jitteredDelayMs out of spec (disabled=${disabled}, inRange=${inRange})`);
  }

  const isControlsRead = (fn) => String(fn).includes('querySelectorAll');
  const fakePage = ({ status, finalUrl, bodyText, applyControls }) => ({
    async goto() { return { status: () => status }; },
    async waitForTimeout() {},
    url() { return finalUrl; },
    async evaluate(fn) { return isControlsRead(fn) ? applyControls : bodyText; },
  });
  const URL = 'https://www.pracuj.pl/praca/sap-consultant,oferta,1004870954';
  const challengePage = () => fakePage({
    status: 403,
    finalUrl: URL,
    bodyText: 'Just a moment... Performing security verification. Ray ID: abc123. Cloudflare.',
    applyControls: [],
  });
  const livePage = () => fakePage({
    status: 200,
    finalUrl: URL,
    bodyText: 'Administrator SAP Utilities. '.repeat(20),
    applyControls: ['Apply for this job'],
  });

  // --- iframe-embedded postings -------------------------------------------
  // Some ATS (iCIMS) render the posting inside a same-origin iframe and leave
  // the top-level document as a ~13-character shell, which used to reach
  // insufficient_content and return `expired` for a live job.
  //
  // `fillAfter` models the part that made the first attempt at this fix a
  // no-op: the frame ATTACHES immediately but POPULATES late (measured 0 chars
  // at 2000ms, 3887 at 4000ms), so a reader that does not wait sees an empty
  // document and nothing changes.
  const framedPage = ({ status = 200, finalUrl, shellText = 'Careers', frames = [] }) => {
    const page = {};
    const main = { __main: true };
    const built = frames.map((spec) => {
      let textReads = 0;
      return {
        url: () => spec.url,
        async evaluate(fn) {
          // Both extractors mention innerText, so discriminate on the selector
          // call that only the apply-control extractor makes.
          const isControls = isControlsRead(fn);
          const filled = textReads >= (spec.fillAfter ?? 0);
          if (!isControls) textReads += 1;
          if (isControls) return filled ? (spec.controls ?? []) : [];
          return filled ? spec.text : '';
        },
      };
    });
    Object.assign(page, {
      async goto() { return { status: () => status }; },
      async waitForTimeout() {},
      url() { return finalUrl; },
      frames() { return [main, ...built]; },
      mainFrame() { return main; },
      async evaluate(fn) { return isControlsRead(fn) ? [] : shellText; },
    });
    return page;
  };

  const SHELL = 'https://careers-example.icims.com/jobs/1/role/job';
  const framedLive = await checkUrlLiveness(framedPage({
    finalUrl: SHELL,
    frames: [{ url: SHELL + '?in_iframe=1', text: 'Senior Analyst. '.repeat(30), controls: ['Apply for this job online'], fillAfter: 2 }],
  }), SHELL);
  if (framedLive.result === 'active' && framedLive.code === 'apply_control_visible') {
    pass('liveness reads a same-origin posting frame that populates late');
  } else {
    fail(`late-filling posting frame not read: ${JSON.stringify(framedLive)}`);
  }

  const crossOrigin = await checkUrlLiveness(framedPage({
    finalUrl: SHELL,
    frames: [{ url: 'https://ads.example.net/widget', text: 'Sponsored. '.repeat(30), controls: ['Apply now'] }],
  }), SHELL);
  if (crossOrigin.result === 'expired' && crossOrigin.code === 'insufficient_content') {
    pass('a cross-origin frame cannot make an empty shell look active');
  } else {
    fail(`cross-origin frame leaked into the verdict: ${JSON.stringify(crossOrigin)}`);
  }

  const goneWithFrame = await checkUrlLiveness(framedPage({
    status: 410,
    finalUrl: SHELL,
    frames: [{ url: SHELL + '?in_iframe=1', text: 'Job not found. '.repeat(30), controls: ['Apply for this job online'] }],
  }), SHELL);
  if (goneWithFrame.result === 'expired' && goneWithFrame.code === 'http_gone') {
    pass('HTTP 410 still wins over a frame carrying an apply control');
  } else {
    fail(`410 precedence lost to frame aggregation: ${JSON.stringify(goneWithFrame)}`);
  }

  // A 410 must not pay the frame wait: the status already decided it, and a
  // dead posting whose error page renders into an iframe would otherwise wait
  // for that error page to fill before saying what it knew at byte one.
  // Count only the 500ms frame-wait ticks.
  let pollWaits = 0;
  const gonePage = framedPage({
    status: 410,
    finalUrl: SHELL,
    frames: [{ url: SHELL + '?in_iframe=1', text: '', controls: [], fillAfter: 999 }],
  });
  gonePage.waitForTimeout = async (ms) => { if (ms === 500) pollWaits += 1; };
  const goneFast = await checkUrlLiveness(gonePage, SHELL);
  if (goneFast.result === 'expired' && goneFast.code === 'http_gone' && pollWaits === 0) {
    pass('HTTP 410 short-circuits before the frame wait (no wait spent)');
  } else {
    fail(`410 did not short-circuit: ${JSON.stringify(goneFast)}, poll waits=${pollWaits}`);
  }

  const legacyDouble = await checkUrlLiveness(livePage(), URL);
  if (legacyDouble.result === 'active') {
    pass('a page object without frames()/mainFrame() still returns a top-level verdict');
  } else {
    fail(`frame aggregation broke a frameless page object: ${JSON.stringify(legacyDouble)}`);
  }

  // --- BambooHR reload retry -----------------------------------------------
  // BambooHR's client bundle can crash mid-render and leave the page stuck on
  // a bare loading spinner — the posting is untouched, but the page reads as
  // insufficient_content (see BAMBOOHR_HOSTS in liveness-browser.mjs).
  // This must never surface as `expired`, whether or not the retry succeeds.
  // Synthetic — checkUrlLiveness never makes a real request in this test
  // (goto/reload are faked below), so this only needs to be *shaped* like a
  // bamboohr.com posting URL, not point at a real, permanently-live one.
  const BAMBOO_URL = 'https://example-co.bamboohr.com/careers/1';
  const bambooRetryPage = ({ reloadBodyText, reloadApplyControls = [] }) => {
    // Empty render until reload() is called, the given render after it.
    let reloaded = false;
    return {
      async goto() { return { status: () => 200 }; },
      async waitForTimeout() {},
      url() { return BAMBOO_URL; },
      async evaluate(fn) {
        if (isControlsRead(fn)) return reloaded ? reloadApplyControls : [];
        return reloaded ? reloadBodyText : '';
      },
      async reload() { reloaded = true; return { status: () => 200 }; },
    };
  };

  const bambooRecovered = await checkUrlLiveness(
    bambooRetryPage({ reloadBodyText: 'Senior QA Automation Engineer. '.repeat(20), reloadApplyControls: ['Apply for This Job'] }),
    BAMBOO_URL
  );
  if (bambooRecovered.result === 'active' && bambooRecovered.reason.includes('after BambooHR reload retry')) {
    pass('a BambooHR render-race is cleared by a reload retry');
  } else {
    fail(`BambooHR reload retry did not recover a live posting: ${JSON.stringify(bambooRecovered)}`);
  }

  const bambooStillEmpty = await checkUrlLiveness(
    bambooRetryPage({ reloadBodyText: '', reloadApplyControls: [] }),
    BAMBOO_URL
  );
  if (bambooStillEmpty.result === 'uncertain' && bambooStillEmpty.code === 'bamboohr_render_retry_failed') {
    pass('a BambooHR page still empty after reload is uncertain, never expired');
  } else {
    fail(`BambooHR retry-still-empty should be uncertain, not expired: ${JSON.stringify(bambooStillEmpty)}`);
  }

  // A reload that lands on the generic job-list route (not the specific
  // posting) is the same "didn't find the posting" category as an empty
  // body — never trusted as expired either.
  const bambooReloadToListing = await checkUrlLiveness(
    bambooRetryPage({ reloadBodyText: '12 jobs found', reloadApplyControls: [] }),
    BAMBOO_URL
  );
  if (bambooReloadToListing.result === 'uncertain' && bambooReloadToListing.code === 'bamboohr_render_retry_failed') {
    pass('a BambooHR reload landing on the job-list page is uncertain, never expired');
  } else {
    fail(`BambooHR retry-to-listing-page should be uncertain, not expired: ${JSON.stringify(bambooReloadToListing)}`);
  }

  let nonBambooReloadCalled = false;
  const nonBambooPage = fakePage({ status: 200, finalUrl: URL, bodyText: '', applyControls: [] });
  nonBambooPage.reload = async () => { nonBambooReloadCalled = true; return { status: () => 200 }; };
  const nonBambooInsufficient = await checkUrlLiveness(nonBambooPage, URL);
  if (nonBambooInsufficient.result === 'uncertain' && nonBambooInsufficient.code === 'empty_page' && !nonBambooReloadCalled) {
    pass('the reload retry is scoped to BambooHR hosts only');
  } else {
    fail(`reload retry leaked to a non-BambooHR host: ${JSON.stringify(nonBambooInsufficient)}, reloadCalled=${nonBambooReloadCalled}`);
  }

  if (isChallengeResult({ result: 'uncertain', code: 'bot_challenge' }) &&
      isChallengeResult({ result: 'uncertain', code: 'access_blocked' }) &&
      !isChallengeResult({ result: 'expired', code: 'http_gone' }) &&
      !isChallengeResult({ result: 'active', code: 'apply_control_visible' })) {
    pass('isChallengeResult flags only bot_challenge/access_blocked uncertains');
  } else {
    fail('isChallengeResult misclassified a result');
  }

  const fellBackToActive = await checkUrlLivenessWithFallback(challengePage(), URL, {
    getHeadedPage: async () => livePage(),
  });
  if (fellBackToActive.result === 'active') {
    pass('Headed fallback recovers a challenge-blocked page as active');
  } else {
    fail(`Headed fallback did not recover page: ${fellBackToActive.result} (${fellBackToActive.code})`);
  }

  const noProvider = await checkUrlLivenessWithFallback(challengePage(), URL, {});
  if (noProvider.result === 'uncertain' && noProvider.code === 'bot_challenge') {
    pass('No fallback provider keeps the original challenge result');
  } else {
    fail(`Missing provider changed result to ${noProvider.result} (${noProvider.code})`);
  }

  const stillBlocked = await checkUrlLivenessWithFallback(challengePage(), URL, {
    getHeadedPage: async () => challengePage(),
  });
  if (stillBlocked.result === 'uncertain' && stillBlocked.code === 'bot_challenge'
      && /headed retry also blocked/.test(stillBlocked.reason)) {
    pass('Persistent challenge stays uncertain after headed retry (never upgraded to expired)');
  } else {
    fail(`Persistent challenge mishandled: ${stillBlocked.result} (${stillBlocked.code})`);
  }

  const noHeadedAvailable = await checkUrlLivenessWithFallback(challengePage(), URL, {
    getHeadedPage: async () => null, // headed launch failed (no display)
  });
  if (noHeadedAvailable.result === 'uncertain' && noHeadedAvailable.code === 'bot_challenge') {
    pass('Headless-only environment degrades to original challenge result');
  } else {
    fail(`No-display degrade path wrong: ${noHeadedAvailable.result} (${noHeadedAvailable.code})`);
  }

  // SSRF guard — `rejectPrivateOrInvalid` has to refuse every URL whose host
  // resolves to loopback / private / link-local space. The earlier guard only
  // matched literal IPv4 patterns and bracketless IPv6, so several Chromium-
  // routable bypasses (0.0.0.0, [::], [::1] (bracketed), [::ffff:127.0.0.1],
  // localhost.) slipped through. These cases keep that regression covered.
  const { rejectPrivateOrInvalid, setHostResolver } = await import(
    pathToFileURL(join(ROOT, 'liveness-browser.mjs')).href
  );
  const blockCases = [
    ['http://0.0.0.0/admin', 'IPv4 all-zeros (Linux routes to loopback)'],
    ['http://[::]/', 'IPv6 all-zeros (Linux routes to loopback)'],
    ['http://[::1]/', 'IPv6 loopback (brackets included in url.hostname)'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped IPv6 loopback (dotted form)'],
    ['http://[::ffff:7f00:1]/', 'IPv4-mapped IPv6 loopback (hex form)'],
    ['http://[::ffff:169.254.169.254]/', 'IPv4-mapped IPv6 link-local (cloud metadata)'],
    ['http://[fc00::1]/', 'IPv6 ULA (private)'],
    ['http://[fd00::1]/', 'IPv6 ULA fd00::/8 (RFC 4193)'],
    ['http://[fe80::1]/', 'IPv6 link-local'],
    ['http://[fe90::1]/', 'IPv6 link-local fe80::/10 (not just fe80:)'],
    ['http://localhost./', 'FQDN-trailing-dot localhost'],
    ['http://localhost.localdomain/', 'localhost.localdomain alias'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata IPv4 link-local'],
    ['http://10.0.0.5/', 'IPv4 RFC1918'],
  ];
  let blockMissed = 0;
  for (const [url, label] of blockCases) {
    const verdict = rejectPrivateOrInvalid(url);
    if (verdict?.code !== 'blocked_host') {
      fail(`SSRF guard missed ${label}: ${url} → ${verdict ? verdict.code : 'allowed'}`);
      blockMissed += 1;
    }
  }
  if (blockMissed === 0) pass(`SSRF guard blocks ${blockCases.length} known bypass vectors`);

  const allowCases = [
    'https://boards.greenhouse.io/example/jobs/123',
    'https://jobs.lever.co/example/abc-def',
    'https://example.com/careers/role',
    'https://www.pracuj.pl/praca/role,oferta,1234567',
  ];
  let allowDenied = 0;
  for (const url of allowCases) {
    if (rejectPrivateOrInvalid(url) !== null) {
      fail(`SSRF guard false-positive on legitimate ATS URL: ${url}`);
      allowDenied += 1;
    }
  }
  if (allowDenied === 0) pass('SSRF guard lets legitimate ATS URLs through');

  const protoCase = rejectPrivateOrInvalid('file:///etc/passwd');
  if (protoCase?.code === 'unsupported_protocol') {
    pass('SSRF guard rejects unsupported protocol');
  } else {
    fail(`SSRF guard let unsupported protocol through: ${protoCase?.code ?? 'allowed'}`);
  }

  // SSRF redirect routing tests.
  //
  // The resolver is injected rather than mocked on the dns module (#2386): the
  // guard calls the ESM namespace bindings of `dns/promises`, which no mock can
  // reach, so the previous `mock.method(dnsModule.default, …)` stub never
  // applied. The test passed anyway — the real resolver found nothing for
  // `ssrf-blocked-host.local` and the guard blocked on the empty address list,
  // so the loopback-rejection branch under test was never executed, and each
  // run spent ~12s waiting for mDNS/LLMNR to time out. The injected resolver
  // hands back a loopback address, which is the case that matters, and keeps
  // the whole section off the network.
  const restoreHostResolver = setHostResolver(async (hostname) => {
    if (hostname === 'ssrf-blocked-host.local') return ['127.0.0.1'];
    // A shut-down analytics vendor: the name still appears in the page, but it
    // resolves to nothing at all. Distinct from the loopback case above, which
    // resolves fine and is blocked for being private.
    if (hostname === 'dead-analytics-vendor.invalid') return [];
    // Every other host in this section is a stand-in for a normal public site.
    return ['93.184.216.34'];
  });

  try {
    let routeCallback = null;
    const mockPageInstance = {
      _blockedByGuard: null,
      async route(pattern, callback) {
        routeCallback = callback;
      },
      async goto() {
        if (routeCallback) {
          let aborted = false;
          const mockRoute = {
            request: () => ({ url: () => 'http://ssrf-blocked-host.local/sensitive-internal' }),
            abort: async () => {
              aborted = true;
            },
            continue: async () => {}
          };
          await routeCallback(mockRoute);
          if (aborted) {
            throw new Error('net::ERR_BLOCKED_BY_CLIENT');
          }
        }
        return { status: () => 200 };
      },
      async waitForTimeout() {},
      url() { return 'https://example.com/redirected'; },
      async evaluate() { return 'body text'; }
    };

    const redirectResult = await checkUrlLiveness(mockPageInstance, 'https://example.com/public-landing');
    // The reason has to name the loopback address. `blocked_host` alone is also
    // what an unresolvable host produces, so asserting on the code by itself
    // cannot tell "guard rejected 127.0.0.1" from "host resolved to nothing" —
    // that ambiguity is exactly what hid the broken mock (#2386).
    if (redirectResult.result === 'uncertain' && redirectResult.code === 'blocked_host'
        && /private target IP 127\.0\.0\.1/.test(redirectResult.reason ?? '')) {
      pass('SSRF redirect guard blocks redirects/subresources to private IPs via routing');
    } else {
      fail(`SSRF redirect guard failed to block: ${JSON.stringify(redirectResult)}`);
    }

    let legitimateRouteCallback = null;
    const mockPageLegitimate = {
      _blockedByGuard: null,
      async route(pattern, callback) {
        legitimateRouteCallback = callback;
      },
      async goto() {
        if (legitimateRouteCallback) {
          let continued = false;
          const mockRoute = {
            request: () => ({ url: () => 'https://example.com/assets/logo.png' }),
            abort: async () => {},
            continue: async () => {
              continued = true;
            }
          };
          await legitimateRouteCallback(mockRoute);
          if (!continued) {
            throw new Error('Blocked legitimate request');
          }
        }
        return { status: () => 200 };
      },
      async waitForTimeout() {},
      url() { return 'https://example.com'; },
      async evaluate(fn) {
        const fnStr = fn.toString();
        if (fnStr.includes('body')) {
          return 'legitimate page body';
        }
        return ['Apply'];
      }
    };

    const legitimateResult = await checkUrlLiveness(mockPageLegitimate, 'https://example.com');
    if (legitimateResult.result === 'active') {
      pass('SSRF redirect guard allows legitimate subresource requests');
    } else {
      fail(`SSRF redirect guard blocked legitimate requests: ${JSON.stringify(legitimateResult)}`);
    }

    // A dead THIRD-PARTY host must not decide the verdict for the posting.
    // Analytics vendors get shut down and their script tags stay in career
    // pages forever; without this, every posting on such a page reports
    // uncertain. The route double here is real-shaped (isNavigationRequest and
    // frame), because that is the only way the guard can tell a subresource
    // from the main document.
    const deadThirdParty = (navigation) => {
      let cb = null;
      let abortCount = 0;
      const main = {};
      return {
        _blockedByGuard: null,
        // The verdict is only half the claim. The other half is that the egress
        // guard still ABORTS the request in both cases — relaxing the verdict
        // must not quietly start letting a non-resolving host through.
        get abortCount() { return abortCount; },
        mainFrame: () => main,
        async route(_pattern, callback) { cb = callback; },
        async goto() {
          await cb({
            request: () => ({
              url: () => 'https://dead-analytics-vendor.invalid/widget.js',
              isNavigationRequest: () => navigation,
              frame: () => (navigation ? main : {}),
            }),
            abort: async () => { abortCount += 1; },
            continue: async () => {},
          });
          return { status: () => 200 };
        },
        async waitForTimeout() {},
        url: () => 'https://careers.example.com/jobs/1',
        async evaluate(fn) {
          return String(fn).includes('querySelectorAll') ? ['Apply for this job'] : 'Senior Analyst. '.repeat(30);
        },
      };
    };

    const subresourcePage = deadThirdParty(false);
    const subresourceDead = await checkUrlLiveness(subresourcePage, 'https://careers.example.com/jobs/1');
    if (subresourceDead.result === 'active' && subresourcePage.abortCount === 1) {
      pass('a dead third-party subresource is still aborted, but no longer decides the verdict');
    } else {
      fail(
        `dead third-party subresource handled wrongly: ${JSON.stringify(subresourceDead)}, ` +
        `aborts=${subresourcePage.abortCount} (want result active, aborts 1)`
      );
    }

    const mainDocPage = deadThirdParty(true);
    const mainDocDead = await checkUrlLiveness(mainDocPage, 'https://careers.example.com/jobs/1');
    if (mainDocDead.result === 'uncertain' && mainDocDead.code === 'dns_no_addresses' && mainDocPage.abortCount === 1) {
      pass('a non-resolving MAIN DOCUMENT is aborted and reads uncertain (dns_no_addresses), not blocked_host');
    } else {
      fail(
        `main-document DNS failure handled wrongly: ${JSON.stringify(mainDocDead)}, ` +
        `aborts=${mainDocPage.abortCount} (want uncertain/dns_no_addresses, aborts 1)`
      );
    }
  } finally {
    // Always put the real resolver back, even if an assertion above throws:
    // a leaked stub would silently answer for every later suite in this process.
    restoreHostResolver();
  }
} catch (e) {
  fail(`Liveness classification tests crashed: ${e.message}`);
}

// ── 3b. ARCHIVE-POSTING EGRESS GUARD (#1956) ────────────────────
//
// archive-posting.mjs drives Playwright at a URL the user pastes in (or that
// arrives via data/pipeline.md), and used to navigate with zero egress
// safeguards — so a hostile posting link could render an internal service or a
// cloud metadata endpoint straight into a PDF. It now wires up the *same*
// two-layer guard liveness-browser.mjs exports rather than carrying a second
// implementation, so these tests pin the wiring, not a copy of the guard logic.
try {
  const { archiveUrl, installEgressGuard } = await import(
    pathToFileURL(join(ROOT, 'archive-posting.mjs')).href
  );
  const { setHostResolver } = await import(
    pathToFileURL(join(ROOT, 'liveness-browser.mjs')).href
  );

  // Stop each run the moment navigation starts: everything after goto() is PDF
  // rendering and a writeFile into jds/, which these assertions don't need and
  // must not perform.
  const STOP = 'archive-guard-test-stop';

  // Records what the guard did, and never lets the flow reach page.pdf().
  function makeMockBrowser({ landedUrl = 'https://example.com/job/1' } = {}) {
    const state = { routeCallback: null, contextCreated: false, closed: false };
    const context = {
      async route(pattern, callback) {
        state.pattern = pattern;
        state.routeCallback = callback;
      },
      async newPage() {
        return {
          async goto() {
            if (state.stopAtGoto) throw new Error(STOP);
            return { status: () => 200 };
          },
          url: () => landedUrl,
          async waitForTimeout() { throw new Error(STOP); },
          async title() { return ''; },
          async $eval() { return ''; },
        };
      },
      async close() { state.closed = true; },
    };
    const browser = {
      async newContext() {
        state.contextCreated = true;
        return context;
      },
    };
    return { browser, state };
  }

  // Drives a registered route handler and reports the verdict it reached.
  async function runGuard(requestUrl) {
    const { browser, state } = makeMockBrowser();
    state.stopAtGoto = true;
    await archiveUrl(browser, 'https://example.com/job/1').catch(() => {});
    if (!state.routeCallback) return { registered: false };
    let verdict = null;
    await state.routeCallback({
      request: () => ({ url: () => requestUrl }),
      abort: async (code) => { verdict = { action: 'abort', code }; },
      continue: async () => { verdict = { action: 'continue' }; },
    });
    return { registered: true, verdict, pattern: state.pattern };
  }

  // 1. Pre-navigation refusal — an obviously-internal target must not reach
  //    Playwright at all, so no context is ever created.
  const { browser: preBrowser, state: preState } = makeMockBrowser();
  let preError = null;
  await archiveUrl(preBrowser, 'http://169.254.169.254/latest/meta-data/')
    .catch((err) => { preError = err; });
  if (preError && /restricted destination/.test(preError.message) && !preState.contextCreated) {
    pass('archive-posting refuses a private-IP target before opening a browser context');
  } else {
    fail(`archive-posting pre-navigation guard failed: error=${preError?.message ?? 'none'}, contextCreated=${preState.contextCreated}`);
  }

  // 2. The guard is registered on the context for every request, not just the
  //    page's first hop — a page-scoped route wouldn't cover the whole flow.
  const registration = await runGuard('https://example.com/assets/logo.png');
  if (registration.registered && registration.pattern === '**/*') {
    pass('archive-posting registers the egress guard on the context for all requests');
  } else {
    fail(`archive-posting did not register a context-wide route: ${JSON.stringify(registration)}`);
  }

  // 3. Legitimate subresources still go through — a guard that blocks
  //    everything would pass a naive block-only test while breaking archiving.
  if (registration.verdict?.action === 'continue') {
    pass('archive-posting egress guard allows legitimate public requests');
  } else {
    fail(`archive-posting egress guard blocked a legitimate request: ${JSON.stringify(registration.verdict)}`);
  }

  // 4. Redirect hop straight to a literal private address.
  const literalHop = await runGuard('http://10.0.0.5/internal');
  if (literalHop.verdict?.action === 'abort' && literalHop.verdict.code === 'blockedbyclient') {
    pass('archive-posting egress guard blocks a redirect hop to a literal private IP');
  } else {
    fail(`archive-posting egress guard let a private-IP hop through: ${JSON.stringify(literalHop.verdict)}`);
  }

  // 5. The case the literal-host check cannot see: a public-looking hostname
  //    that resolves into loopback. Without the DNS layer this hop is allowed,
  //    which is the whole reason validateUrlSecurity is reused here.
  const restoreArchiveResolver = setHostResolver(async (hostname) => (
    hostname === 'ssrf-blocked-host.local' ? ['127.0.0.1'] : ['93.184.216.34']
  ));
  try {
    const dnsHop = await runGuard('http://ssrf-blocked-host.local/sensitive-internal');
    if (dnsHop.verdict?.action === 'abort' && dnsHop.verdict.code === 'blockedbyclient') {
      pass('archive-posting egress guard blocks a hostname that resolves to loopback');
    } else {
      fail(`archive-posting egress guard missed a DNS-resolved private target: ${JSON.stringify(dnsHop.verdict)}`);
    }
  } finally {
    restoreArchiveResolver();
  }

  // 6. Landed-URL re-check after navigation. A first-hop-only check is the
  //    classic miss, so the settled URL is asserted too.
  const { browser: landedBrowser } = makeMockBrowser({ landedUrl: 'http://169.254.169.254/latest/meta-data/' });
  let landedError = null;
  await archiveUrl(landedBrowser, 'https://example.com/job/1')
    .catch((err) => { landedError = err; });
  if (landedError && /after redirect/.test(landedError.message)) {
    pass('archive-posting refuses to render a page that landed on a private address');
  } else {
    fail(`archive-posting landed-URL guard failed: ${landedError?.message ?? 'no error'}`);
  }

  if (typeof installEgressGuard !== 'function') {
    fail('archive-posting does not export installEgressGuard');
  }
} catch (e) {
  fail(`archive-posting egress guard tests crashed: ${e.message}`);
}

// ── 4. DASHBOARD BUILD ──────────────────────────────────────────

if (!QUICK) {
  console.log('\n4. Dashboard build');
  let hasGo = false;
  try {
    execSync('go version', { stdio: 'ignore' });
    hasGo = true;
  } catch {}
  if (!hasGo) {
    warn('Dashboard build skipped — go compiler not in env');
  } else {
    const isWindows = process.platform === 'win32';
    const dashboardBuildTmp = mkdtempSync(join(tmpdir(), 'career-dashboard-build-'));
    const outPath = join(dashboardBuildTmp, isWindows ? 'career-dashboard-test.exe' : 'career-dashboard-test');
    const goEnv = { ...process.env };
    if (isWindows && !goEnv.GOCACHE) {
      goEnv.GOCACHE = join(tmpdir(), 'career-ops-go-build-cache');
    }
    if (goEnv.GOCACHE) {
      try { mkdirSync(goEnv.GOCACHE, { recursive: true }); } catch (e) {}
    }
    const goBuild = run('go', ['build', '-o', outPath, '.'], {
      cwd: join(ROOT, 'dashboard'),
      env: goEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
    });
    if (goBuild !== null) {
      pass('Dashboard compiles');
      try { rmSync(outPath, { force: true }); } catch (e) {}
    } else {
      fail('Dashboard build failed');
    }
    try { rmSync(dashboardBuildTmp, { recursive: true, force: true }); } catch (e) {}
  }
} else {
  console.log('\n4. Dashboard build (skipped --quick)');
}

// ── 7. ABSOLUTE PATH CHECK ──────────────────────────────────────

console.log('\n7. Absolute path check');

// Same git grep approach: only scans tracked files. Untracked AI tool
// outputs, local debate artifacts, etc. can't false-positive here.
// stderr is piped (captured, not printed) so a failure below can report it.
const absPathRaw = run(
  'git',
  ['grep', '-n', '/Users/', '--', '*.mjs', '*.sh', '*.md', '*.go', '*.yml'],
  { stdio: ['pipe', 'pipe', 'pipe'] }
);
// run() returns null for every failure, but only exit 1 means "no matches".
// Any other failure (git missing, not a repository, the timeout) means the
// scan never ran, and reading that null as "no absolute paths" would pass
// this check without checking anything.
const absPathScanFailed = absPathRaw === null && lastRunFailure()?.status !== 1;
// The old shell pipeline's `grep -v` exclusions, now as a JS filter.
const ABS_PATH_EXCLUDE = ['README.md', 'LICENSE', 'CLAUDE.md', 'test-all.mjs'];
const absPathLines = (absPathRaw || '')
  .split('\n')
  .filter(Boolean)
  .filter(line => !ABS_PATH_EXCLUDE.some(x => line.includes(x)));
if (absPathScanFailed) {
  fail(`Absolute path check could not run: git grep failed${formatRunFailure()}`);
} else if (absPathLines.length === 0) {
  pass('No absolute paths in code files');
} else {
  for (const line of absPathLines) {
    fail(`Absolute path: ${line.slice(0, 100)}`);
  }
}

// ── 7b. PDF RENDER WAIT CONDITION ───────────────────────────────

console.log('\n7b. PDF render wait condition');

const generatePdfScript = readFile('generate-pdf.mjs');
if (/waitUntil:\s*['"]load['"]/.test(generatePdfScript)) {
  pass('generate-pdf waits for load before rendering');
} else {
  fail('generate-pdf does not wait for load before rendering');
}
if (!/waitUntil:\s*['"]networkidle['"]/.test(generatePdfScript)) {
  pass('generate-pdf does not wait for networkidle');
} else {
  fail('generate-pdf still waits for networkidle');
}

function extractRenderHtmlToPdfOptions(source) {
  const call = /renderHtmlToPdf\s*\(\s*html\s*,\s*outputPath\s*,/g.exec(source);
  if (!call) return '';
  const objectStart = source.indexOf('{', call.index + call[0].length);
  if (objectStart === -1) return '';

  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = objectStart; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(objectStart + 1, i);
    }
  }
  return '';
}

const renderHtmlToPdfOptions = extractRenderHtmlToPdfOptions(generatePdfScript);
if (renderHtmlToPdfOptions && /\breportNum\b/.test(renderHtmlToPdfOptions) && /\binputPath\b/.test(renderHtmlToPdfOptions)) {
  pass('generate-pdf threads reportNum/inputPath into renderHtmlToPdf');
} else {
  fail('generate-pdf does not pass reportNum/inputPath into renderHtmlToPdf');
}
const nestedRenderOptions = extractRenderHtmlToPdfOptions('return renderHtmlToPdf(html, outputPath, { format, metadata: { reportNum, inputPath } });');
if (/\breportNum\b/.test(nestedRenderOptions) && /\binputPath\b/.test(nestedRenderOptions)) {
  pass('generate-pdf renderHtmlToPdf option matcher handles nested object literals');
} else {
  fail('generate-pdf renderHtmlToPdf option matcher fails on nested object literals');
}
if (generatePdfScript.includes('opts.reportNum') && generatePdfScript.includes('opts.inputPath')) {
  pass('renderHtmlToPdf reads manifest metadata from opts');
} else {
  fail('renderHtmlToPdf does not read manifest metadata from opts');
}

if (generatePdfScript.includes('--allow-reorder')) {
  pass('generate-pdf documents --allow-reorder in its usage strings');
} else {
  fail('generate-pdf is missing --allow-reorder from its usage strings');
}

try {
  const { validateCvSectionOrder } = await import(pathToFileURL(join(ROOT, 'generate-pdf.mjs')).href);
  const cvMarkdown = '# Education\ntext\n# Work Experience\ntext\n# Projects\ntext';
  // Education first, then Projects, then Experience last: diverges from cv.md
  // (which puts Education before Experience before Projects) AND from the
  // canonical modes/pdf.md tailoring order (#3640, which puts Experience
  // before Projects before Education) — genuinely scrambled rather than the
  // one documented reorder pdf.md always produces, which #3640 makes this
  // guard stop rejecting. `<div class="section-title">Projects</div><div
  // class="section-title">Education</div>` used to stand in for "reordered",
  // but Projects-before-Education IS that documented reorder, so it no
  // longer exercises the "genuinely scrambled" path this test is named for.
  const reorderedHtml = '<div class="section-title">Education</div>'
    + '<div class="section-title">Projects</div>'
    + '<div class="section-title">Experience</div>';

  let threw = false;
  try {
    validateCvSectionOrder(reorderedHtml, cvMarkdown);
  } catch {
    threw = true;
  }
  if (threw) {
    pass('validateCvSectionOrder throws on a genuinely scrambled CV by default (--allow-reorder unset)');
  } else {
    fail('validateCvSectionOrder should throw by default when section order diverges from cv.md AND the canonical modes/pdf.md order');
  }

  const originalWarn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  let threwWithFlag = false;
  try {
    validateCvSectionOrder(reorderedHtml, cvMarkdown, { allowReorder: true });
  } catch {
    threwWithFlag = true;
  } finally {
    console.warn = originalWarn;
  }
  if (!threwWithFlag && warned) {
    pass('validateCvSectionOrder({ allowReorder: true }) warns instead of throwing on a reordered CV');
  } else {
    fail('validateCvSectionOrder({ allowReorder: true }) should warn, not throw, and should not silently do neither');
  }
} catch (e) {
  fail(`validateCvSectionOrder allowReorder tests crashed: ${e.message}`);
}
try {
  const { repoRelativeManifestPath, injectPrintPageCss } = await import(pathToFileURL(join(ROOT, 'generate-pdf.mjs')).href);
  // Relative to the workspace, which is the data root: the checkout only when
  // nothing points the root elsewhere, and the suite does (#5113). A path under
  // output/, which is where a tailored CV's source HTML lives.
  const manifestRoot = getCareerOpsRoot();
  const insideHtmlPath = join(manifestRoot, 'output', 'cv-template.html');
  const outsideHtmlPath = join(dirname(manifestRoot), 'outside-cv-template.html');

  if (repoRelativeManifestPath(insideHtmlPath) === 'output/cv-template.html') {
    pass('PDF manifest records repo-local source HTML paths');
  } else {
    fail('PDF manifest does not normalize repo-local source HTML paths');
  }

  if (repoRelativeManifestPath('') === '' && repoRelativeManifestPath(outsideHtmlPath) === '') {
    pass('PDF manifest leaves HTML column blank when source HTML is missing or outside the repo');
  } else {
    fail('PDF manifest mishandles missing or external source HTML paths');
  }

  const injectedPageCss = injectPrintPageCss('<html><head><title>CV</title></head><body></body></html>', 'letter');
  if (
    injectedPageCss.includes('@page { size: Letter; margin: var(--page-margin, 0.6in); }') &&
    injectedPageCss.indexOf('career-ops-page-setup') < injectedPageCss.indexOf('</head>')
  ) {
    pass('PDF renderer injects CSS page size and margins before rendering');
  } else {
    fail('PDF renderer does not inject CSS page size/margins into the document head');
  }

  const mixedCasePageCss = injectPrintPageCss('<html><head></head><body></body></html>', 'Letter');
  if (mixedCasePageCss.includes('@page { size: Letter; margin: var(--page-margin, 0.6in); }')) {
    pass('PDF renderer treats page format case-insensitively');
  } else {
    fail('PDF renderer falls back to A4 for mixed-case letter format');
  }

  const doctypeNoHead = injectPrintPageCss('<!doctype html><html lang="en"><body></body></html>');
  if (
    doctypeNoHead.startsWith('<!doctype html>') &&
    doctypeNoHead.includes('<html lang="en">\n<head>\n<style id="career-ops-page-setup">') &&
    doctypeNoHead.indexOf('<head>') < doctypeNoHead.indexOf('<body>')
  ) {
    pass('PDF renderer preserves doctype when injecting page CSS into full HTML without head');
  } else {
    fail('PDF renderer may insert page CSS before doctype for full HTML without head');
  }

  const fragmentPageCss = injectPrintPageCss('<section>CV</section>');
  if (fragmentPageCss.startsWith('<style id="career-ops-page-setup">')) {
    pass('PDF renderer still prepends page CSS for HTML fragments');
  } else {
    fail('PDF renderer no longer handles HTML fragments with fallback CSS injection');
  }

  if (
    generatePdfScript.includes('preferCSSPageSize: true') &&
    generatePdfScript.includes("right: '0'") &&
    generatePdfScript.includes('injectPrintPageCss(html, format, opts.country)') &&
    !/page\.pdf\(\{\s*format:/s.test(generatePdfScript)
  ) {
    pass('PDF renderer uses CSS @page margins instead of Playwright margins');
  } else {
    fail('PDF renderer may clip right-aligned content by ignoring CSS page sizing (#1341)');
  }
} catch (e) {
  fail(`PDF manifest path helper test crashed: ${e.message}`);
}

console.log('\n7b2. PDF renderer temporary-file cleanup');

try {
  const { renderHtmlToPdf } = await import(pathToFileURL(join(ROOT, 'generate-pdf.mjs')).href);
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'career-ops-pdf-cleanup-launch-'));
  const launchError = new Error('injected browser launch failure');
  let caught;
  try {
    await renderHtmlToPdf('<html><body>PII_MARKER@example.com</body></html>', join(fixtureRoot, 'cv.pdf'), {
      baseDir: fixtureRoot,
      workspaceRoot: fixtureRoot,
      launchBrowser: async () => { throw launchError; },
    });
  } catch (error) {
    caught = error;
  }
  const leftovers = readdirSync(fixtureRoot)
    .filter((name) => name.startsWith('.career-ops-render-'));
  if (caught === launchError && leftovers.length === 0) {
    pass('PDF renderer removes temporary HTML when Chromium launch fails');
  } else {
    fail(`PDF renderer leaked temporary HTML after launch failure: ${leftovers.join(', ')}`);
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
} catch (error) {
  fail(`PDF renderer launch-cleanup test crashed: ${error.message}`);
}

try {
  const { renderHtmlToPdf } = await import(pathToFileURL(join(ROOT, 'generate-pdf.mjs')).href);
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'career-ops-pdf-cleanup-page-'));
  const pageError = new Error('injected newPage failure');
  let closeCalls = 0;
  let caught;
  try {
    await renderHtmlToPdf('<html><body>PRIVATE_CV_MARKER</body></html>', join(fixtureRoot, 'cv.pdf'), {
      baseDir: fixtureRoot,
      workspaceRoot: fixtureRoot,
      launchBrowser: async () => ({
        newPage: async () => { throw pageError; },
        close: async () => { closeCalls += 1; },
      }),
    });
  } catch (error) {
    caught = error;
  }
  const leftovers = readdirSync(fixtureRoot)
    .filter((name) => name.startsWith('.career-ops-render-'));
  if (caught === pageError && closeCalls === 1 && leftovers.length === 0) {
    pass('PDF renderer closes Chromium and removes temporary HTML after launch');
  } else {
    fail(`PDF renderer post-launch cleanup mismatch: close=${closeCalls}, temp=${leftovers.join(', ')}`);
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
} catch (error) {
  fail(`PDF renderer post-launch cleanup test crashed: ${error.message}`);
}

// ── 7e. CV SECTION ORDER CHECK IS LANGUAGE-AWARE ────────────────

// SECTION_ALIASES held English titles only, so a CV rendered in one of the
// shipped non-English modes produced zero sections comparable against the
// English cv.md: validateCvSectionOrder() saw fewer than two comparable
// sections and early-returned, and the guard silently did nothing. Polish
// (modes/pl) is covered here — a Polish CV that hoisted Education above
// Doświadczenie zawodowe used to render without complaint while the identical
// English CV was correctly rejected.

console.log('\n7e. CV section order check is language-aware');

for (const header of ['podsumowanie zawodowe', 'doświadczenie zawodowe', 'wykształcenie', 'certyfikaty', 'umiejętności']) {
  if (generatePdfScript.includes(`['${header}',`)) {
    pass(`SECTION_ALIASES maps Polish header: ${header}`);
  } else {
    fail(`SECTION_ALIASES missing Polish header: ${header}`);
  }
}

// Same gap, same two shipped Chinese markets (#3658): modes/zh-TW and modes/zh
// rendered titles the alias table could not name, so the guard was disabled AND
// cv.sections — the documented way to correct an order — silently did nothing.
// Both scripts are required: a CV written in either renders through this table.
for (const header of ['專業摘要', '工作經歷', '學歷', '證照', '技能', '专业摘要', '工作经历', '学历', '证书', '项目']) {
  if (generatePdfScript.includes(`['${header}',`)) {
    pass(`SECTION_ALIASES maps Chinese header: ${header}`);
  } else {
    fail(`SECTION_ALIASES missing Chinese header: ${header}`);
  }
}

// generate-pdf.mjs imports playwright at module scope; degrade to a warning
// rather than crashing the suite where it is not installed.
let pdfModule = null;
try {
  pdfModule = await import(pathToFileURL(join(ROOT, 'generate-pdf.mjs')).href);
} catch (e) {
  warn(`Cannot import generate-pdf.mjs (${e.code || e.message}) — skipping behavioral section-order tests`);
}

if (pdfModule) {
  const { sectionKey, validateCvSectionOrder } = pdfModule;

  // Canonical keys are language-independent; only the spelling differs.
  const keyCases = [
    ['Podsumowanie zawodowe', 'summary'],
    ['Kompetencje kluczowe', 'competencies'],
    ['Kluczowe kompetencje', 'competencies'], // word-order variant
    ['Doświadczenie zawodowe', 'experience'],
    ['Przebieg kariery', 'experience'],
    ['Wykształcenie', 'education'],
    ['Certyfikaty', 'certifications'],
    ['Umiejętności', 'skills'],
    ['Wyksztalcenie', 'education'],  // diacritics stripped
    ['Umiejetnosci', 'skills'],      // diacritics stripped
    ['Work Experience', 'experience'], // English must be unchanged
    ['Core Competencies', 'competencies'],
    ['專業摘要', 'summary'],       // Traditional (modes/zh-TW)
    ['工作經歷', 'experience'],
    ['學歷', 'education'],
    ['专业摘要', 'summary'],       // Simplified (modes/zh)
    ['工作经历', 'experience'],
    ['学历', 'education'],
  ];
  let keysOk = true;
  for (const [title, expected] of keyCases) {
    const actual = sectionKey(title);
    if (actual !== expected) {
      fail(`sectionKey("${title}") = "${actual}", expected "${expected}"`);
      keysOk = false;
    }
  }
  if (keysOk) pass(`sectionKey resolves all ${keyCases.length} PL/EN/ZH heading spellings`);

  // Hermetic cv.md stand-in: passed in directly, so the test does not depend on
  // a cv.md existing in the checkout (it is gitignored).
  const cvMd = [
    '# CV', '## Professional Summary', '## Work Experience',
    '## Education', '## Certifications', '## Skills',
  ].join('\n');
  const titlesToHtml = titles => titles.map(t => `<div class="section-title">${t}</div>`).join('\n');

  const plCorrect = titlesToHtml([
    'Podsumowanie zawodowe', 'Kompetencje kluczowe', 'Doświadczenie zawodowe',
    'Wykształcenie', 'Certyfikaty', 'Umiejętności',
  ]);
  // Education hoisted above Work Experience — the divergence the guard exists to catch.
  const plMisordered = titlesToHtml([
    'Podsumowanie zawodowe', 'Wykształcenie', 'Doświadczenie zawodowe',
  ]);
  const enMisordered = titlesToHtml([
    'Professional Summary', 'Education', 'Work Experience',
  ]);
  // Education hoisted above 工作經歷 — the Chinese half of #3658.
  const zhMisordered = titlesToHtml([
    '專業摘要', '學歷', '工作經歷',
  ]);
  const zhCorrect = titlesToHtml([
    '专业摘要', '工作经历', '学历', '证书', '技能',
  ]);

  const throws = (html, opts) => {
    try { validateCvSectionOrder(html, cvMd, opts); return false; } catch { return true; }
  };

  if (throws(plMisordered)) {
    pass('Polish CV with Education before Work Experience is rejected');
  } else {
    fail('Polish CV with Education before Work Experience was NOT rejected (guard is a no-op)');
  }

  if (!throws(plCorrect)) {
    pass('Polish CV in cv.md order is accepted');
  } else {
    fail('Polish CV in cv.md order was wrongly rejected');
  }

  if (throws(enMisordered)) {
    pass('English CV order check still rejects divergence (no regression)');
  } else {
    fail('English CV order check regressed');
  }

  if (throws(zhMisordered)) {
    pass('Traditional Chinese CV with Education before Work Experience is rejected');
  } else {
    fail('Traditional Chinese CV with Education before Work Experience was NOT rejected (guard is a no-op)');
  }

  if (!throws(zhCorrect)) {
    pass('Simplified Chinese CV in cv.md order is accepted');
  } else {
    fail('Simplified Chinese CV in cv.md order was wrongly rejected');
  }

  // --allow-reorder must keep downgrading the divergence to a warning now that
  // Polish CVs actually reach this code path.
  if (!throws(plMisordered, { allowReorder: true })) {
    pass('allowReorder downgrades Polish divergence to a warning');
  } else {
    fail('allowReorder did not suppress Polish divergence');
  }
}

// ── 11. AGENTS.md INTEGRITY ─────────────────────────────────────

console.log('\n11. AGENTS.md integrity');

const agents = readFile('AGENTS.md');
const requiredSections = [
  'Data Contract', 'Ethical Use',
  'Offer Verification', 'Canonical States', 'TSV Format',
  'First Run', 'Onboarding',
];

for (const section of requiredSections) {
  if (agents.includes(section)) {
    pass(`AGENTS.md has section: ${section}`);
  } else {
    fail(`AGENTS.md missing section: ${section}`);
  }
}

// ── 12. SKILL SYMLINK INTEGRITY ─────────────────────────────

console.log('\n12. Skill symlink integrity');

const canonicalSkill = '.agents/skills/career-ops/SKILL.md';
const symlinks = [
  '.claude/skills/career-ops/SKILL.md',
  '.opencode/skills/career-ops/SKILL.md',
  '.qwen/skills/career-ops/SKILL.md',
  '.antigravitycli/skills/career-ops/SKILL.md',
  '.grok/skills/career-ops/SKILL.md',
];

let canonicalReal = null;
let canonicalContent = null;
try {
  canonicalReal = realpathSync(join(ROOT, canonicalSkill));
  canonicalContent = readFile(canonicalSkill);
  pass(`Canonical skill resolves: ${canonicalSkill}`);
} catch {
  fail(`Canonical skill not found: ${canonicalSkill}`);
}

for (const link of symlinks) {
  let resolved = null;
  try {
    resolved = realpathSync(join(ROOT, link));
    if (resolved !== canonicalReal) {
      const content = readFileSync(resolved, 'utf-8').trim();
      if (content.startsWith('..') && content.split('\n').length === 1) {
        resolved = realpathSync(join(dirname(join(ROOT, link)), content));
      }
    }
  } catch {
    resolved = null;
  }
  if (resolved === null) {
    fail(`Symlink missing: ${link}`);
    continue;
  }
  if (resolved === canonicalReal) {
    pass(`${link} → canonical skill`);
  } else if (canonicalContent !== null && readFile(link) === canonicalContent) {
    pass(`${link} is a materialized copy of canonical skill`);
  } else {
    fail(`${link} resolves to ${resolved}, expected ${canonicalReal} or byte-identical canonical skill copy`);
  }
}

if (
  /Codex/i.test(canonicalContent ?? '') &&
  /`codex`/.test(canonicalContent ?? '') &&
  /`codex exec/.test(canonicalContent ?? '') &&
  /prompt/i.test(canonicalContent ?? '') &&
  /\/career-ops/.test(canonicalContent ?? '')
) {
  pass('career-ops skill router documents the Codex invocation model');
} else {
  fail('career-ops skill router is missing Codex invocation guidance');
}

// ── 12. ARCHIVE-POSTING ─────────────────────────────────────────

console.log('\n12. archive-posting.mjs');

// dry-run: URL-based company detection across each supported ATS
for (const [url, expected] of [
  ['https://boards.greenhouse.io/openai/jobs/123', 'openai'],
  ['https://jobs.ashbyhq.com/ElevenLabs/abc',      'elevenlabs'],
  ['https://jobs.lever.co/retool/xyz',              'retool'],
  ['https://jobs.eu.lever.co/retool-eu/xyz',         'retool-eu'],
]) {
  const out = run(NODE, ['archive-posting.mjs', '--dry-run', url]);
  const { hostname } = new URL(url);
  out?.toLowerCase().includes(expected)
    ? pass(`dry-run: company detected from ${hostname}`)
    : fail(`dry-run: company not detected from ${hostname}`);
}

// dry-run: --company / --role overrides win over URL detection
const overrideOut = run(NODE, [
  'archive-posting.mjs', '--dry-run',
  'https://jobs.lever.co/retool/xyz', '--company=Acme', '--role=Staff Engineer',
]);
overrideOut?.includes('Acme') && overrideOut?.includes('staff-engineer')
  ? pass('dry-run: --company and --role overrides respected')
  : fail('dry-run: --company / --role overrides not reflected in output');

// dry-run: output always contains a local:jds/ reference and today's date.
// The date the child prints is its own clock read, so it is compared against
// the day(s) spanning the call rather than one captured up-section — see
// runAcrossLocalDay() for why a single capture fails a run that crosses
// midnight (#3816).
//
// LOCAL day, not UTC: archive-posting names its capture with localToday(), so
// asserting the UTC day here passed only where the two agree — which is most of
// the day in most zones, and never in the evening west of Greenwich.
const { out: refOut, days: refDays } = runAcrossLocalDay(NODE, ['archive-posting.mjs', '--dry-run', 'https://boards.greenhouse.io/openai/jobs/123']);
refOut?.includes('local:jds/') && refDays.some((day) => refOut?.includes(day))
  ? pass('dry-run: local:jds/ reference and date emitted')
  : fail('dry-run: reference or date missing from output');

// argument validation: no args → shows help, exits 0
run(NODE, ['archive-posting.mjs']) !== null
  ? pass('no-args: exits 0 (shows help)')
  : fail('no-args: should exit 0 and print help');

// argument validation: a trailing --report must not be dropped. It used to fall
// through the parser and archive the posting with no report prefix — silently
// unfindable, the exact failure --report exists to prevent.
run(NODE, ['archive-posting.mjs', '--dry-run', 'https://boards.greenhouse.io/openai/jobs/123', '--report']) === null
  ? pass('trailing --report: exits non-zero instead of archiving unkeyed')
  : fail('trailing --report: should exit non-zero, not archive without a report prefix');

// argument validation: both --report forms still key the capture
for (const argv of [['--report', '4'], ['--report=4']]) {
  const keyed = run(NODE, ['archive-posting.mjs', '--dry-run', 'https://boards.greenhouse.io/openai/jobs/123', ...argv]);
  keyed?.includes('jds/004-')
    ? pass(`${argv.join(' ')}: capture is keyed to the report`)
    : fail(`${argv.join(' ')}: capture missing the 004- report prefix`);
}

// argument validation: flag without URL → exits non-zero
run(NODE, ['archive-posting.mjs', '--dry-run']) === null
  ? pass('flag-without-url: exits non-zero (URL required)')
  : fail('flag-without-url: should exit non-zero when URL is missing');

// argument validation: --company without URL → exits non-zero
run(NODE, ['archive-posting.mjs', '--company=Acme']) === null
  ? pass('--company without URL: exits non-zero')
  : fail('--company without URL: should exit non-zero');

// --report: keys the capture to a report number so it resolves on a later day (#134)
const reportEqOut = run(NODE, ['archive-posting.mjs', '--dry-run', '--report=42', 'https://boards.greenhouse.io/openai/jobs/123']);
reportEqOut?.includes('jds/042-')
  ? pass('--report=N: filename carries the zero-padded report number')
  : fail('--report=N: report prefix missing from filename');

// The space-separated form must consume its value; otherwise the bare-argument
// branch takes it as the URL and the real URL is silently dropped.
const reportSpaceOut = run(NODE, ['archive-posting.mjs', '--dry-run', '--report', '42', 'https://boards.greenhouse.io/openai/jobs/123']);
reportSpaceOut?.includes('jds/042-') && reportSpaceOut?.toLowerCase().includes('openai')
  ? pass('--report N: value consumed, URL still parsed')
  : fail('--report N: swallowed the URL or dropped the report number');

// omitting --report leaves the historical filename shape untouched — the date
// in it is the LOCAL calendar day (localToday()), the day the user was working.
const { out: noReportOut, days: noReportDays } = runAcrossLocalDay(NODE, ['archive-posting.mjs', '--dry-run', 'https://boards.greenhouse.io/openai/jobs/123']);
noReportDays.some((day) => noReportOut?.includes(`jds/${day}_`))
  ? pass('no --report: filename shape unchanged')
  : fail('no --report: filename shape regressed');

run(NODE, ['archive-posting.mjs', '--dry-run', '--report=abc', 'https://boards.greenhouse.io/openai/jobs/123']) === null
  ? pass('--report with non-numeric value: exits non-zero')
  : fail('--report with non-numeric value: should be rejected, not ignored');

run(NODE, ['archive-posting.mjs', '--pipeline', '--report=42']) === null
  ? pass('--report with --pipeline: rejected (report keys one posting)')
  : fail('--report with --pipeline: should exit non-zero');

// live render: gated behind Playwright executable availability
let hasBrowser = false;
try {
  const { chromium } = await import('playwright');
  hasBrowser = existsSync(chromium.executablePath());
} catch { /* playwright not installed */ }

if (!hasBrowser) {
  warn('archive render skipped — no Playwright browser in env');
} else {
  let liveJobUrl = null;
  try {
    const res = await fetch('https://boards-api.greenhouse.io/v1/boards/anthropic/jobs?content=false');
    const { jobs } = await res.json();
    const candidate = jobs?.[0]?.absolute_url ?? null;
    if (candidate) {
      const u = new URL(candidate);
      const allowed = new Set(['boards.greenhouse.io', 'job-boards.greenhouse.io']);
      if (u.protocol === 'https:' && allowed.has(u.hostname)) liveJobUrl = candidate;
    }
  } catch { /* offline — degrade gracefully */ }

  if (!liveJobUrl) {
    warn('archive render skipped — Greenhouse API unreachable');
  } else {
    // jds/ under the data root, where archive-posting.mjs writes: the
    // suite's scratch root, so the capture this makes and removes never sits
    // among the developer's own (#5113).
    const JDS_DIR = join(getCareerOpsRoot(), 'jds');
    const startedAt = Date.now();
    const archiveOut = run('node', ['archive-posting.mjs', liveJobUrl], { timeout: 60000 });

    if (archiveOut === null) {
      fail('live archive: script exited non-zero on live URL');
    } else {
      pass('live archive: exited 0');

      const recent = existsSync(JDS_DIR)
        ? readdirSync(JDS_DIR)
            .filter(f => f.endsWith('.pdf'))
            .filter(f => statSync(join(JDS_DIR, f)).mtimeMs >= startedAt)
        : [];

      if (recent.length === 0) {
        fail('live archive: no PDF written to jds/ during test run');
      } else {
        const pdf = join(JDS_DIR, recent[0]);
        const { size } = statSync(pdf);
        size > 50 * 1024
          ? pass(`live archive: PDF has real content (${(size / 1024).toFixed(0)} KB)`)
          : fail(`live archive: PDF suspiciously small — likely empty page (${size} bytes)`);
        unlinkSync(pdf);
      }
    }
  }
}

// ── 14b. ADD-ENTRY (/career-ops add) ────────────────────────────────

console.log('\n14b. add-entry.mjs (dedup + insertion)');

try {
  const addMod = await import(pathToFileURL(join(ROOT, 'add-entry.mjs')).href);
  const { normalizeKey, locateSection, cvHasEntry, insertIntoCvSection, articleDigestHasEntry, applyAdd } = addMod;

  if (normalizeKey('Fraud-Shield!') === 'fraudshield') pass('normalizeKey strips punctuation/case');
  else fail(`normalizeKey => ${normalizeKey('Fraud-Shield!')}`);

  const sampleCv = [
    '# CV -- Test',
    '',
    '## Work Experience',
    '',
    '### Acme -- Remote',
    '',
    '**Engineer**',
    '2020-2022',
    '',
    '- Did things',
    '',
    '## Projects',
    '',
    '- **Existing** (OSS) -- already here',
    '',
    '## Education',
    '',
    '- BS CS',
    '',
  ].join('\n');

  // locateSection isolates the right block
  const loc = locateSection(sampleCv, 'Projects');
  if (loc && loc.body.includes('Existing') && !loc.body.includes('BS CS')) pass('locateSection isolates the Projects block');
  else fail(`locateSection => ${JSON.stringify(loc && loc.body)}`);

  // insertion appends within section and preserves later sections
  const inserted = insertIntoCvSection(sampleCv, 'Projects', '- **FraudShield** (OSS) -- fraud detection');
  if (inserted.includes('- **Existing**') && inserted.includes('- **FraudShield**') &&
      inserted.indexOf('FraudShield') < inserted.indexOf('## Education') &&
      inserted.includes('## Education')) {
    pass('insertIntoCvSection appends under Projects and keeps Education intact');
  } else {
    fail('insertIntoCvSection placement wrong');
  }

  // missing section is created at EOF
  const withPubs = insertIntoCvSection(sampleCv, 'Publications', '- **A Paper** (2026) -- venue');
  if (withPubs.includes('## Publications') && withPubs.includes('- **A Paper**')) pass('insertIntoCvSection creates a missing section');
  else fail('insertIntoCvSection did not create missing section');

  // dedup detection is punctuation/case-insensitive
  if (cvHasEntry(sampleCv, 'Projects', 'existing') && !cvHasEntry(sampleCv, 'Projects', 'FraudShield')) {
    pass('cvHasEntry detects an existing entry and misses a new one');
  } else {
    fail('cvHasEntry dedup logic wrong');
  }

  // applyAdd: fresh add to cv + article-digest (article-digest absent → created)
  const added = applyAdd(
    {
      cv: { section: 'Projects', dedupKey: 'FraudShield', entry: '- **FraudShield** (OSS) -- fraud detection' },
      articleDigest: { dedupKey: 'FraudShield', entry: '## FraudShield -- Detection\n\n**Hero metrics:** 99.7%' },
    },
    { cvText: sampleCv, articleText: null },
  );
  if (added.result.cv.status === 'added' && added.result.articleDigest.status === 'created' &&
      added.cv.includes('FraudShield') && added.articleDigest.includes('## FraudShield')) {
    pass('applyAdd adds a new CV entry and creates article-digest.md when absent');
  } else {
    fail(`applyAdd fresh-add => ${JSON.stringify(added.result)}`);
  }

  // applyAdd: idempotent — same payload against updated files is a no-op
  const again = applyAdd(
    {
      cv: { section: 'Projects', dedupKey: 'FraudShield', entry: '- **FraudShield** (OSS) -- fraud detection' },
      articleDigest: { dedupKey: 'FraudShield', entry: '## FraudShield -- Detection\n\n**Hero metrics:** 99.7%' },
    },
    { cvText: added.cv, articleText: added.articleDigest },
  );
  if (again.result.cv.status === 'duplicate' && again.result.articleDigest.status === 'duplicate') {
    pass('applyAdd is idempotent (duplicate/duplicate on re-run)');
  } else {
    fail(`applyAdd re-run => ${JSON.stringify(again.result)}`);
  }

  if (articleDigestHasEntry(added.articleDigest, 'fraud shield')) pass('articleDigestHasEntry matches normalized heading');
  else fail('articleDigestHasEntry failed to match');

  // guardrails: cv add against a missing cv.md throws; empty payload throws
  let threwNoCv = false;
  try { applyAdd({ cv: { section: 'Projects', dedupKey: 'X', entry: '- x' } }, { cvText: null }); } catch { threwNoCv = true; }
  if (threwNoCv) pass('applyAdd refuses to add to a missing cv.md');
  else fail('applyAdd should throw when cv.md is absent');

  let threwEmpty = false;
  try { applyAdd({}, { cvText: sampleCv }); } catch { threwEmpty = true; }
  if (threwEmpty) pass('applyAdd rejects an empty payload');
  else fail('applyAdd should reject an empty payload');

  // dedupKey is required — idempotency depends on it, so a missing one fails fast.
  let threwNoKey = false;
  try { applyAdd({ cv: { section: 'Projects', entry: '- **X** -- y' } }, { cvText: sampleCv }); } catch { threwNoKey = true; }
  if (threwNoKey) pass('applyAdd requires a dedupKey for a cv target');
  else fail('applyAdd should throw when cv.dedupKey is missing');

  // Short-key dedup must NOT collide with unrelated substrings (e.g. "ai" in a
  // bullet that mentions "email"). Regression for the identifier-based matcher.
  const cvWithEmail = '# CV\n\n## Projects\n\n- **Mailer** (OSS) -- sends email digests\n';
  if (!cvHasEntry(cvWithEmail, 'Projects', 'AI')) pass('cvHasEntry does not false-match a short key against unrelated text');
  else fail('cvHasEntry should not match "AI" against "email"');
  if (cvHasEntry(cvWithEmail, 'Projects', 'Mailer')) pass('cvHasEntry still matches the real bold identifier');
  else fail('cvHasEntry should match the bold entry name');

  // Same collision guard for article-digest headings (name before the dash).
  const adWithMailer = '# Article Digest\n\n---\n\n## Mailer -- Email digests\n\n**Hero metrics:** x\n';
  if (!articleDigestHasEntry(adWithMailer, 'AI')) pass('articleDigestHasEntry does not false-match a short key against a heading');
  else fail('articleDigestHasEntry should not match "AI" against the "Mailer -- Email digests" heading');
  if (articleDigestHasEntry(adWithMailer, 'Mailer')) pass('articleDigestHasEntry matches the real heading name');
  else fail('articleDigestHasEntry should match the heading name before the dash');

  // CLI wiring: --dry-run reports without writing; a real run writes and is then
  // idempotent. Exercised against isolated fixture files via env overrides.
  const cliTmp = mkdtempSync(join(tmpdir(), 'career-ops-add-cli-'));
  try {
    const cvPath = join(cliTmp, 'cv.md');
    const adPath = join(cliTmp, 'article-digest.md');
    writeFileSync(cvPath, '# CV\n\n## Projects\n\n- **Existing** (OSS) -- here\n');
    const payloadPath = join(cliTmp, 'payload-with-dash.json');
    const cliPayload = {
      cv: { section: 'Projects', dedupKey: 'CliProj', entry: '- **CliProj** (OSS) -- desc' },
      articleDigest: { dedupKey: 'CliProj', entry: '## CliProj -- Tagline\n\n**Hero metrics:** x' },
    };
    writeFileSync(payloadPath, JSON.stringify(cliPayload));
    const env = { ...process.env, CAREER_OPS_CV: cvPath, CAREER_OPS_ARTICLE_DIGEST: adPath };

    const helpOut = spawnSync(NODE, [join(ROOT, 'add-entry.mjs'), '--help'], { env, encoding: 'utf-8' });
    const hOut = spawnSync(NODE, [join(ROOT, 'add-entry.mjs'), '-h'], { env, encoding: 'utf-8' });
    if (helpOut.status === 0 && hOut.status === 0 &&
        helpOut.stdout.includes('Usage:') && helpOut.stdout.includes('--stdin') &&
        hOut.stdout === helpOut.stdout) {
      pass('add-entry CLI --help/-h print usage and exit 0');
    } else {
      fail(`add-entry CLI help handling => ${JSON.stringify({ help: { status: helpOut.status, stdout: helpOut.stdout, stderr: helpOut.stderr }, h: { status: hOut.status, stdout: hOut.stdout, stderr: hOut.stderr } })}`);
    }

    const missingPayloadPath = join(cliTmp, 'missing-payload.json');
    const badFlag = spawnSync(NODE, [join(ROOT, 'add-entry.mjs'), missingPayloadPath, '--sumary'], { env, encoding: 'utf-8' });
    if (badFlag.status === 1 && /unrecognized flag/.test(badFlag.stderr) && badFlag.stderr.includes('--sumary') &&
        !badFlag.stderr.includes('could not parse payload') &&
        !readFileSync(cvPath, 'utf-8').includes('CliProj') && !existsSync(adPath)) {
      pass('add-entry CLI rejects an unrecognized flag before reading or writing payload data');
    } else {
      fail(`add-entry CLI unknown flag handling => ${JSON.stringify({ status: badFlag.status, stdout: badFlag.stdout, stderr: badFlag.stderr })}`);
    }

    const stdinDryRun = spawnSync(NODE, [join(ROOT, 'add-entry.mjs'), '--stdin', '--dry-run'], {
      env,
      encoding: 'utf-8',
      input: JSON.stringify(cliPayload),
    });
    if (stdinDryRun.status === 0 && JSON.parse(stdinDryRun.stdout).dryRun === true &&
        !readFileSync(cvPath, 'utf-8').includes('CliProj') && !existsSync(adPath)) {
      pass('add-entry CLI keeps --stdin and --dry-run working together');
    } else {
      fail(`add-entry CLI --stdin --dry-run => ${JSON.stringify({ status: stdinDryRun.status, stdout: stdinDryRun.stdout, stderr: stdinDryRun.stderr })}`);
    }

    execFileSync(NODE, [join(ROOT, 'add-entry.mjs'), payloadPath, '--dry-run'], { env, encoding: 'utf-8' });
    if (!readFileSync(cvPath, 'utf-8').includes('CliProj') && !existsSync(adPath)) pass('add-entry CLI --dry-run writes nothing and accepts a payload path containing dashes');
    else fail('add-entry CLI --dry-run should not write');

    const realOut = JSON.parse(execFileSync(NODE, [join(ROOT, 'add-entry.mjs'), payloadPath], { env, encoding: 'utf-8' }));
    if (realOut.cv.status === 'added' && realOut.articleDigest.status === 'created' &&
        readFileSync(cvPath, 'utf-8').includes('- **CliProj**') && readFileSync(adPath, 'utf-8').includes('## CliProj')) {
      pass('add-entry CLI real run writes cv.md + creates article-digest.md');
    } else {
      fail(`add-entry CLI real run => ${JSON.stringify(realOut)}`);
    }

    const rerun = JSON.parse(execFileSync(NODE, [join(ROOT, 'add-entry.mjs'), payloadPath], { env, encoding: 'utf-8' }));
    if (rerun.cv.status === 'duplicate' && rerun.articleDigest.status === 'duplicate') pass('add-entry CLI re-run is idempotent');
    else fail(`add-entry CLI re-run => ${JSON.stringify(rerun)}`);
  } finally {
    rmSync(cliTmp, { recursive: true, force: true });
  }

  // Non-Latin CVs (#2849). normalizeKey stripped [^a-z0-9], so every heading and
  // dedupKey in a Japanese/Russian/Hindi CV keyed to '' — which made `add`
  // UNUSABLE, not inaccurate: the non-empty-dedupKey guard rejected a key the
  // user had supplied, and two different headings both keying to '' matched
  // each other, so an entry could land under the wrong section.
  {
    const jpTmp = mkdtempSync(join(tmpdir(), 'career-ops-add-jp-'));
    try {
      const cvPath = join(jpTmp, 'cv.md');
      writeFileSync(cvPath, '# CV\n\n## \u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\n\n- \u65E2\u5B58\n\n## \u8077\u52D9\u7D4C\u6B74\n\n- \u65E2\u5B58\n');
      const payloadPath = join(jpTmp, 'p.json');
      writeFileSync(payloadPath, JSON.stringify({ cv: {
        section: '\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8',
        dedupKey: '\u30D5\u30E9\u30A6\u30C9\u30B7\u30FC\u30EB\u30C9',
        entry: '- **\u30D5\u30E9\u30A6\u30C9\u30B7\u30FC\u30EB\u30C9**',
      } }));
      const env = { ...process.env, CAREER_OPS_CV: cvPath };
      const out = JSON.parse(execFileSync(NODE, [join(ROOT, 'add-entry.mjs'), payloadPath], { env, encoding: 'utf-8' }));
      out.cv.status === 'added'
        ? pass('add-entry: a non-Latin dedupKey is accepted and the entry is added (#2849)')
        : fail(`add-entry: non-Latin payload => ${JSON.stringify(out.cv)}`);

      const rerun = JSON.parse(execFileSync(NODE, [join(ROOT, 'add-entry.mjs'), payloadPath], { env, encoding: 'utf-8' }));
      rerun.cv.status === 'duplicate'
        ? pass('add-entry: a non-Latin entry is idempotent on re-run (#2849)')
        : fail(`add-entry: non-Latin re-run => ${JSON.stringify(rerun.cv)}`);

      // A different heading must not collide via a shared empty key.
      const p2 = join(jpTmp, 'p2.json');
      writeFileSync(p2, JSON.stringify({ cv: {
        section: '\u8077\u52D9\u7D4C\u6B74',
        dedupKey: '\u5225\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8',
        entry: '- **\u5225\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8**',
      } }));
      execFileSync(NODE, [join(ROOT, 'add-entry.mjs'), p2], { env, encoding: 'utf-8' });
      const finalCv = readFileSync(cvPath, 'utf-8');
      const [projSection, workSection] = finalCv.split('## \u8077\u52D9\u7D4C\u6B74');
      (workSection || '').includes('\u5225\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8') && !projSection.includes('\u5225\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8')
        ? pass('add-entry: two different non-Latin sections stay distinct (#2849)')
        : fail(`add-entry: entry landed under the wrong non-Latin section:\n${finalCv}`);
    } finally {
      rmSync(jpTmp, { recursive: true, force: true });
    }
  }

} catch (e) {
  fail(`add-entry tests crashed: ${e.message}`);
}

// ── RESERVE-REPORT-NUM RANGE RESERVATION (#1426) ────────────────
// Manual multi-agent fan-outs need N report numbers up front. --count N
// reserves a contiguous range (per-slot atomic sentinels); tests run against
// a temp dir via the CAREER_OPS_REPORTS_DIR override. CAREER_OPS_BATCH_STATE
// points every run at a fixture-local batch-state.tsv, so failed rows in the
// install's real batch/batch-state.tsv cannot occupy fixture numbers (#4391).
console.log('\n🧪 Testing reserve-report-num env override and range reservation...');
try {
  const RESERVE = join(ROOT, 'reserve-report-num.mjs');
  const reserveRun = (args, dir, tracker = join(dir, 'applications.md')) => execFileSync(NODE, [RESERVE, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, CAREER_OPS_REPORTS_DIR: dir, CAREER_OPS_TRACKER: tracker, CAREER_OPS_BATCH_STATE: join(dir, 'batch-state.tsv') },
  }).trim();

  // Importing the module must expose the same allocator used by the CLI,
  // without running the CLI as an import side effect.
  const apiTmp = mkdtempSync(join(tmpdir(), 'career-ops-reserve-api-'));
  const apiTracker = join(apiTmp, 'applications.md');
  const apiProbe = execFileSync(NODE, ['--input-type=module', '--eval', `
    const api = await import(${JSON.stringify(pathToFileURL(RESERVE).href)});
    const { existsSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const nums = await api.reserveReportNumbers(1, {
      reportsDir: process.env.CAREER_OPS_REPORTS_DIR,
      trackerPath: process.env.CAREER_OPS_TRACKER,
    });
    const sentinel = join(process.env.CAREER_OPS_REPORTS_DIR, '001-RESERVED.md');
    let firstToken = null;
    try { firstToken = JSON.parse(readFileSync(sentinel, 'utf-8')).token; } catch {}
    await api.releaseReportNumbers(nums, {
      reportsDir: process.env.CAREER_OPS_REPORTS_DIR,
      trackerPath: process.env.CAREER_OPS_TRACKER,
    });
    const replacement = await api.reserveReportNumbers(1, {
      reportsDir: process.env.CAREER_OPS_REPORTS_DIR,
      trackerPath: process.env.CAREER_OPS_TRACKER,
    });
    let replacementToken = null;
    try { replacementToken = JSON.parse(readFileSync(sentinel, 'utf-8')).token; } catch {}
    await api.releaseReportNumbers(nums, {
      reportsDir: process.env.CAREER_OPS_REPORTS_DIR,
      trackerPath: process.env.CAREER_OPS_TRACKER,
    });
    const replacementPreserved = existsSync(sentinel);
    await api.releaseReportNumbers(replacement, {
      reportsDir: process.env.CAREER_OPS_REPORTS_DIR,
      trackerPath: process.env.CAREER_OPS_TRACKER,
    });
    console.log(JSON.stringify({
      nums,
      formatted: api.formatReportNumber(nums[0]),
      firstToken,
      replacementToken,
      replacementPreserved,
      replacementCleaned: !existsSync(sentinel),
    }));
  `], {
    encoding: 'utf-8',
    env: { ...process.env, CAREER_OPS_REPORTS_DIR: apiTmp, CAREER_OPS_TRACKER: apiTracker, CAREER_OPS_BATCH_STATE: join(apiTmp, 'batch-state.tsv') },
  }).trim();
  let apiResult = null;
  try { apiResult = JSON.parse(apiProbe); } catch {}
  if (apiResult?.nums?.[0] === 1 && apiResult.formatted === '001'
      && apiResult.firstToken && apiResult.replacementToken
      && apiResult.firstToken !== apiResult.replacementToken
      && apiResult.replacementPreserved && apiResult.replacementCleaned) {
    pass('reserve-report-num token ownership prevents stale cleanup from deleting a replacement claim');
  } else {
    fail(`reserve-report-num import API failed: ${apiProbe}`);
  }
  rmSync(apiTmp, { recursive: true, force: true });

  const trackerParseApi = await import(pathToFileURL(join(ROOT, 'tracker-parse.mjs')).href);
  const complexLinkNums = trackerParseApi.extractTrackerReportNumbers(
    '[22](../reports/021-acme_(us)-2026-07-15.md "US role")',
  );
  const angleLinkNums = trackerParseApi.extractTrackerReportNumbers(
    '[23](<../reports/023-acme role-(eu)-2026-07-15.md> \'EU role\')',
  );
  if (complexLinkNums.join(',') === '22,21' && angleLinkNums.join(',') === '23') {
    pass('tracker report-link parsing supports balanced parentheses, spaces, and optional titles');
  } else {
    fail(`complex tracker report links parsed incorrectly: ${complexLinkNums} / ${angleLinkNums}`);
  }

  const reserveTmp = mkdtempSync(join(tmpdir(), 'career-ops-reserve-'));
  const single = reserveRun([], reserveTmp);
  if (single === '001' && existsSync(join(reserveTmp, '001-RESERVED.md'))) {
    pass('CAREER_OPS_REPORTS_DIR override redirects sentinel to temp dir');
  } else {
    fail(`env override failed: stdout=${single}, sentinel in tmp=${existsSync(join(reserveTmp, '001-RESERVED.md'))}`);
  }
  rmSync(reserveTmp, { recursive: true, force: true });

  // Tracker IDs and linked report IDs are occupied even when their report
  // files are missing (for example after a partial sync or manual archive).
  const trackerTmp = mkdtempSync(join(tmpdir(), 'career-ops-reserve-tracker-'));
  const trackerFile = join(trackerTmp, 'applications.md');
  writeFileSync(trackerFile,
    '# Applications Tracker\n\n' +
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
    '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
    '| 7 | 2026-01-01 | Acme | Engineer | 4.0/5 | Evaluated | ❌ | [12](../reports/012-acme-2026-01-01.md) | fixture |\n');
  const afterTracker = reserveRun([], join(trackerTmp, 'reports'), trackerFile);
  if (afterTracker === '013') {
    pass('reservation accounts for tracker row IDs and linked report IDs');
  } else {
    fail(`tracker-aware reservation produced ${afterTracker}, expected 013`);
  }
  rmSync(trackerTmp, { recursive: true, force: true });

  // Formatting is a minimum width, not a three-digit ceiling.
  const fourDigitTmp = mkdtempSync(join(tmpdir(), 'career-ops-reserve-4digit-'));
  const fourDigitTracker = join(fourDigitTmp, 'applications.md');
  writeFileSync(fourDigitTracker,
    '# Applications Tracker\n\n' +
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
    '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
    '| 1000 | 2026-01-01 | Acme | Engineer | 4.0/5 | Evaluated | ❌ | — | fixture |\n');
  const fourDigit = reserveRun([], join(fourDigitTmp, 'reports'), fourDigitTracker);
  if (fourDigit === '1001' && existsSync(join(fourDigitTmp, 'reports', '1001-RESERVED.md'))) {
    pass('reservation continues beyond 999 without truncation or reset');
  } else {
    fail(`four-digit reservation produced ${fourDigit}, expected 1001`);
  }
  rmSync(fourDigitTmp, { recursive: true, force: true });

  const unsafeRangeTmp = mkdtempSync(join(tmpdir(), 'career-ops-reserve-unsafe-range-'));
  const unsafeRangeReports = join(unsafeRangeTmp, 'reports');
  const unsafeRangeTracker = join(unsafeRangeTmp, 'applications.md');
  mkdirSync(unsafeRangeReports);
  writeFileSync(
    join(unsafeRangeReports, `${Number.MAX_SAFE_INTEGER - 1}-existing.md`),
    '# fixture',
  );
  const allocatorApi = await import(`${pathToFileURL(RESERVE).href}?unsafe-range=${Date.now()}`);
  let unsafeRangeError = null;
  try {
    await allocatorApi.reserveReportNumbers(2, {
      reportsDir: unsafeRangeReports,
      trackerPath: unsafeRangeTracker,
      batchStateFile: join(unsafeRangeTmp, 'batch-state.tsv'),
    });
  } catch (err) {
    unsafeRangeError = err;
  }
  const unsafeRangeLeaked = readdirSync(unsafeRangeReports)
    .some(name => name.endsWith('-RESERVED.md'));
  if (unsafeRangeError instanceof RangeError && !unsafeRangeLeaked) {
    pass('unsafe report-number ranges fail before creating a partial sentinel');
  } else {
    fail(`unsafe range guard failed: error=${unsafeRangeError?.message}, leaked=${unsafeRangeLeaked}`);
  }
  rmSync(unsafeRangeTmp, { recursive: true, force: true });

  const evaluatorSources = ['ollama-eval.mjs', 'openai-eval.mjs', 'gemini-eval.mjs', 'openrouter-runner.mjs']
    .map(name => [name, readFile(name)]);
  const unmigratedEvaluators = evaluatorSources
    .filter(([, source]) => !/reservedNumbers\s*=\s*await\s+reserveReportNumbers\s*\(/.test(source)
      || !/await\s+releaseReportNumbers\s*\(\s*reservedNumbers\b/.test(source)
      || /function\s+nextReport(?:Number|Num)\s*\(/.test(source))
    .map(([name]) => name);
  if (unmigratedEvaluators.length === 0) {
    pass('all headless evaluators use the shared atomic report allocator');
  } else {
    fail(`headless evaluators still carry private max+1 allocators: ${unmigratedEvaluators.join(', ')}`);
  }

  // Same family, second contract (#3707): every headless evaluator persists its
  // evaluation as a TSV in batch/tracker-additions, so merge-tracker.mjs applies
  // dedup, status validation, report-link normalization and the tracker lock
  // (AGENTS.md Pipeline Integrity rule 1). openai-eval/ollama-eval used to print
  // a markdown row for the user to paste into data/applications.md instead --
  // 8 cells against a 9-column tracker, which every reader's width guard drops
  // as a non-data line, so the pasted evaluation vanished and verify-pipeline
  // still reported the tracker clean.
  //
  // The sink is expressed as the #3706 contract rather than as per-file patterns:
  // a write call whose payload interpolates a header constant, a newline, then
  // the row. Patterns naming each file's own variables went stale the moment
  // #3706 rewrote gemini-eval and openrouter-runner to emit TSV_ADDITION_HEADER
  // -- they reported "bypasses the tracker-addition path" against a tree where
  // both persist correctly, a false alarm on files this PR does not own. Keying
  // on the shared contract means the check tracks the contract, not the spelling.
  // Presence of the string "tracker-additions" is deliberately NOT the test: a
  // comment satisfies that.
  const writeSinkRe = /write(?:File|FileSync)\([\s\S]{0,200}?\$\{[A-Za-z0-9_]*(?:HEADER|Header)\}\\n\$\{([^}]+)\}/;
  // ...and the payload has to BE the row. Accepting any identifier let a mutation
  // that replaced `${trackerFields.join('\t')}` with `${placeholder}` pass, which
  // is the failure-wearing-a-pass this check exists to stop. Either the join is
  // inline, or the named variable's own definition is tab-separated
  // (openrouter-runner builds `tsvLine` a line earlier).
  // Comments are stripped first: a commented-out writeFileSync block still
  // matches the raw source, so the harness would pass while the evaluator wrote
  // nothing -- the failure-wearing-a-pass this check exists to stop. Only
  // whole-line comments are removed, deliberately: a naive `//`-to-end-of-line
  // strip also eats the `//` inside every `https://` string literal, which is
  // its own way of misreading the file. Commented-out code is whole lines.
  const executable = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n');
  const writesTheRow = (rawSource) => {
    const source = executable(rawSource);
    const sink = source.match(writeSinkRe);
    if (!sink) return false;
    const payload = sink[1].trim();
    if (/\.join\('\\t'\)$/.test(payload)) return true;
    const defined = source.match(new RegExp(`const\\s+${payload.replace(/[^A-Za-z0-9_]/g, '')}\\s*=[^;]*`));
    return Boolean(defined && defined[0].includes('\\t'));
  };
  const pastedRowRe = /Tracker entry \(add to|console\.log\(`[^`]*\|\s*\$\{num\}\s*\|/;
  const unpersistedEvaluators = evaluatorSources
    .filter(([, source]) => !writesTheRow(source) || pastedRowRe.test(source))
    .map(([name]) => name);
  if (unpersistedEvaluators.length === 0) {
    pass('all headless evaluators write their addition to disk, none dictates a hand-pasted row');
  } else {
    fail(`headless evaluators bypass the tracker-addition path: ${unpersistedEvaluators.join(', ')}`);
  }

  // The addition itself must carry all nine columns in the TSV contract's order
  // (status BEFORE score) -- the two evaluators converted in #3707 build the row
  // from a literal, so pin the field list rather than only the directory.
  const nineFieldRe = new RegExp([
    'const trackerFields = \\[',
    "String\\(parseInt\\(num, 10\\)\\),",
    'today,',
    'tsvSafe\\(company\\),',
    'tsvSafe\\(role\\),',
    "'Evaluated',",
    'normalizedTrackerScore\\(score\\),',
    "'❌',",
    '`\\[\\$\\{num\\}\\]\\(reports/\\$\\{filename\\}\\)`,',
    'tsvSafe\\(`[^`]*\\$\\{modelName\\}[^`]*`\\),',
    '\\];',
  ].join('\\s*'));
  const wrongShape = ['openai-eval.mjs', 'ollama-eval.mjs']
    .filter(name => !nineFieldRe.test(readFile(name)));
  if (wrongShape.length === 0) {
    pass('openai-eval and ollama-eval build the nine-column addition with status before score');
  } else {
    fail(`tracker addition fields wrong or reordered in: ${wrongShape.join(', ')}`);
  }

  // Same family, second contract (#3795): every headless evaluator writes
  // `**URL:**` into its report header, per AGENTS.md Pipeline Integrity rule 3.
  // The report is where the posting URL survives the posting, and it is the only
  // place merge-tracker.mjs's resolveReportUrl() looks -- a report without the
  // line yields `no-url`, so the row can never be backfilled and stays outside
  // the deterministic URL dedup key, the tier merge-tracker tries FIRST and the
  // one that can prove two same-title rows are different openings.
  //
  // Two halves, because the line is worthless without a value to put in it:
  // the header must be written, AND the evaluator must have somewhere to
  // receive a posting URL from. Absent one, `(pasted)` is the honest value and
  // keeps the field present; normalizeUrl derives no key from it, so it cannot
  // hand every pasted row the same key.
  // Both halves run over comment-stripped source (`executable`, above), and the
  // header must carry an INTERPOLATED value rather than a bare literal: a
  // comment mentioning `**URL:**`, or a hardcoded line with nothing substituted
  // into it, would otherwise satisfy a raw-source scan while the report shipped
  // no URL -- a failure wearing a pass. Every writer today interpolates
  // (`**URL:** ${postingUrl || '(pasted)'}`, `**URL:** ${url}`), so requiring it
  // ties the header to a value reaching the report write path.
  const urlHeaderRe  = /\*\*URL:\*\*[^\n]*\$\{/;
  const urlSourceRe  = /--posting-url|\bpostingUrl\b|\$\{input \|\| '\(pasted\)'\}/;
  // Empty since #3797 landed the header in openai-eval.mjs and ollama-eval.mjs,
  // the two files it exempted. The list is asserted to be EXACTLY the files still
  // missing the header, so leaving the names here would fail as a stale
  // exemption -- which is what that guard is for. Kept rather than deleted: the
  // next evaluator added without a URL header has somewhere to be named
  // deliberately, instead of the check being quietly weakened to accommodate it.
  const pendingUrlHeader = [];
  const missingUrlHeader = evaluatorSources
    .map(([name, source]) => [name, executable(source)])
    .filter(([, source]) => !urlHeaderRe.test(source) || !urlSourceRe.test(source))
    .map(([name]) => name);
  const staleExemptions = pendingUrlHeader.filter(name => !missingUrlHeader.includes(name));
  const unexemptedGaps  = missingUrlHeader.filter(name => !pendingUrlHeader.includes(name));
  if (unexemptedGaps.length > 0) {
    fail(`headless evaluators write a report with no **URL:** header, so their rows can never reach the URL dedup key: ${unexemptedGaps.join(', ')}`);
  } else if (staleExemptions.length > 0) {
    fail(`stale #3797 exemption — these now carry the **URL:** header, remove them from pendingUrlHeader: ${staleExemptions.join(', ')}`);
  } else {
    pass('every headless evaluator outside the #3797 exemption writes **URL:** and takes a posting URL');
  }

  // Same family, third contract (#3796): the tracker-addition helpers are
  // imported, never redefined. Four evaluators carried private copies of
  // `tsvSafe` / `normalizedTrackerScore` and they drifted -- gemini-eval.mjs's
  // concatenated instead of parsing, so `SCORE: 4.2 (strong fit)` produced
  // `4.2 (strong fit)/5`, which is neither a score nor a sentinel and is the
  // undecidable cell merge-tracker.mjs refuses outright. The evaluation was
  // skipped wholly while the sibling copy had been immune all along.
  //
  // tests/evaluator-score-cell.test.mjs asserts the helpers exist exactly once;
  // this asserts the family reaches that one definition, which is the half a
  // fifth evaluator can fail without redefining anything -- by hand-rolling a
  // score cell inline instead, which is exactly what openrouter-runner.mjs did:
  // it never held a copy, so a copy-scan never saw it, while it wrote
  // `${value.toFixed(1)}/5` from a numeric prefix that discarded the
  // denominator, and the empty string when nothing parsed.
  //
  // USE, not merely import: an evaluator can import an unrelated helper from the
  // module and still build its score cell by hand, which would pass an
  // import-only check while the behaviour this contract exists to protect had
  // drifted again. Both halves are required -- the import proves it reaches the
  // shared definition, the call proves it is the definition actually used.
  const ADDITION_HELPERS = './lib/tracker-addition.mjs';
  const helperImportRe = /from\s+'\.\/lib\/tracker-addition\.mjs'/;
  const helperUseRe    = /\bnormalizedTrackerScore\s*\(/;
  // Empty, and it should stay that way. #3797 landed while this branch was open
  // and re-added copies to openai-eval.mjs and ollama-eval.mjs; both were
  // consolidated on the merge, which is the exemption being spent rather than
  // renewed. A new name here needs a reason with an issue number attached.
  const pendingHelperImport = [];
  const missingHelperImport = evaluatorSources
    .filter(([, source]) => !helperImportRe.test(source) || !helperUseRe.test(source))
    .map(([name]) => name);
  const staleHelperExemptions = pendingHelperImport.filter(name => !missingHelperImport.includes(name));
  const unexemptedHelperGaps  = missingHelperImport.filter(name => !pendingHelperImport.includes(name));
  if (unexemptedHelperGaps.length > 0) {
    fail(`headless evaluators build their tracker-addition cells without importing AND calling ${ADDITION_HELPERS}'s normalizedTrackerScore, the drift #3796 consolidated: ${unexemptedHelperGaps.join(', ')}`);
  } else if (staleHelperExemptions.length > 0) {
    fail(`stale #3796 exemption — these now import ${ADDITION_HELPERS}, remove them from pendingHelperImport: ${staleHelperExemptions.join(', ')}`);
  } else {
    pass(`every headless evaluator outside the #3796 exemption imports AND calls the shared tracker-addition helpers`);
  }

  // --count N: contiguous range from an empty dir.
  const rangeTmp = mkdtempSync(join(tmpdir(), 'career-ops-reserve-range-'));
  const range = reserveRun(['--count', '3'], rangeTmp);
  const rangeSentinels = ['001', '002', '003']
    .every(n => existsSync(join(rangeTmp, `${n}-RESERVED.md`)));
  if (range === '001-003' && rangeSentinels) {
    pass('--count 3 reserves contiguous range and prints START-END');
  } else {
    fail(`--count 3 produced stdout=${range}, all sentinels=${rangeSentinels}`);
  }

  // --count N continues after existing reports.
  writeFileSync(join(rangeTmp, '007-acme-2026-07-02.md'), '# stub');
  const afterExisting = reserveRun(['--count', '2'], rangeTmp);
  if (afterExisting === '008-009') {
    pass('--count starts range after highest existing slot');
  } else {
    fail(`--count after existing report produced ${afterExisting}, expected 008-009`);
  }

  // --count 1 keeps the single-number output format (backwards compatible).
  const countOne = reserveRun(['--count', '1'], rangeTmp);
  if (countOne === '010') {
    pass('--count 1 prints single number without dash');
  } else {
    fail(`--count 1 produced ${countOne}, expected 010`);
  }
  rmSync(rangeTmp, { recursive: true, force: true });

  // Collision mid-range: pre-place a sentinel at 007 with existing max 005.
  // maxSlot() counts RESERVED sentinels as occupied, so a foreign sentinel at
  // 007 bases the range past it (008-) — no slot below is ever attempted.
  // (The rollback path is exercised by the next test, not this one.)
  const collideTmp = mkdtempSync(join(tmpdir(), 'career-ops-reserve-collide-'));
  writeFileSync(join(collideTmp, '005-acme-2026-07-02.md'), '# stub');
  writeFileSync(join(collideTmp, '007-RESERVED.md'), '');
  const collided = reserveRun(['--count', '3'], collideTmp);
  const leaked006 = existsSync(join(collideTmp, '006-RESERVED.md'));
  const foreign007 = existsSync(join(collideTmp, '007-RESERVED.md'));
  if (collided === '008-010' && !leaked006 && foreign007) {
    pass('--count treats a foreign sentinel as occupied and bases the range past it');
  } else {
    fail(`sentinel-as-occupied: stdout=${collided} (want 008-010), 006 sentinel=${leaked006}, foreign 007 kept=${foreign007}`);
  }
  rmSync(collideTmp, { recursive: true, force: true });

  // Existing four-digit report names participate in the same occupancy scan.
  const highRangeTmp = mkdtempSync(join(tmpdir(), 'career-ops-reserve-high-range-'));
  writeFileSync(join(highRangeTmp, '999-acme-2026-07-02.md'), '# stub');
  writeFileSync(join(highRangeTmp, '1001-taken.md'), '# stub');
  const highRange = reserveRun(['--count', '3'], highRangeTmp);
  const skipped1000 = !existsSync(join(highRangeTmp, '1000-RESERVED.md'));
  const blocker1001 = existsSync(join(highRangeTmp, '1001-taken.md'));
  const reservedHighRange = ['1002', '1003', '1004']
    .every(n => existsSync(join(highRangeTmp, `${n}-RESERVED.md`)));
  if (highRange === '1002-1004' && skipped1000 && blocker1001 && reservedHighRange) {
    pass('four-digit report files advance a contiguous range without truncation');
  } else {
    fail(`four-digit range: stdout=${highRange} (want 1002-1004), 1000 skipped=${skipped1000}, blocker kept=${blocker1001}, sentinels=${reservedHighRange}`);
  }
  rmSync(highRangeTmp, { recursive: true, force: true });

  // Range-vs-range: two concurrent --count 4 reservations must not overlap.
  // Terminates by construction: each restart strictly advances the base.
  let reserveRetries = 1;
  while (reserveRetries >= 0) {
    const concTmp = mkdtempSync(join(tmpdir(), 'career-ops-reserve-conc-'));
    try {
      const spawnReserve = () => new Promise(resolve => {
        const child = spawn(NODE, [RESERVE, '--count', '4'], {
          env: { ...process.env, CAREER_OPS_REPORTS_DIR: concTmp, CAREER_OPS_BATCH_STATE: join(concTmp, 'batch-state.tsv') },
        });
        let stdout = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.on('close', () => resolve(stdout.trim()));
      });
      const [rangeX, rangeY] = await Promise.all([spawnReserve(), spawnReserve()]);
      const toNums = r => {
        const [s, e] = r.split('-').map(Number);
        return Array.from({ length: e - s + 1 }, (_, i) => s + i);
      };
      const overlap = toNums(rangeX).filter(n => toNums(rangeY).includes(n));
      if (rangeX && rangeY && overlap.length === 0) {
        pass(`concurrent --count 4 reservations are disjoint (${rangeX} vs ${rangeY})`);
      } else {
        throw new Error(`concurrent ranges overlap: ${rangeX} vs ${rangeY} share [${overlap}]`);
      }
      break;
    } catch (e) {
      if (reserveRetries > 0) {
        warn(`concurrent reservation test flaked (${e.message}). Retrying once...`);
        reserveRetries -= 1;
      } else {
        fail(`concurrent reservation test failed: ${e.message}`);
        break;
      }
    } finally {
      rmSync(concTmp, { recursive: true, force: true });
    }
  }

  // --release with a range deletes every sentinel in it.
  const reserveRunFail = (args, dir) => {
    try {
      execFileSync(NODE, [RESERVE, ...args], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CAREER_OPS_REPORTS_DIR: dir, CAREER_OPS_TRACKER: join(dir, 'applications.md'), CAREER_OPS_BATCH_STATE: join(dir, 'batch-state.tsv') },
      });
      return null;
    } catch (err) {
      return err.status;
    }
  };
  const relTmp = mkdtempSync(join(tmpdir(), 'career-ops-reserve-release-'));
  reserveRun(['--count', '4'], relTmp); // reserves 001-004
  reserveRun(['--release', '001-004'], relTmp);
  const anyLeft = ['001', '002', '003', '004']
    .some(n => existsSync(join(relTmp, `${n}-RESERVED.md`)));
  if (!anyLeft) {
    pass('--release NNN-MMM deletes all sentinels in range');
  } else {
    fail('--release range left sentinels behind');
  }

  // Invalid inputs exit non-zero.
  const badCount = reserveRunFail(['--count', '0'], relTmp);
  const hugeCount = reserveRunFail(['--count', '999'], relTmp);
  const badRelease = reserveRunFail(['--release', '009-004'], relTmp);
  const hugeRelease = reserveRunFail(['--release', '1-9007199254740992'], relTmp);
  const wideRelease = reserveRunFail(['--release', '1-51'], relTmp);
  if (badCount === 1 && hugeCount === 1 && badRelease === 1
      && hugeRelease === 1 && wideRelease === 1) {
    pass('invalid counts and unsafe, inverted, or oversized release ranges exit 1');
  } else {
    fail(`validation exits: count0=${badCount}, count999=${hugeCount}, inverted=${badRelease}, unsafe=${hugeRelease}, wide=${wideRelease}`);
  }
  rmSync(relTmp, { recursive: true, force: true });
} catch (e) {
  fail(`reserve-report-num tests crashed: ${e.message}`);
}

// ── VERIFY-PIPELINE REPORT CHECKS (#1425) ───────────────────────
// Parallel evaluators can write two reports for the same company+role, and
// tracker dedup can leave a report file with no tracker row. verify-pipeline
// must surface both as warnings (not errors — re-evaluations are legitimate).
console.log('\n🧪 Testing verify-pipeline duplicate/orphan report checks...');
try {
  const vpTmp = mkdtempSync(join(tmpdir(), 'career-ops-verify-reports-'));
  try {
    const vpReports = join(vpTmp, 'reports');
    mkdirSync(vpReports, { recursive: true });
    const vpTracker = join(vpTmp, 'applications.md');
    const vpEnv = { ...process.env, CAREER_OPS_TRACKER: vpTracker, CAREER_OPS_REPORTS: vpReports };

    const report = (company, role) =>
      `# Evaluación: ${company} — ${role}\n\n## Machine Summary\n\n\`\`\`yaml\ncompany: "${company}"\nrole: "${role}"\nscore: 4.2\n\`\`\`\n`;

    // #1 and #3 are the same role at Acme written by two concurrent workers;
    // #2 is a different Acme role (must NOT be flagged as duplicate);
    // #3 also has no tracker row (orphan — tracker dedup kept #1).
    writeFileSync(join(vpReports, '001-acme-2026-01-04.md'), report('Acme', 'Staff AI Engineer'));
    writeFileSync(join(vpReports, '002-acme-2026-01-05.md'), report('Acme', 'Platform Engineer'));
    writeFileSync(join(vpReports, '003-acme-2026-01-05.md'), report('Acme', 'Staff AI Engineer'));

    writeFileSync(vpTracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 1 | 2026-01-04 | Acme | Staff AI Engineer | 4.2/5 | Evaluated | ❌ | [1](reports/001-acme-2026-01-04.md) | ok |\n' +
      '| 2 | 2026-01-05 | Acme | Platform Engineer | 4.0/5 | Evaluated | ❌ | [2](reports/002-acme-2026-01-05.md) | ok |\n');

    const vpOut = run(NODE, ['verify-pipeline.mjs'], { env: vpEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    if (vpOut === null) {
      fail('verify-pipeline crashed on duplicate/orphan report fixture');
    } else {
      if (vpOut.includes('Duplicate reports for same company+role') &&
          vpOut.includes('001-acme-2026-01-04.md') && vpOut.includes('003-acme-2026-01-05.md')) {
        pass('duplicate reports for the same company+role are flagged (#1425)');
      } else {
        fail('duplicate company+role reports not flagged');
      }
      if (vpOut.includes('002-acme-2026-01-05.md') && /Duplicate reports[^\n]*002-acme/.test(vpOut)) {
        fail('different role at the same company falsely flagged as duplicate report');
      } else {
        pass('different role at the same company is not flagged as duplicate');
      }
      if (/Orphan report[^\n]*#3[^\n]*003-acme-2026-01-05\.md/.test(vpOut)) {
        pass('orphan report with no tracker row is flagged (#1425)');
      } else {
        fail('orphan report not flagged');
      }
      if (/Orphan report[^\n]*(001|002)-acme/.test(vpOut)) {
        fail('referenced report falsely flagged as orphan');
      } else {
        pass('referenced reports are not flagged as orphans');
      }
      // run() returns non-null only on exit 0 — warnings must not fail the check.
      pass('duplicate/orphan report findings stay warning-level (exit 0)');
    }

    // Clean fixture: one row, one report — both checks must pass green.
    rmSync(join(vpReports, '003-acme-2026-01-05.md'));
    const vpClean = run(NODE, ['verify-pipeline.mjs'], { env: vpEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    if (vpClean !== null &&
        vpClean.includes('No duplicate reports for the same company+role') &&
        vpClean.includes('No orphan reports')) {
      pass('clean tracker+reports fixture passes both report checks');
    } else {
      fail('clean fixture did not pass duplicate/orphan report checks');
    }
  } finally {
    rmSync(vpTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`verify-pipeline report checks crashed: ${e.message}`);
}

// ── VERIFY-PIPELINE, THE ALPHABET THE FIXTURE ABOVE DOES NOT COVER ──────
// The fixture above proves the duplicate MECHANISM works. Every string in it
// is ASCII, so it cannot tell "the detector works" apart from "the detector
// works for Latin names" — and the difference is not academic. `İ`.toLowerCase()
// yields `i` + U+0307 (a combining dot that survives normalization), so
// `İstanbul Tekstil` and `Istanbul Tekstil` key differently and the duplicate
// goes UNDETECTED. That is the opposite failure to the one fixed in #2393,
// where every non-Latin name collapsed to '' and everything collided: that was
// loud and got fixed. This one is silent, and it is the integrity checker
// itself that returns the green.
//
// THIS TEST PINS TODAY'S BEHAVIOR ON PURPOSE. It is not an endorsement: the
// targeted fix (strip U+0307 after lowercasing) is measured and does NOT touch
// Škoda/Nestlé/Zürich, but normalizeTextKey is a frozen contract surface with
// eight production consumers plus the web mirror, so applying it is a
// coordinated decision, not a drive-by. If you are here because this assertion
// failed, you did not break anything: you changed that decision. Invert the
// expectation, update tests/fixtures/company-key-corpus.json, and land it in
// lockstep with the web.
console.log('\n🧪 Testing verify-pipeline duplicate detection across alphabets...');
try {
  const tkTmp = mkdtempSync(join(tmpdir(), 'career-ops-verify-turkish-'));
  try {
    const tkReports = join(tkTmp, 'reports');
    mkdirSync(tkReports, { recursive: true });
    const tkTracker = join(tkTmp, 'applications.md');
    const tkEnv = { ...process.env, CAREER_OPS_TRACKER: tkTracker, CAREER_OPS_REPORTS: tkReports };
    const tkReport = (company, role) =>
      `# Evaluación: ${company} — ${role}\n\n## Machine Summary\n\n\`\`\`yaml\ncompany: "${company}"\nrole: "${role}"\nscore: 4.0\n\`\`\`\n`;

    // Same employer, same role, two spellings a Turkish user types interchangeably.
    writeFileSync(join(tkReports, '001-istanbul-2026-02-01.md'), tkReport('İstanbul Tekstil', 'Yazılım Mühendisi'));
    writeFileSync(join(tkReports, '002-istanbul-2026-02-02.md'), tkReport('Istanbul Tekstil', 'Yazılım Mühendisi'));
    writeFileSync(tkTracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 1 | 2026-02-01 | İstanbul Tekstil | Yazılım Mühendisi | 4.0/5 | Evaluated | ❌ | [1](reports/001-istanbul-2026-02-01.md) | ok |\n' +
      '| 2 | 2026-02-02 | Istanbul Tekstil | Yazılım Mühendisi | 4.0/5 | Evaluated | ❌ | [2](reports/002-istanbul-2026-02-02.md) | ok |\n');

    const tkOut = run(NODE, ['verify-pipeline.mjs'], { env: tkEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    if (tkOut === null) {
      fail('verify-pipeline crashed on the Turkish dotted-I fixture');
    } else {
      // Check 2 reads the tracker's own Company column, where the two spellings
      // survive intact, so this is the one the dotted I blinds.
      // Decision changed 12-ago (Santiago): the targeted fix landed, so the
      // tracker check now folds the dotted I and DOES catch the duplicate.
      // Left pinned in the opposite direction so a revert is loud.
      if (/Possible duplicates/.test(tkOut)) {
        pass('tracker dup check (Check 2) now folds the dotted I and catches the duplicate');
      } else {
        fail('dotted-I tracker duplicate no longer detected: the targeted fix regressed (see company-key-corpus.json)');
      }
      // …while Check 9 groups reports by the FILENAME slug, which is already
      // ASCII by the time a report is written, so it flags the very same pair.
      // The comment above `const normalizeKey = normalizeTextKey` promises the
      // two checks "can never disagree about whether two roles are the same".
      // They can, and here they do: sharing the function is not sharing the
      // INPUT. Pinned so the contradiction is visible in CI instead of living
      // only in a maintainer's notes.
      if (/Duplicate reports[^\n]*001-istanbul/.test(tkOut)) {
        pass('report dup check (Check 9) DOES flag the same pair — the two checks disagree, contrary to the guarantee written at its definition');
      } else {
        fail('Check 9 no longer flags the pair: the two checks now agree, so update the note at `const normalizeKey = normalizeTextKey`');
      }
    }
    // The control that makes the assertions above mean something: within one
    // spelling the tracker check must still fire, or "not detected" would prove
    // nothing about the alphabet and everything about a broken fixture.
    writeFileSync(tkTracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 1 | 2026-02-01 | İstanbul Tekstil | Yazılım Mühendisi | 4.0/5 | Evaluated | ❌ | [1](reports/001-istanbul-2026-02-01.md) | ok |\n' +
      '| 2 | 2026-02-02 | İstanbul Tekstil | Yazılım Mühendisi | 4.0/5 | Evaluated | ❌ | [2](reports/002-istanbul-2026-02-02.md) | ok |\n');
    const tkCtl = run(NODE, ['verify-pipeline.mjs'], { env: tkEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    if (tkCtl !== null && /Possible duplicates/.test(tkCtl)) {
      pass('same-spelling Turkish duplicate IS caught by Check 2 (control: the fixture exercises the real path)');
    } else {
      fail('control failed: two identical Turkish rows were not flagged, so the fixture proves nothing');
    }
  } finally {
    rmSync(tkTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`verify-pipeline alphabet checks crashed: ${e.message}`);
}

// ── VERIFY-PIPELINE ORPHAN REFERENCE RESOLUTION (#1425 follow-up) ────────────
// Check 10 resolves "is this report referenced?" three ways. Two of them were
// wrong:
//   (a) a cell may carry SEVERAL links ("[901](…) / [902](…)" — a re-evaluation
//       keeping both reports on record). A single .match() sees only the first,
//       so every later link false-positives as an orphan.
//   (b) the row's own number was credited UNCONDITIONALLY. Row and report
//       numbers are independent counters that diverge in normal operation
//       (#1733), so a row that links elsewhere silently "references" an
//       unrelated report sharing its number, masking a real orphan.
console.log('\n🧪 Testing verify-pipeline orphan reference resolution (#1425 follow-up)');
try {
  const orTmp = mkdtempSync(join(tmpdir(), 'career-ops-verify-orphan-'));
  try {
    const orReports = join(orTmp, 'reports');
    mkdirSync(orReports, { recursive: true });
    const orTracker = join(orTmp, 'applications.md');
    const orEnv = { ...process.env, CAREER_OPS_TRACKER: orTracker, CAREER_OPS_REPORTS: orReports };
    const rpt = (company, role) =>
      `# Evaluación: ${company} — ${role}\n\n## Machine Summary\n\n\`\`\`yaml\ncompany: "${company}"\nrole: "${role}"\nscore: 3.1\n\`\`\`\n`;

    // 901 + 902: one posting evaluated twice; row 900 keeps BOTH on record.
    // 950: a genuine orphan whose number collides with row 950, which links 955.
    // 955: the report row 950 actually points at.
    // 970: referenced ONLY by the row-number fallback (its row carries no link).
    writeFileSync(join(orReports, '901-acme-2026-02-01.md'), rpt('Acme', 'Director of Platform'));
    writeFileSync(join(orReports, '902-acme-2026-02-09.md'), rpt('Acme', 'Director of Platform'));
    writeFileSync(join(orReports, '950-globex-2026-03-02.md'), rpt('Globex', 'QA Manager'));
    writeFileSync(join(orReports, '955-initech-2026-03-05.md'), rpt('Initech', 'Test Lead'));
    writeFileSync(join(orReports, '970-hooli-2026-03-06.md'), rpt('Hooli', 'Release Manager'));

    writeFileSync(orTracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 900 | 2026-02-01 | Acme | Director of Platform | 3.1/5 | Evaluated | ❌ | ' +
        '[901](reports/901-acme-2026-02-01.md) / [902](reports/902-acme-2026-02-09.md) | re-eval |\n' +
      '| 950 | 2026-03-05 | Initech | Test Lead | 3.1/5 | Evaluated | ❌ | ' +
        '[955](reports/955-initech-2026-03-05.md) | row number collides with orphan report 950 |\n' +
      '| 970 | 2026-03-06 | Hooli | Release Manager | 3.1/5 | Evaluated | ❌ | — | legacy row, no markdown link |\n');

    const orOut = run(NODE, ['verify-pipeline.mjs'], { env: orEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    if (orOut === null) {
      fail('verify-pipeline crashed on the orphan-reference fixture');
    } else {
      // (a) second link of a dual-link cell must NOT be an orphan.
      if (/Orphan report[^\n]*902-acme/.test(orOut)) {
        fail('dual-link cell: second link (902) falsely flagged as orphan — .match() sees only the first');
      } else {
        pass('dual-link report cell resolves BOTH links, not just the first (#1425 follow-up)');
      }
      if (/Orphan report[^\n]*901-acme/.test(orOut)) {
        fail('dual-link cell: first link (901) falsely flagged as orphan');
      } else {
        pass('dual-link report cell resolves its first link');
      }
      // (b) a row's own number must not mask an unrelated orphan sharing it.
      if (/Orphan report[^\n]*#950[^\n]*950-globex/.test(orOut)) {
        pass('row number does not mask an unrelated orphan sharing it (#1733 divergence)');
      } else {
        fail('orphan 950 masked by row 950, which links report 955 — row number credited unconditionally');
      }
      if (/Orphan report[^\n]*955-initech/.test(orOut)) {
        fail('linked report 955 falsely flagged as orphan');
      } else {
        pass('report referenced by a linking row is not flagged');
      }
      // A link-less row is the ONE case where the row number is still the only
      // signal. Report 970 exists on disk, so this assertion can genuinely fail
      // if the fallback is dropped.
      if (/Orphan report[^\n]*970-hooli/.test(orOut)) {
        fail('link-less legacy row lost its row-number fallback — report 970 flagged');
      } else {
        pass('link-less row still falls back to its own number');
      }
    }
  } finally {
    rmSync(orTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`verify-pipeline orphan reference resolution crashed: ${e.message}`);
}

// ── VERIFY-PIPELINE DUPLICATE TRACKER NUMBER (#1704) ────────────
// A tracker # must be a unique row id. Two rows sharing a # is never
// legitimate (unlike Check 2's company+role dedup, which can false-positive
// on a genuine re-application) — verify-pipeline must flag it as an error.
console.log('\n🧪 Testing verify-pipeline duplicate tracker # check (#1704)...');
try {
  const dupNumTmp = mkdtempSync(join(tmpdir(), 'career-ops-verify-dupnum-'));
  try {
    const dupNumTracker = join(dupNumTmp, 'applications.md');
    const dupNumEnv = { ...process.env, CAREER_OPS_TRACKER: dupNumTracker };

    writeFileSync(dupNumTracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 698 | 2026-05-29 | University of Alberta | Curriculum Coordinator | 3.8/5 | Evaluated | ❌ | — | — |\n' +
      '| 698 | 2026-06-03 | Esri Canada | Manager Talent and Organizational Development | 4.1/5 | Evaluated | ❌ | — | — |\n' +
      '| 700 | 2026-06-10 | Shopify | Staff Engineer | 4.5/5 | Evaluated | ❌ | — | — |\n');

    let dupNumOut;
    try {
      dupNumOut = execFileSync(NODE, ['verify-pipeline.mjs'], { cwd: ROOT, env: dupNumEnv, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
      fail('verify-pipeline should exit non-zero on a duplicate tracker number');
    } catch (e) {
      dupNumOut = (e.stdout || '').toString();
      if (e.status === 1) {
        pass('verify-pipeline exits 1 on a duplicate tracker number');
      } else {
        fail(`verify-pipeline: expected exit 1, got ${e.status}`);
      }
    }
    if (dupNumOut.includes('Duplicate tracker number #698')
        && dupNumOut.includes('University of Alberta') && dupNumOut.includes('Esri Canada')) {
      pass('duplicate tracker number #698 flagged with both colliding rows named');
    } else {
      fail(`duplicate tracker number not flagged with both rows\n${dupNumOut}`);
    }
    if (/Duplicate tracker number #700/.test(dupNumOut)) {
      fail('unique #700 row falsely flagged as a duplicate tracker number');
    } else {
      pass('unique tracker number not falsely flagged');
    }
  } finally {
    rmSync(dupNumTmp, { recursive: true, force: true });
  }

  // Clean fixture: no duplicate numbers — must pass green.
  const cleanTmp = mkdtempSync(join(tmpdir(), 'career-ops-verify-dupnum-clean-'));
  try {
    const cleanTracker = join(cleanTmp, 'applications.md');
    writeFileSync(cleanTracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Evaluated | ❌ | — | — |\n' +
      '| 2 | 2026-01-02 | Globex | Analyst | 3.9/5 | Evaluated | ❌ | — | — |\n');
    const cleanOut = run(NODE, ['verify-pipeline.mjs'], { env: { ...process.env, CAREER_OPS_TRACKER: cleanTracker }, stdio: ['pipe', 'pipe', 'pipe'] });
    if (cleanOut !== null && cleanOut.includes('No duplicate tracker numbers')) {
      pass('clean tracker with unique numbers passes the duplicate-number check');
    } else {
      fail('clean fixture did not pass the duplicate tracker number check');
    }
  } finally {
    rmSync(cleanTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`verify-pipeline duplicate tracker number test crashed: ${e.message}`);
}

// ── SHARED ROLE MATCHER + DEDUP-TRACKER SAFETY (#947) ───────────
// dedup-tracker.mjs used to ship an older fuzzy role matcher than
// merge-tracker.mjs. That weaker matcher collapsed sibling roles at the same
// company when they shared generic title words such as "Full Stack Engineer",
// and could delete an already-Applied row because data/applications.md is
// normally gitignored. The matcher is now shared, and dedup protects advanced
// application states from fuzzy-only deletion.
console.log('\n🧪 Testing shared role matcher and dedup-tracker safety...');
try {
  const { roleFuzzyMatch, roleTokens } = await import(pathToFileURL(join(ROOT, 'role-matcher.mjs')).href);

  if (!roleFuzzyMatch('Full Stack Engineer, Foundation', 'Full Stack Engineer, Guarded Releases')) {
    pass('role matcher keeps Full Stack Engineer sibling teams distinct (#947)');
  } else {
    fail('role matcher still collapses distinct Full Stack Engineer sibling teams');
  }

  if (!roleFuzzyMatch('Staff Software Engineer, API', 'Staff Software Engineer, SDK')) {
    pass('role matcher keeps short-acronym sibling teams distinct');
  } else {
    fail('role matcher collapsed API and SDK sibling teams');
  }

  if (roleFuzzyMatch('Staff Software Engineer, API', 'Staff Software Engineer, API Platform')) {
    pass('role matcher still uses short specialty acronyms for true overlaps');
  } else {
    fail('role matcher ignored a real short-acronym overlap');
  }

  // 'product' is a baseline token: "ai" is dropped by the tokenizer (2-letter,
  // not in SHORT_SPECIALTY), so without this these titles collapse to
  // [product, manager] and merge-tracker skips one as a false duplicate.
  if (!roleFuzzyMatch('Product Manager - Marketplace', 'Product Manager - AI')) {
    pass('role matcher keeps Product Manager sibling specialties distinct');
  } else {
    fail('role matcher collapsed Product Manager - Marketplace into Product Manager - AI');
  }

  if (roleFuzzyMatch('Product Manager - Marketplace', 'Product Manager - Marketplace')) {
    pass('role matcher still matches identical Product Manager titles');
  } else {
    fail('role matcher rejected an identical Product Manager title');
  }

  // A generic base title (no suffix of its own) shares every one of its tokens
  // with a specialized sibling, so the shared tokens alone used to cross the
  // Jaccard threshold — even though the sibling's extra word is exactly the
  // signal that these are two different, separately-postable openings.
  if (!roleFuzzyMatch('Senior Analytics Engineer', 'Senior Analytics Engineer, People Analytics')) {
    pass('role matcher keeps a base title distinct from its specialized-suffix sibling (#1881)');
  } else {
    fail('role matcher collapsed a base title into its specialized-suffix sibling');
  }

  // A true repost of the same base title must still match.
  if (roleFuzzyMatch('Senior Analytics Engineer', 'Senior Analytics Engineer')) {
    pass('role matcher still matches an exact-title repost');
  } else {
    fail('role matcher rejected an exact-title repost');
  }

  // Seniority omitted on one side is not a specialization suffix — still a repost.
  if (roleFuzzyMatch('Data Engineer', 'Senior Data Engineer')) {
    pass('role matcher still matches when seniority is only stated on one side');
  } else {
    fail('role matcher rejected a repost that only adds a seniority word');
  }

  // A sub-baseline qualifier on ONE side is a level disagreement, not a loose
  // rewrite: the tokenizer drops seniority words as stopwords, so these pairs
  // otherwise tokenize identically and scored a perfect Jaccard ratio, silently
  // collapsing two genuinely different requisitions (#2009).
  for (const [lower, bare] of [
    ['Associate Product Manager, TeamName', 'Product Manager, TeamName'],
    ['Junior Product Manager, TeamName', 'Product Manager, TeamName'],
    ['Entry Level Data Engineer', 'Data Engineer'],
  ]) {
    if (!roleFuzzyMatch(lower, bare)) {
      pass(`role matcher keeps "${lower}" distinct from the bare title (#2009)`);
    } else {
      fail(`role matcher collapsed "${lower}" into the bare title "${bare}"`);
    }
  }

  // Direction must not matter — the lone qualifier can be on either side.
  if (!roleFuzzyMatch('Product Manager, TeamName', 'Associate Product Manager, TeamName')) {
    pass('role matcher applies the sub-baseline gate in both argument orders (#2009)');
  } else {
    fail('role matcher only applied the sub-baseline gate in one argument order');
  }

  // Both sides sub-baseline at the same level is still the same opening.
  if (roleFuzzyMatch('Associate Product Manager, TeamName', 'Associate Product Manager, TeamName')) {
    pass('role matcher still matches two same-level Associate reposts (#2009)');
  } else {
    fail('role matcher rejected a genuine Associate-level repost');
  }

  // A repost annotation is tracking metadata, not a specialization — must still match.
  if (roleFuzzyMatch('Learning Development Designer III', 'Learning Development Designer III (Repost)')) {
    pass('role matcher does not treat a "(Repost)" annotation as a specialization marker');
  } else {
    fail('role matcher wrongly treated a "(Repost)" annotation as a distinct sibling role');
  }

  // "Member of Technical Staff" is a boilerplate level-prefix used by several
  // companies for senior IC titles. Without stripping it, "member" and
  // "technical" leaked through as apparently-discriminating tokens and made two
  // genuinely different roles register as a fuzzy-match false positive.
  if (!roleFuzzyMatch('Member of Technical Staff, Connector Platform', 'Member of Technical Staff, Backend Platform')) {
    pass('role matcher keeps distinct "Member of Technical Staff" sibling roles apart');
  } else {
    fail('role matcher collapsed distinct "Member of Technical Staff" sibling roles');
  }

  if (roleFuzzyMatch('Member of Technical Staff, Connector Platform', 'Member of Technical Staff, Connector Platform')) {
    pass('role matcher still matches an exact "Member of Technical Staff" repost');
  } else {
    fail('role matcher rejected an exact "Member of Technical Staff" repost');
  }

  // The MTS fix strips the literal "member of technical staff" phrase, not a
  // blanket stopword on "member"/"technical" — those words must keep their
  // normal discriminating role in titles where the phrase isn't present.
  if (!roleFuzzyMatch('Technical Writer, API Docs', 'Technical Writer, Onboarding Guides')) {
    pass('role matcher still treats "technical" as discriminating outside the MTS phrase');
  } else {
    fail('role matcher over-stripped "technical" outside the MTS phrase');
  }

  // A blanket "technical" stopword would also break real reposts: stripped from
  // both sides here, only "recruiter" is left, which alone can't clear the
  // 2-token overlap minimum. Phrase-aware stripping keeps "technical" as a
  // normal contributing token outside the MTS phrase, so the repost still matches.
  if (roleFuzzyMatch('Senior Technical Recruiter, EMEA', 'Technical Recruiter, EMEA')) {
    pass('role matcher still matches a real repost that happens to contain "technical"');
  } else {
    fail('role matcher rejected a real repost because "technical" was over-stripped');
  }

  // Stripping the MTS phrase can leave 0-1 tokens for a bare or short-suffix
  // title, which would otherwise fall short of the 2-token overlap minimum —
  // even for an exact repost of itself. The exact-match fast path in
  // roleFuzzyMatch guards this regardless of tokenization.
  if (roleFuzzyMatch('Member of Technical Staff', 'Member of Technical Staff')) {
    pass('role matcher matches a bare "Member of Technical Staff" exact repost');
  } else {
    fail('role matcher rejected a bare "Member of Technical Staff" exact repost');
  }

  if (roleFuzzyMatch('Member of Technical Staff, Backend', 'Member of Technical Staff, Backend')) {
    pass('role matcher matches an exact repost of a short-suffix MTS title');
  } else {
    fail('role matcher rejected an exact repost of a short-suffix MTS title');
  }

  // A non-identical repost (different punctuation) with a genuinely
  // discriminating one-word suffix still needs 2+ tokens to clear the
  // overlap minimum — the "engineer" filler (a BASELINE_TOKENS entry) pads
  // that count without ever being the sole reason two titles match.
  if (roleFuzzyMatch('Member of Technical Staff, Connector', 'Member of Technical Staff - Connector')) {
    pass('role matcher matches a punctuation-variant repost of a short-suffix MTS title');
  } else {
    fail('role matcher rejected a punctuation-variant repost of a short-suffix MTS title');
  }

  if (roleFuzzyMatch('Member of Technical Staff, Connector', 'Member of Technical Staff, Backend')) {
    fail('role matcher collapsed distinct one-word-suffix MTS roles via the "engineer" filler');
  } else {
    pass('role matcher keeps distinct one-word-suffix MTS roles apart despite the "engineer" filler');
  }

  // Slashed short acronyms used to vanish in tokenization ("(CI/CD)" → "ci cd"
  // → both dropped by the length filter), so a sibling req whose ONLY
  // distinguishing qualifier is a slashed acronym tokenized identically to the
  // bare title — the #1881 subset guard never saw an extra token — and
  // merge-tracker overwrote the Applied row's title/score/report (#2165).
  if (!roleFuzzyMatch(
    'Senior Software Engineer, Infrastructure',
    'Senior Software Engineer, Infrastructure (CI/CD)'
  )) {
    pass('role matcher keeps a slash-acronym-qualified sibling req distinct (#2165)');
  } else {
    fail('role matcher still collapses sibling reqs whose only qualifier is a slashed acronym');
  }

  if (roleFuzzyMatch(
    'Senior Software Engineer, Infrastructure (CI/CD)',
    'Senior Software Engineer, Infrastructure CI/CD'
  )) {
    pass('role matcher still matches the same slash-acronym role across punctuation variants');
  } else {
    fail('role matcher stopped matching identical slash-acronym roles');
  }

  // Accented Latin titles used to split at the accent instead of folding it, so
  // "Sênior" tokenized to ["s", "nior"]: "s" fell to the length filter and
  // "nior" survived as a phantom token that is in no stopword list. Every
  // downstream rule then misfired at once (#2207).
  // Assert the whole token list, not just the absence of "nior": a fix that
  // merely deleted non-ASCII would still leave a phantom ("snior") and pass a
  // negative check.
  const accentTokens = roleTokens('Software Engineer Node.js Sênior');
  const plainTokens = roleTokens('Software Engineer Node.js Senior');
  if (JSON.stringify(accentTokens) === JSON.stringify(plainTokens)) {
    pass('role tokenizer folds accents onto the plain-ASCII token list (#2207)');
  } else {
    fail(`accented title tokenized differently from its plain spelling: ${JSON.stringify(accentTokens)} vs ${JSON.stringify(plainTokens)}`);
  }

  // Folding must delete combining marks only. Standalone characters such as
  // "·" are separators in a title; deleting them would glue two words into a
  // single token and turn a real repost into a duplicate row.
  const separatorTokens = roleTokens('Backend Engineer·Payments');
  if (separatorTokens.includes('payments') && !separatorTokens.some(w => w.includes('engineerpayments'))) {
    pass('accent folding leaves standalone separator characters splitting words (#2207)');
  } else {
    fail(`accent folding swallowed a separator character: ${JSON.stringify(separatorTokens)}`);
  }

  // The phantom token is shared by every accented title, so it acted as a
  // discriminating overlap and pushed two unrelated roles past the Jaccard
  // threshold — exactly what the baseline-token guard exists to prevent.
  if (!roleFuzzyMatch('Software Engineer Node.js Sênior', 'Software Engineer Flutter Sênior')) {
    pass('role matcher keeps accented sibling roles distinct (#2207)');
  } else {
    fail('role matcher collapsed two accented sibling roles via the phantom accent token');
  }

  // Worse than a generic collision: "Sênior" and "Júnior" both reduce to the
  // same "nior" phantom, so opposite seniority levels matched each other while
  // the seniority-disagreement gate saw no seniority token at all.
  if (!roleFuzzyMatch('Engenheiro de Dados Sênior', 'Engenheiro de Dados Júnior')) {
    pass('role matcher keeps accented Sênior and Júnior requisitions distinct (#2207)');
  } else {
    fail('role matcher merged an accented Sênior req into an accented Júnior req');
  }

  // The same defect also caused false negatives: a genuine repost written once
  // with the accent and once without tokenized differently and never matched.
  if (roleFuzzyMatch('Engenheiro de Software Sênior, Pagamentos', 'Engenheiro de Software Senior, Pagamentos')) {
    pass('role matcher matches a repost across accented and unaccented spellings (#2207)');
  } else {
    fail('role matcher missed a repost that differs only by an accent');
  }

  // Folding must not over-merge: accented specialty words have to survive as
  // their own distinct tokens, not collapse into one another.
  if (!roleFuzzyMatch('Ingeniero de Software Sênior, Búsqueda', 'Ingeniero de Software Sênior, Pagos')) {
    pass('role matcher keeps accented specialty suffixes distinct after folding (#2207)');
  } else {
    fail('accent folding collapsed two distinct accented specialty suffixes');
  }

  // Folding is what lets the seniority gate see an accented qualifier at all.
  // Before it, "Sênior"/"Júnior" both reduced to the same "nior" phantom, which
  // survived as a non-baseline token on the qualified side only — so the
  // specialization-marker rule (strict subset + extra non-baseline word) fired
  // and returned false for BOTH. The gate itself never ran: extractSeniorities
  // saw no seniority token either way. That produced a right answer for the
  // wrong reason on "Júnior" and a plain false negative on "Sênior".
  //
  // After folding, the two cases separate on their actual meaning (#2009's
  // SUB_BASELINE_SENIORITY rule): "senior" is routinely added or dropped
  // between reposts of one req, while "junior" marks a genuinely lower-level
  // req with its own scope and req ID.
  if (roleFuzzyMatch('Sênior Product Manager, Marketplace', 'Product Manager, Marketplace')) {
    pass('accent folding lets a lone accented "Sênior" be read as the same req (#2207)');
  } else {
    fail('accented "Sênior" still blocked a repost of the same requisition');
  }

  if (!roleFuzzyMatch('Júnior Product Manager, Marketplace', 'Product Manager, Marketplace')) {
    pass('accent folding routes a lone accented "Júnior" through the sub-baseline gate (#2207)');
  } else {
    fail('accented "Júnior" collapsed a sub-baseline req into the bare title');
  }

  const dedupTmp = mkdtempSync(join(tmpdir(), 'career-ops-dedup-'));
  try {
    mkdirSync(join(dedupTmp, 'data'));
    const tracker = join(dedupTmp, 'data', 'applications.md');
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 21 | 2026-01-08 | Acme | Full Stack Engineer, Foundation | 3.9/5 | Applied | ❌ | [21](../reports/021-foundation.md) | applied sibling |\n' +
      '| 22 | 2026-01-08 | Acme | Full Stack Engineer, Guarded Releases | 4.3/5 | Evaluated | ❌ | [22](../reports/022-guarded.md) | evaluated sibling |\n' +
      '| 23 | 2026-01-08 | Acme | Staff Software Engineer, API | 4.0/5 | Evaluated | ❌ | [23](../reports/023-api.md) | acronym sibling |\n' +
      '| 24 | 2026-01-08 | Acme | Staff Software Engineer, SDK | 4.2/5 | Evaluated | ❌ | [24](../reports/024-sdk.md) | acronym sibling |\n' +
      '| 25 | 2026-01-08 | Acme | Product Engineer, Growth | 3.8/5 | Evaluated | ❌ | [25](../reports/025-growth-old.md) | duplicate old |\n' +
      '| 26 | 2026-01-09 | Acme | Product Engineer, Growth | 4.0/5 | Evaluated | ❌ | [26](../reports/026-growth-new.md) | duplicate new |\n' +
      '| 27 | 2026-01-08 | Acme | Solutions Engineer, Revenue | 3.0/5 | Applied | ❌ | [27](../reports/027-revenue-applied.md) | applied exact-title row |\n' +
      '| 28 | 2026-01-09 | Acme | Solutions Engineer, Revenue | 4.6/5 | Evaluated | ❌ | [28](../reports/028-revenue-eval.md) | evaluated exact-title row |\n' +
      '| 29 | 2026-01-08 | Acme | Data Engineer, Search | 3.1/5 | Applied | ❌ | [29](../reports/029-search-old.md) | malformed duplicate-number old row |\n' +
      '| 29 | 2026-01-09 | Acme | Data Engineer, Search | 4.1/5 | Evaluated | ❌ | [30](../reports/030-search-new.md) | malformed duplicate-number new row |\n' +
      // Distinct sibling roles at one company that the old fuzzy matcher
      // false-merged (shared [software, engineer, infrastructure] → Jaccard 0.6).
      // Exact company+title matching must keep both openings.
      '| 31 | 2026-01-10 | Cohere | Software Engineer, Data Infrastructure | 3.4/5 | Evaluated | ❌ | [31](../reports/013-cohere-data-infra.md) | distinct role — must survive |\n' +
      '| 32 | 2026-01-10 | Cohere | Senior Software Engineer, Agent Infrastructure | 4.0/5 | Evaluated | ❌ | [32](../reports/014-cohere-agent-infra.md) | distinct role — higher score |\n' +
      // Exact company+role duplicate of #32 (same title, both Evaluated) — must
      // collapse to one, keeping the higher score.
      '| 33 | 2026-01-11 | Cohere | Senior Software Engineer, Agent Infrastructure | 3.7/5 | Evaluated | ❌ | [33](../reports/033-cohere-agent-dup.md) | exact-title duplicate |\n' +
      // A Hired row vs a later exact-title repost. Hired must rank as an
      // advanced status: the accepted-job record can never lose a dedup
      // contest to a higher-scored repost.
      '| 34 | 2026-01-05 | HiredCo | Platform Engineer | 3.8/5 | Hired | ❌ | [34](../reports/034-hiredco.md) | the accepted job |\n' +
      '| 35 | 2026-01-12 | HiredCo | Platform Engineer | 4.2/5 | Evaluated | ❌ | [35](../reports/035-hiredco-repost.md) | repost of the accepted job |\n' +
      // Two DIFFERENT roles sharing a stale duplicate tracker number (the
      // known merge-bug artifact, verify-pipeline Check 12). A bare number
      // match must not read as same-report identity.
      '| 36 | 2026-01-06 | NumCo | Data Engineer | 3.9/5 | Applied | ❌ | [36](../reports/036-numco-data.md) | duplicate-number, applied |\n' +
      '| 36 | 2026-01-12 | NumCo | ML Engineer | 4.5/5 | Evaluated | ❌ | [37](../reports/037-numco-ml.md) | duplicate-number, different role |\n');

    const dedupResult = run(NODE, ['dedup-tracker.mjs'], { env: { ...process.env, CAREER_OPS_TRACKER: tracker } });
    if (dedupResult === null) {
      fail('dedup-tracker.mjs crashed during shared role matcher safety test');
    } else {
      const deduped = readFileSync(tracker, 'utf-8');

      if (deduped.includes('Full Stack Engineer, Foundation') && deduped.includes('Full Stack Engineer, Guarded Releases')) {
        pass('dedup-tracker preserves distinct Full Stack Engineer sibling rows');
      } else {
        fail('dedup-tracker removed a distinct Full Stack Engineer sibling row');
      }

      if (deduped.includes('Staff Software Engineer, API') && deduped.includes('Staff Software Engineer, SDK')) {
        pass('dedup-tracker preserves short-acronym sibling rows');
      } else {
        fail('dedup-tracker removed a short-acronym sibling row');
      }

      const growthRows = deduped.split('\n').filter(l => l.includes('Product Engineer, Growth'));
      if (growthRows.length === 1 && growthRows[0].includes('4.0/5')) {
        pass('dedup-tracker still removes a real duplicate evaluated row');
      } else {
        fail(`dedup-tracker duplicate handling broken: ${growthRows.length} Growth rows`);
      }

      const revenueRows = deduped.split('\n').filter(l => l.includes('Solutions Engineer, Revenue'));
      if (revenueRows.length === 2 && revenueRows.some(l => l.includes('Applied'))) {
        pass('dedup-tracker never removes Applied+ rows by fuzzy title match');
      } else {
        fail('dedup-tracker removed an Applied+ row by fuzzy title match');
      }

      const searchRows = deduped.split('\n').filter(l => l.includes('Data Engineer, Search'));
      if (searchRows.length === 1 && searchRows[0].includes('4.1/5') && searchRows[0].includes('Applied')) {
        pass('dedup-tracker handles duplicate tracker numbers using row-local line indexes');
      } else {
        fail(`dedup-tracker duplicate-number handling broken: ${searchRows.length} Search rows`);
      }

      // Regression: the old fuzzy matcher scored "Software Engineer, Data
      // Infrastructure" and "Senior Software Engineer, Agent Infrastructure" at
      // Jaccard 0.6 and deleted the lower-scored distinct role. Exact
      // company+title matching must keep both openings.
      const cohereDataInfra = deduped.split('\n').filter(l => l.includes('| Software Engineer, Data Infrastructure |'));
      if (cohereDataInfra.length === 1) {
        pass('dedup-tracker keeps distinct same-company Cohere role (Data Infrastructure) — no fuzzy false-merge');
      } else {
        fail(`dedup-tracker false-merged the distinct Cohere Data Infrastructure role: ${cohereDataInfra.length} rows`);
      }

      const cohereAgentInfra = deduped.split('\n').filter(l => l.includes('| Senior Software Engineer, Agent Infrastructure |'));
      if (cohereAgentInfra.length === 1 && cohereAgentInfra[0].includes('4.0/5')) {
        pass('dedup-tracker merges an exact company+role duplicate to one (keeps highest score)');
      } else {
        fail(`dedup-tracker exact-duplicate handling broken: ${cohereAgentInfra.length} Cohere Agent Infrastructure rows`);
      }

      // Regression: Hired was missing from STATUS_RANK, so it ranked 0 — the
      // advanced-status guard never fired and a higher-scored repost deleted
      // the accepted-job record.
      const hiredRows = deduped.split('\n').filter(l => l.includes('HiredCo'));
      if (hiredRows.length === 2 && hiredRows.some(l => l.includes('Hired'))) {
        pass('dedup-tracker protects a Hired row from an exact-title repost');
      } else {
        fail(`dedup-tracker deleted the Hired row: ${hiredRows.length} HiredCo rows survive`);
      }

      // Regression: a bare tracker-number match short-circuited roleMatch, so
      // two different roles sharing a stale duplicate # merged and the Applied
      // row of a different opening was deleted.
      const numcoRows = deduped.split('\n').filter(l => l.includes('NumCo'));
      if (numcoRows.length === 2 && numcoRows.some(l => l.includes('Applied'))) {
        pass('dedup-tracker keeps different roles that share a stale duplicate tracker number');
      } else {
        fail(`dedup-tracker merged different roles across a duplicate tracker number: ${numcoRows.length} NumCo rows survive`);
      }
    }
  } finally {
    rmSync(dedupTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`shared role matcher / dedup safety tests crashed: ${e.message}`);
}

// ── DEDUP BLIND-VIA CHANNEL KEY: NON-LATIN AGENCIES (#2393) ──────────────
// Unknown-employer rows (Company `?`) group by their Via channel. dedup-tracker
// keyed that group with the file-local normalizeCompany(), which strips
// [^a-z0-9] — so リクルート and パーソル both keyed to '' and two genuinely
// separate agency submissions for one role landed in the same cluster, and the
// lower-scored row was DELETED. merge-tracker already compares Via with the
// Unicode-aware normalizeVia(); dedup must use the same key. A same-agency
// re-blast must still collapse, otherwise the fix would just be "never merge".
console.log('\n🧪 Testing dedup blind-via channel key with non-Latin agencies (#2393)...');
try {
  const viaDedupTmp = mkdtempSync(join(tmpdir(), 'career-ops-dedup-via-'));
  try {
    mkdirSync(join(viaDedupTmp, 'data'));
    const tracker = join(viaDedupTmp, 'data', 'applications.md');
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|-----|------|-------|--------|-----|--------|-------|\n' +
      // (a) Same role, unknown employer, two DIFFERENT non-Latin agencies —
      // two real submissions, both must survive.
      '| 61 | 2026-03-01 | ? | リクルート | Backend Engineer, Payments Platform | 4.0/5 | Evaluated | ❌ | [61](../reports/061-blind-a.md) | first agency |\n' +
      '| 62 | 2026-03-02 | ? | パーソル | Backend Engineer, Payments Platform | 4.1/5 | Evaluated | ❌ | [62](../reports/062-blind-b.md) | second agency |\n' +
      // (b) Symmetric case: a via-less blind row must not collide with a
      // non-Latin agency just because both used to key to ''.
      '| 63 | 2026-03-03 | ? | — | Frontend Engineer, Checkout | 3.8/5 | Evaluated | ❌ | [63](../reports/063-blind-c.md) | no agency named |\n' +
      '| 64 | 2026-03-04 | ? | リクルート | Frontend Engineer, Checkout | 4.2/5 | Evaluated | ❌ | [64](../reports/064-blind-d.md) | agency listing |\n' +
      // (c) Control: the SAME agency re-blasting one listing is a genuine
      // duplicate and must still collapse to the higher-scored row.
      '| 65 | 2026-03-05 | ? | Hays | Data Engineer, Warehouse | 3.5/5 | Evaluated | ❌ | [65](../reports/065-blind-e.md) | first sighting |\n' +
      '| 66 | 2026-03-06 | ? | Hays | Data Engineer, Warehouse | 4.4/5 | Evaluated | ❌ | [66](../reports/066-blind-f.md) | same agency re-blast |\n');

    const r = run(NODE, ['dedup-tracker.mjs'], { env: { ...process.env, CAREER_OPS_TRACKER: tracker } });
    if (r === null) {
      fail('dedup-tracker.mjs crashed during blind-via channel key test (#2393)');
    } else {
      const out = readFileSync(tracker, 'utf-8');

      const paymentsRows = out.split('\n').filter(l => l.includes('Backend Engineer, Payments Platform'));
      if (paymentsRows.length === 2
          && paymentsRows.some(l => l.includes('リクルート'))
          && paymentsRows.some(l => l.includes('パーソル'))) {
        pass('dedup-tracker keeps two blind rows submitted via different non-Latin agencies (#2393)');
      } else {
        fail(`dedup-tracker collapsed distinct non-Latin agency channels: ${paymentsRows.length} Payments Platform rows`);
      }

      const checkoutRows = out.split('\n').filter(l => l.includes('Frontend Engineer, Checkout'));
      if (checkoutRows.length === 2
          && checkoutRows.some(l => l.includes('リクルート'))
          && checkoutRows.some(l => l.includes('| — |'))) {
        pass('dedup-tracker keeps a via-less blind row separate from a non-Latin agency row (#2393)');
      } else {
        fail(`dedup-tracker collapsed a via-less blind row into an agency channel: ${checkoutRows.length} Checkout rows`);
      }

      const warehouseRows = out.split('\n').filter(l => l.includes('Data Engineer, Warehouse'));
      if (warehouseRows.length === 1 && warehouseRows[0].includes('4.4/5')) {
        pass('dedup-tracker still collapses a same-agency re-blast of one blind listing (#2393)');
      } else {
        fail(`dedup-tracker same-agency blind dedup broken: ${warehouseRows.length} Warehouse rows`);
      }
    }
  } finally {
    rmSync(viaDedupTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`dedup blind-via channel key tests crashed (#2393): ${e.message}`);
}

// ── DEDUP ORDINARY COMPANY KEY: NON-LATIN COMPANIES (#2429) ──
// The sibling of the blind-via case directly above, on the path that runs for
// every normal row. #2429 made tracker-utils.mjs's normalizeCompany
// Unicode-aware and merge-tracker/set-status inherited it, but dedup-tracker
// carried its own local [^a-z0-9] copy, so two DIFFERENT companies written in
// a non-Latin script both keyed to '' and one row was deleted outright.
// Controls: punctuation/spacing variants of one Latin employer must still
// merge, and two distinct Latin employers must still stay apart.
console.log('\n🧪 Testing dedup company key with non-Latin companies (#2429)...');
try {
  const coDedupTmp = mkdtempSync(join(tmpdir(), 'career-ops-dedup-company-'));
  try {
    mkdirSync(join(coDedupTmp, 'data'));
    const tracker = join(coDedupTmp, 'data', 'applications.md');
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|-----|------|-------|--------|-----|--------|-------|\n' +
      // (a) Two DIFFERENT non-Latin employers, same role — two real
      // applications, both must survive.
      '| 71 | 2026-04-01 | アクメ株式会社 | — | Backend Engineer | 4.2/5 | Evaluated | ❌ | [71](../reports/071-a.md) | first company |\n' +
      '| 72 | 2026-04-02 | グロベックス合同会社 | — | Backend Engineer | 3.0/5 | Evaluated | ❌ | [72](../reports/072-b.md) | different company |\n' +
      // (b) Control: presentation variants of ONE Latin employer still merge.
      '| 73 | 2026-04-03 | Acme (Inc.) | — | Data Engineer | 3.1/5 | Evaluated | ❌ | [73](../reports/073-c.md) | punctuated |\n' +
      '| 74 | 2026-04-04 | Acme Inc | — | Data Engineer | 4.5/5 | Evaluated | ❌ | [74](../reports/074-d.md) | same employer |\n' +
      // (c) Control: two distinct Latin employers still stay apart.
      '| 75 | 2026-04-05 | Globex | — | Platform Engineer | 3.9/5 | Evaluated | ❌ | [75](../reports/075-e.md) | one |\n' +
      '| 76 | 2026-04-06 | Initech | — | Platform Engineer | 4.0/5 | Evaluated | ❌ | [76](../reports/076-f.md) | another |\n');

    const r = run(NODE, ['dedup-tracker.mjs'], { env: { ...process.env, CAREER_OPS_TRACKER: tracker } });
    if (r === null) {
      fail('dedup-tracker.mjs crashed during non-Latin company key test (#2429)');
    } else {
      const out = readFileSync(tracker, 'utf-8');

      const backendRows = out.split('\n').filter(l => l.includes('Backend Engineer'));
      if (backendRows.length === 2
          && backendRows.some(l => l.includes('アクメ株式会社'))
          && backendRows.some(l => l.includes('グロベックス合同会社'))) {
        pass('dedup-tracker keeps two distinct non-Latin companies apart (#2429)');
      } else {
        fail(`dedup-tracker merged distinct non-Latin companies: ${backendRows.length} Backend Engineer rows`);
      }

      const dataRows = out.split('\n').filter(l => l.includes('Data Engineer'));
      if (dataRows.length === 1 && dataRows[0].includes('4.5/5')) {
        pass('dedup-tracker still merges punctuation variants of one Latin employer (#2429)');
      } else {
        fail(`dedup-tracker Latin punctuation merge broken: ${dataRows.length} Data Engineer rows`);
      }

      const platformRows = out.split('\n').filter(l => l.includes('Platform Engineer'));
      if (platformRows.length === 2) {
        pass('dedup-tracker still keeps two distinct Latin employers apart (#2429)');
      } else {
        fail(`dedup-tracker merged distinct Latin employers: ${platformRows.length} Platform Engineer rows`);
      }
    }
  } finally {
    rmSync(coDedupTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`dedup company key tests crashed (#2429): ${e.message}`);
}

// ── VERIFY-PIPELINE GROUPING KEYS: NON-LATIN COMPANIES AND ROLES (#2393) ──
// Same root cause as the blind-via key above, one layer up. verify-pipeline
// keyed Check 2 (duplicate tracker rows), Check 9 (duplicate report files) and
// Check 11 (Via channels) by stripping [^a-z0-9], which erases CJK outright.
// On a Japanese pipeline every company AND every role keyed to '', so unrelated
// rows were reported as one "possible duplicates" cluster and the real signal
// drowned — while Check 11 saw every non-Latin agency as 'direct' and never
// fired. Controls: genuine same-company+same-role pairs must still be flagged.
console.log('\n🧪 Testing verify-pipeline grouping keys with non-Latin text (#2393)...');
try {
  const vpKeyTmp = mkdtempSync(join(tmpdir(), 'career-ops-verify-unicode-'));
  try {
    const vpKeyReports = join(vpKeyTmp, 'reports');
    mkdirSync(vpKeyReports, { recursive: true });
    const vpKeyTracker = join(vpKeyTmp, 'applications.md');
    const vpKeyEnv = {
      ...process.env, CAREER_OPS_TRACKER: vpKeyTracker, CAREER_OPS_REPORTS: vpKeyReports,
    };
    const jaReport = (company, role) =>
      `# Evaluación: ${company} — ${role}\n\n## Machine Summary\n\n\`\`\`yaml\ncompany: "${company}"\nrole: "${role}"\nscore: 4.0\n\`\`\`\n`;

    // Two different roles at one non-Latin company: not duplicate reports.
    writeFileSync(join(vpKeyReports, '001-yamabuki-2026-01-04.md'), jaReport('株式会社ヤマブキ', 'データアナリスト'));
    writeFileSync(join(vpKeyReports, '002-yamabuki-2026-01-05.md'), jaReport('株式会社ヤマブキ', 'バックエンドエンジニア（アプリ基盤）'));
    // Control: the same non-Latin role twice must still be caught.
    writeFileSync(join(vpKeyReports, '003-kogane-2026-01-06.md'), jaReport('株式会社コガネ', 'プロダクトエンジニア'));
    writeFileSync(join(vpKeyReports, '004-kogane-2026-01-07.md'), jaReport('株式会社コガネ', 'プロダクトエンジニア'));

    writeFileSync(vpKeyTracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|-----|------|-------|--------|-----|--------|-------|\n' +
      // (a) Different non-Latin companies AND different non-Latin roles.
      '| 1 | 2026-01-04 | 株式会社アカネ | — | バックエンドエンジニア（自社サービス「配膳便」） | 4.1/5 | Evaluated | ❌ | [1](reports/001-yamabuki-2026-01-04.md) | ok |\n' +
      '| 2 | 2026-01-05 | 株式会社コガネ | — | プロダクトエンジニア（サーバサイド/フロントエンド両面） | 4.1/5 | Evaluated | ❌ | [2](reports/002-yamabuki-2026-01-05.md) | ok |\n' +
      // (b) One company, two genuinely different non-Latin roles.
      '| 3 | 2026-01-06 | 株式会社ヤマブキ | — | データアナリスト | 3.2/5 | Evaluated | ❌ | [3](reports/003-kogane-2026-01-06.md) | ok |\n' +
      '| 4 | 2026-01-07 | 株式会社ヤマブキ | — | バックエンドエンジニア（アプリ基盤） | 4.4/5 | Evaluated | ❌ | [4](reports/004-kogane-2026-01-07.md) | ok |\n' +
      // (c) Control: identical non-Latin company+role is a real duplicate.
      '| 5 | 2026-01-08 | 株式会社ミドリ | — | フルスタックエンジニア | 4.3/5 | Evaluated | ❌ | — | first |\n' +
      '| 6 | 2026-01-09 | 株式会社ミドリ | — | フルスタックエンジニア | 4.3/5 | Evaluated | ❌ | — | second |\n' +
      // (d) Check 11: one role reached through two non-Latin agencies.
      '| 7 | 2026-01-10 | 株式会社アオゾラ | リクルート | 会計プロダクトエンジニア | 4.0/5 | Applied | ❌ | — | via A |\n' +
      '| 8 | 2026-01-11 | 株式会社アオゾラ | パーソル | 会計プロダクトエンジニア | 4.0/5 | Applied | ❌ | — | via B |\n' +
      // (e) Combining marks: Devanagari matras carry meaning and have no
      // precomposed form, so NFKC cannot fold them into the base letter.
      // Dropping \p{M} would key कंपनी and कपनी identically — the same
      // collision as (a), one script over, and modes/hi ships a Hindi market.
      '| 9 | 2026-01-12 | कंपनी सॉफ्टवेयर | — | बैकएंड इंजीनियर | 4.0/5 | Evaluated | ❌ | — | with matras |\n' +
      '| 10 | 2026-01-13 | कपनी सफटवयर | — | बकएड इजीनियर | 4.0/5 | Evaluated | ❌ | — | matras stripped |\n');

    const vpKeyOut = run(NODE, ['verify-pipeline.mjs'], { env: vpKeyEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    if (vpKeyOut === null) {
      fail('verify-pipeline crashed on non-Latin grouping fixture (#2393)');
    } else {
      const dupLines = vpKeyOut.split('\n').filter(l => l.includes('Possible duplicates'));

      if (!dupLines.some(l => /#1\b/.test(l) && /#2\b/.test(l))) {
        pass('verify-pipeline keeps distinct non-Latin companies apart (#2393)');
      } else {
        fail(`verify-pipeline clustered unrelated non-Latin companies: ${dupLines.join(' | ')}`);
      }

      if (!dupLines.some(l => /#3\b/.test(l) && /#4\b/.test(l))) {
        pass('verify-pipeline keeps distinct non-Latin roles at one company apart (#2393)');
      } else {
        fail(`verify-pipeline clustered distinct non-Latin roles: ${dupLines.join(' | ')}`);
      }

      if (dupLines.some(l => /#5\b/.test(l) && /#6\b/.test(l))) {
        pass('verify-pipeline still flags a genuine non-Latin duplicate row pair (#2393)');
      } else {
        fail('verify-pipeline missed a genuine duplicate with identical non-Latin company+role');
      }

      const dupReportLines = vpKeyOut.split('\n').filter(l => l.includes('Duplicate reports for same company+role'));
      if (!dupReportLines.some(l => l.includes('001-yamabuki') && l.includes('002-yamabuki'))) {
        pass('verify-pipeline keeps two non-Latin roles under one company slug apart (#2393)');
      } else {
        fail(`verify-pipeline clustered distinct non-Latin report roles: ${dupReportLines.join(' | ')}`);
      }
      if (dupReportLines.some(l => l.includes('003-kogane') && l.includes('004-kogane'))) {
        pass('verify-pipeline still flags two reports for one non-Latin company+role (#2393)');
      } else {
        fail('verify-pipeline missed a genuine duplicate report pair with a non-Latin role');
      }

      if (!dupLines.some(l => /#9\b/.test(l) && /#10\b/.test(l))) {
        pass('verify-pipeline keeps Devanagari names differing only by combining marks apart');
      } else {
        fail(`verify-pipeline collapsed Devanagari names that differ by matras: ${dupLines.join(' | ')}`);
      }
    }
  } finally {
    rmSync(vpKeyTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`verify-pipeline non-Latin grouping key tests crashed (#2393): ${e.message}`);
}

// dedup-tracker / normalize-statuses rebuilt promoted rows with
// `parts.slice(1, -1)`, which assumes the closing `|` produced a trailing empty
// cell. A valid row written WITHOUT a trailing pipe keeps its real last cell
// (the notes) at the end, so the old reconstruction silently dropped the notes
// when promoting a keeper's status during dedup. rebuildRow() now preserves it.
console.log('\n🧪 Testing dedup row rebuild preserves notes on no-trailing-pipe rows...');
try {
  const rebuildTmp = mkdtempSync(join(tmpdir(), 'career-ops-rebuild-'));
  try {
    mkdirSync(join(rebuildTmp, 'data'));
    const tracker = join(rebuildTmp, 'data', 'applications.md');
    // Keeper row #50 has the higher score AND no trailing pipe; dup #51 carries a
    // more-advanced status (both below Applied, so the advanced-status safety
    // guard doesn't block the collapse), so dedup promotes #50's status and
    // rewrites the row — exercising rebuildRow() on a no-trailing-pipe row.
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 50 | 2026-02-01 | Globex | Widget Engineer | 4.5/5 | Rejected | ❌ | [50](../reports/050-widget.md) | KEEPER_NOTE_SENTINEL\n' +
      '| 51 | 2026-02-02 | Globex | Widget Engineer | 3.0/5 | Evaluated | ❌ | [51](../reports/051-widget.md) | dup row |\n');

    const r = run(NODE, ['dedup-tracker.mjs'], { env: { ...process.env, CAREER_OPS_TRACKER: tracker } });
    if (r === null) {
      fail('dedup-tracker.mjs crashed during notes-preservation test');
    } else {
      const out = readFileSync(tracker, 'utf-8');
      const keeperRow = out.split('\n').find(l => l.includes('| 50 |'));
      if (keeperRow && keeperRow.includes('KEEPER_NOTE_SENTINEL') && keeperRow.includes('Evaluated')) {
        pass('dedup row rebuild preserves the notes column on rows without a trailing pipe');
      } else {
        fail(`dedup row rebuild dropped notes / status on no-trailing-pipe row: "${keeperRow}"`);
      }
    }
  } finally {
    rmSync(rebuildTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`dedup row-rebuild notes test crashed: ${e.message}`);
}

// rebuildRow() is now shared from tracker-utils.mjs (extracted from the two
// copies introduced in #1004). Unit-test the helper contract directly.
console.log('\n🧪 Testing shared tracker-utils rebuildRow()...');
try {
  const { rebuildRow } = await import(pathToFileURL(join(ROOT, 'tracker-utils.mjs')).href);
  const cellsOf = (line) => line.split('|').map(s => s.trim());

  // Trailing-pipe row → unchanged round-trip.
  const withPipe = '| 5 | 2026-02-01 | Acme | Eng | 4.0/5 | Applied | ❌ | [5](r.md) | note |';
  if (rebuildRow(cellsOf(withPipe)) === withPipe) {
    pass('rebuildRow round-trips a row that already has a trailing pipe');
  } else {
    fail(`rebuildRow changed a trailing-pipe row: "${rebuildRow(cellsOf(withPipe))}"`);
  }

  // No-trailing-pipe row → last cell (notes) preserved, trailing pipe added.
  const noPipe = '| 5 | 2026-02-01 | Acme | Eng | 4.0/5 | Applied | ❌ | [5](r.md) | keepme';
  const rebuilt = rebuildRow(cellsOf(noPipe));
  if (rebuilt.includes('keepme') && rebuilt.endsWith('|')) {
    pass('rebuildRow preserves the notes cell on a row without a trailing pipe');
  } else {
    fail(`rebuildRow dropped notes on no-trailing-pipe row: "${rebuilt}"`);
  }

  // Extra column (e.g. a custom Location) → every cell preserved.
  const extra = '| 5 | 2026-02-01 | Acme | Eng | Berlin | 4.0/5 | Applied | ❌ | [5](r.md) | note |';
  const rebuiltExtra = rebuildRow(cellsOf(extra));
  if (rebuiltExtra === extra && rebuiltExtra.includes('Berlin')) {
    pass('rebuildRow preserves extra columns (custom Location)');
  } else {
    fail(`rebuildRow mangled an extra-column row: "${rebuiltExtra}"`);
  }
} catch (e) {
  fail(`tracker-utils rebuildRow unit test crashed: ${e.message}`);
}

// #946/#954 header-name column mapping lived only in merge-tracker; followup-cadence,
// analyze-patterns and dedup-tracker still parsed by fixed index, so an inserted
// Location column mis-parsed (Location read as Score, etc.). The logic is now shared
// in tracker-parse.mjs and all four readers use it.
console.log('\n🧪 Testing shared tracker-parse column mapping...');
try {
  const { resolveColumns, parseTrackerRow, LEGACY_COLMAP } = await import(pathToFileURL(join(ROOT, 'tracker-parse.mjs')).href);

  const withLocation = [
    '| # | Date | Company | Role | Location | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|----------|-------|--------|-----|--------|-------|',
    '| 7 | 2026-06-28 | Acme | Eng | Berlin | 4.5/5 | Applied | ✅ | [7](r.md) | keep |',
  ];
  const cmLoc = resolveColumns(withLocation);
  const rowLoc = parseTrackerRow(withLocation[2], cmLoc);
  if (rowLoc && rowLoc.score === '4.5/5' && rowLoc.status === 'Applied' && rowLoc.location === 'Berlin') {
    pass('tracker-parse maps columns by header — inserted Location column does not shift Score/Status');
  } else {
    fail(`tracker-parse mis-parsed a Location-column row: ${JSON.stringify(rowLoc)}`);
  }

  const legacy = [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 8 | 2026-06-28 | Beta | PM | 3.0/5 | Evaluated | ❌ | [8](r.md) | n |',
  ];
  const rowLeg = parseTrackerRow(legacy[2], resolveColumns(legacy));
  if (rowLeg && rowLeg.score === '3.0/5' && rowLeg.status === 'Evaluated' && rowLeg.location === undefined) {
    pass('tracker-parse still parses the legacy fixed layout correctly');
  } else {
    fail(`tracker-parse broke the legacy layout: ${JSON.stringify(rowLeg)}`);
  }

  // No header row → falls back to legacy map; header/separator/stray rows → null.
  if (resolveColumns(['| 9 | … |']) === LEGACY_COLMAP &&
      parseTrackerRow(legacy[0], LEGACY_COLMAP) === null &&
      parseTrackerRow(legacy[1], LEGACY_COLMAP) === null &&
      parseTrackerRow('not a table row', LEGACY_COLMAP) === null) {
    pass('tracker-parse falls back to legacy map and rejects header/separator/non-rows');
  } else {
    fail('tracker-parse fallback / non-row rejection wrong');
  }
} catch (e) {
  fail(`tracker-parse unit test crashed: ${e.message}`);
}

// #1431 "Apply to #13" is ambiguous: report numbers and tracker row numbers
// diverge, and mapping company ↔ report# ↔ tracker# ↔ PDF used to require
// opening three files. find.mjs resolves a report#, tracker#, or company/role
// fragment to the full pipeline identity in one read-only lookup.
console.log('\n🧪 Testing find.mjs pipeline identity lookup...');
try {
  const { parseTrackerRows, parsePdfIndex, findMatches } = await import(pathToFileURL(join(ROOT, 'find.mjs')).href);

  // Tracker# and report# intentionally diverge: row 3 carries report 12, and a
  // different row is numbered 12 — the exact friction the tool exists to solve.
  const rows = parseTrackerRows([
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 3 | 2026-06-01 | Acme Labs | Platform Engineer | 4.2/5 | **Applied** (2026-06-02) | ✅ | [12](reports/012-acme-labs-2026-06-01.md) | strong fit |',
    '| 12 | 2026-06-10 | Globex | Data Engineer | 3.8/5 | Evaluated | ❌ | [15](reports/015-globex-2026-06-10.md) | — |',
  ].join('\n'));
  const pdfIndex = parsePdfIndex(
    '# report\tpdf\thtml\tformat\tdate — written by generate-pdf.mjs, do not edit\n' +
    '012\toutput/cv-acme-labs.pdf\toutput/cv-acme-labs.html\tats\t2026-06-01\n');

  const byTracker = findMatches(rows, '3', pdfIndex);
  if (byTracker.length === 1 && byTracker[0].company === 'Acme Labs' &&
      byTracker[0].trackerNum === 3 && byTracker[0].reportNum === '12' &&
      byTracker[0].reportPath === 'reports/012-acme-labs-2026-06-01.md' &&
      byTracker[0].status === 'Applied' &&
      byTracker[0].pdfPath === 'output/cv-acme-labs.pdf') {
    pass('find.mjs resolves a tracker# to company, report#, canonical status, and PDF path');
  } else {
    fail(`find.mjs tracker# lookup wrong: ${JSON.stringify(byTracker)}`);
  }

  // "12" is both Acme's report# and Globex's tracker# — both rows must surface
  // (with the zero-padded "012" report-link form treated as the same number).
  const ambiguous = findMatches(rows, '012', pdfIndex);
  const companies = ambiguous.map(m => m.company).sort();
  if (ambiguous.length === 2 && companies[0] === 'Acme Labs' && companies[1] === 'Globex') {
    pass('find.mjs surfaces report#/tracker# collisions as multiple matches (zero-pad normalized)');
  } else {
    fail(`find.mjs numeric collision lookup wrong: ${JSON.stringify(ambiguous)}`);
  }

  const byFragment = findMatches(rows, 'acme', pdfIndex);
  if (byFragment.length === 1 && byFragment[0].company === 'Acme Labs') {
    pass('find.mjs matches a case-insensitive company fragment');
  } else {
    fail(`find.mjs company fragment lookup wrong: ${JSON.stringify(byFragment)}`);
  }

  // Fuzzy multi-word lookup reuses role-matcher.mjs (stopwords like "remote"
  // dropped) instead of reinventing matching.
  const byFuzzy = findMatches(rows, 'remote data engineer', pdfIndex);
  if (byFuzzy.length === 1 && byFuzzy[0].company === 'Globex' && byFuzzy[0].pdfPath === null) {
    pass('find.mjs fuzzy-matches a role phrase via role-matcher and reports a missing PDF');
  } else {
    fail(`find.mjs fuzzy role lookup wrong: ${JSON.stringify(byFuzzy)}`);
  }

  if (findMatches(rows, 'no-such-company', pdfIndex).length === 0) {
    pass('find.mjs returns zero matches cleanly for an unknown query');
  } else {
    fail('find.mjs matched a query that exists nowhere in the tracker');
  }
} catch (e) {
  fail(`find.mjs unit test crashed: ${e.message}`);
}

// dedup-tracker reads AND writes by column; with a Location column its status
// promotion must target the Status cell, not fixed parts[6].
console.log('\n🧪 Testing dedup-tracker with an inserted Location column...');
try {
  const locTmp = mkdtempSync(join(tmpdir(), 'career-ops-dedup-loc-'));
  try {
    mkdirSync(join(locTmp, 'data'));
    const tracker = join(locTmp, 'data', 'applications.md');
    // Two dup rows (same company+role) with a Location column. Keeper #60 has the
    // higher score but the lower status; dedup must promote its Status cell.
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Location | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|----------|-------|--------|-----|--------|-------|\n' +
      '| 60 | 2026-02-01 | Globex | Widget Engineer | Berlin | 4.5/5 | Rejected | ❌ | [60](r.md) | LOC_SENTINEL |\n' +
      '| 61 | 2026-02-02 | Globex | Widget Engineer | Berlin | 3.0/5 | Evaluated | ❌ | [61](r.md) | dup |\n');

    const r = run(NODE, ['dedup-tracker.mjs'], { env: { ...process.env, CAREER_OPS_TRACKER: tracker } });
    if (r === null) {
      fail('dedup-tracker crashed on a Location-column tracker');
    } else {
      const out = readFileSync(tracker, 'utf-8');
      const keeper = out.split('\n').find(l => l.includes('| 60 |'));
      // Status cell promoted to Evaluated; Location (Berlin) and the score untouched.
      if (keeper && keeper.includes('Berlin') && keeper.includes('4.5/5') && keeper.includes('Evaluated') && keeper.includes('LOC_SENTINEL')) {
        pass('dedup-tracker promotes the Status cell (not a fixed index) on a Location-column tracker');
      } else {
        fail(`dedup-tracker mis-handled a Location-column row: "${keeper}"`);
      }
    }
  } finally {
    rmSync(locTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`dedup-tracker Location-column test crashed: ${e.message}`);
}

// ── MERGE-TRACKER FUZZY DEDUP (#751 / #721 family) ──────────────
// roleFuzzyMatch over-matched whenever the token overlap dominated the
// SMALLER side: two distinct roles sharing a long prefix ("Full-Stack
// Engineer 5, AI Insights & Visualizations" vs "Full Stack Engineer 5, Ads
// Reporting") or a brand token (#751: "UberEats Feed" vs "Consumer
// Fulfillment (UberEats)") collapsed onto one tracker row — silently
// dropping evaluations. The ratio now divides by the token UNION (true
// Jaccard): genuine reposts (identical token sets) still score 1.0, while
// distinct specialties fall below the 0.6 threshold.
console.log('\n🧪 Testing merge-tracker fuzzy dedup (distinct roles vs reposts)...');
try {
  const mergeTmp = mkdtempSync(join(tmpdir(), 'career-ops-merge-'));
  try {
    mkdirSync(join(mergeTmp, 'data'));
    mkdirSync(join(mergeTmp, 'reports'));
    const additionsDir = join(mergeTmp, 'additions');
    mkdirSync(additionsDir);
    const tracker = join(mergeTmp, 'data', 'applications.md');
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 1 | 2026-01-04 | StreamCo | Full Stack Engineer 5, Ads Reporting | 4.4/5 | Evaluated | ❌ | [1](../reports/001-streamco-2026-01-04.md) | existing |\n' +
      '| 2 | 2026-01-04 | Uber | Senior Software Engineer, Consumer Fulfillment (UberEats) | 4.2/5 | Evaluated | ❌ | [2](../reports/002-uber-2026-01-04.md) | existing |\n');
    for (const n of ['001-streamco-2026-01-04', '002-uber-2026-01-04', '003-streamco-2026-01-05', '004-uber-2026-01-05', '005-streamco-2026-01-06']) {
      writeFileSync(join(mergeTmp, 'reports', `${n}.md`), '# fixture\n');
    }
    // Two DISTINCT roles (long shared prefix / shared brand token) + one true repost (score bump).
    writeFileSync(join(additionsDir, '003-streamco.tsv'),
      '3\t2026-01-05\tStreamCo\tFull-Stack Engineer 5, AI Insights & Visualizations\tEvaluated\t4.6/5\t❌\t[3](reports/003-streamco-2026-01-05.md)\tdistinct role\n');
    writeFileSync(join(additionsDir, '004-uber.tsv'),
      '4\t2026-01-05\tUber\tSenior Software Engineer, UberEats Feed\tEvaluated\t4.1/5\t❌\t[4](reports/004-uber-2026-01-05.md)\tdistinct team (#751)\n');
    writeFileSync(join(additionsDir, '005-streamco.tsv'),
      '5\t2026-01-06\tStreamCo\tFull Stack Engineer 5, Ads Reporting\tEvaluated\t4.5/5\t❌\t[5](reports/005-streamco-2026-01-06.md)\trepost\n');

    const mergeResult = run(NODE, ['merge-tracker.mjs'], { env: { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_ADDITIONS: additionsDir } });
    if (mergeResult === null) {
      fail('merge-tracker.mjs crashed during fuzzy dedup regression test');
    } else {
      const merged = readFileSync(tracker, 'utf-8');

      // Distinct role sharing a long prefix must be ADDED, not folded into the existing row.
      if (merged.includes('AI Insights & Visualizations') && merged.includes('Ads Reporting')) {
        pass('distinct roles with shared prefix kept as separate rows');
      } else {
        fail('distinct role with shared prefix was merged away (silent data loss)');
      }

      // #751 repro: different teams under one brand token must both survive.
      if (merged.includes('UberEats Feed') && merged.includes('Consumer Fulfillment')) {
        pass('brand-token roles (#751: UberEats Feed vs Consumer Fulfillment) kept separate');
      } else {
        fail('brand-token roles were deduped (#751 regression)');
      }

      // True repost (identical role tokens) must still UPDATE in place — exactly one row, score bumped.
      const adsRows = merged.split('\n').filter(l => l.includes('Ads Reporting'));
      if (adsRows.length === 1 && adsRows[0].includes('4.5/5')) {
        pass('true repost still updates the existing row in place (4.4 → 4.5, no duplicate)');
      } else {
        fail(`repost handling broken: ${adsRows.length} 'Ads Reporting' rows, expected 1 updated to 4.5/5`);
      }
    }
  } finally {
    rmSync(mergeTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`merge-tracker fuzzy dedup tests crashed: ${e.message}`);
}

// merge-tracker used to clobber an Applied row when a sibling req's only
// distinguishing qualifier was a slashed acronym: "(CI/CD)" tokenized to
// nothing, the fuzzy tier matched, and the update path rewrote the existing
// row's title/score/date/report. Two guards now cover it: slashed acronyms
// survive tokenization, and non-report-number matches never rewrite the title.
console.log('\n🧪 Testing merge-tracker sibling-req clobber guard (slash acronyms + title preservation)...');
try {
  const clobberTmp = mkdtempSync(join(tmpdir(), 'career-ops-clobber-'));
  try {
    mkdirSync(join(clobberTmp, 'data'));
    mkdirSync(join(clobberTmp, 'reports'));
    const additionsDir = join(clobberTmp, 'additions');
    mkdirSync(additionsDir);
    const tracker = join(clobberTmp, 'data', 'applications.md');
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 1 | 2026-01-05 | Globex | Senior Software Engineer, Infrastructure | N/A | Applied | ❌ | - | source=applied |\n' +
      '| 2 | 2026-01-08 | Acme | Senior Platform Engineer, Observability | 3.9/5 | Applied | ❌ | [2](../reports/002-acme-2026-01-08.md) | existing |\n');
    for (const n of ['002-acme-2026-01-08', '003-globex-2026-01-09', '004-acme-2026-01-09']) {
      writeFileSync(join(clobberTmp, 'reports', `${n}.md`), '# fixture\n');
    }
    // Sibling req whose only qualifier is a slashed acronym → must be ADDED.
    writeFileSync(join(additionsDir, '003-globex.tsv'),
      '3\t2026-01-09\tGlobex\tSenior Software Engineer, Infrastructure (CI/CD)\tEvaluated\t4.5/5\t✅\t[3](reports/003-globex-2026-01-09.md)\tdistinct req\n');
    // True repost with reworded title → fuzzy update keeps the EXISTING title.
    writeFileSync(join(additionsDir, '004-acme.tsv'),
      '4\t2026-01-09\tAcme\tSr Platform Engineer, Observability (Remote)\tEvaluated\t4.2/5\t❌\t[4](reports/004-acme-2026-01-09.md)\trepost re-eval\n');

    const clobberResult = run(NODE, ['merge-tracker.mjs'], { env: { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_ADDITIONS: additionsDir } });
    if (clobberResult === null) {
      fail('merge-tracker.mjs crashed during sibling-req clobber guard test');
    } else {
      const merged = readFileSync(tracker, 'utf-8');

      if (merged.includes('Senior Software Engineer, Infrastructure |') && merged.includes('Infrastructure (CI/CD)')) {
        pass('slash-acronym sibling req added as its own row; Applied row untouched');
      } else {
        fail('slash-acronym sibling req clobbered the existing Applied row (regression)');
      }

      const acmeRows = merged.split('\n').filter(l => l.includes('Observability'));
      if (acmeRows.length === 1 && acmeRows[0].includes('Senior Platform Engineer, Observability') && acmeRows[0].includes('4.2/5')) {
        pass('fuzzy-tier update bumps score but preserves the existing role title');
      } else {
        fail(`fuzzy-tier title preservation broken: ${acmeRows.length} Observability rows: ${acmeRows.join(' // ')}`);
      }
    }
  } finally {
    rmSync(clobberTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`merge-tracker sibling-req clobber guard tests crashed: ${e.message}`);
}

// Tier-2 (entry num + company): pins the TITLE FIELD ONLY (#2166 review).
//
// The title-preservation guard keys on reportNumMatched, which only tier-1
// (report number + company) sets — so tier-2 preserves the existing title too.
// That is intentional: tier-2 fires only AFTER tier-1 failed, i.e. the addition
// carries a report link that did NOT match the row's while the bare num did.
// Report-file numbering and tracker-row numbering drift independently, so a
// tier-2 hit is "these two numbers coincide at this company" — a coincidence,
// not an expressed intent to retitle. Since date/score/report/notes are all
// overwritten unconditionally on the update path, the title is the only field
// left carrying the evidence that two reqs were distinct. This test exists so a
// future refactor cannot flip that behavior silently.
//
// SCOPE — read before extending this test. The fixture below is a deliberately
// pathological isolation case, and the row it produces is internally
// inconsistent: the preserved title describes one req while the overwritten
// report link points at another req's evaluation. That inconsistency is
// PRE-EXISTING tier-2 behavior, not something this change introduces — before
// the guard, the same collision overwrote the title as well, which loses
// strictly more information (the tracker no longer records that the original
// req was ever applied to). This test therefore asserts ONLY that the title
// survives; it does NOT endorse the rest of the merged row as correct. The
// underlying question — whether an uncorroborated num+company collision should
// update in place at all, versus adding the row or surfacing a conflict — is a
// tier-2 redesign, deliberately out of scope for this #2165 bugfix.
console.log('\n🧪 Testing merge-tracker tier-2 (entry num) title preservation...');
try {
  const { roleFuzzyMatch } = await import(pathToFileURL(join(ROOT, 'role-matcher.mjs')).href);
  const tier2Tmp = mkdtempSync(join(tmpdir(), 'career-ops-tier2-'));
  try {
    mkdirSync(join(tier2Tmp, 'data'));
    mkdirSync(join(tier2Tmp, 'reports'));
    const additionsDir = join(tier2Tmp, 'additions');
    mkdirSync(additionsDir);
    const tracker = join(tier2Tmp, 'data', 'applications.md');
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 7 | 2026-02-01 | Initech | Staff Data Engineer, Batch Pipelines | 3.6/5 | Applied | ❌ | [21](../reports/021-initech-2026-02-01.md) | existing |\n');
    for (const n of ['021-initech-2026-02-01', '022-initech-2026-02-02']) {
      writeFileSync(join(tier2Tmp, 'reports', `${n}.md`), '# fixture\n');
    }
    // num 7 collides with the existing row at the same company, but the report
    // link (22) does not match the row's (21) — so tier-1 misses and tier-2 is
    // the only tier that can match: the roles are far too different to fuzzy
    // match, which is what isolates tier-2 here.
    writeFileSync(join(additionsDir, '007-initech.tsv'),
      '7\t2026-02-02\tInitech\tTechnical Program Manager, Compliance\tEvaluated\t4.4/5\t❌\t[22](reports/022-initech-2026-02-02.md)\tnum collision, distinct role\n');

    // The isolation above is load-bearing: if these two titles ever DID fuzzy
    // match, tier-3 could satisfy the assertions below and this would silently
    // stop testing tier-2. Assert the premise rather than assuming it.
    if (!roleFuzzyMatch('Staff Data Engineer, Batch Pipelines', 'Technical Program Manager, Compliance')) {
      pass('tier-2 fixture roles do not fuzzy-match, so tier-2 is the only tier that can fire');
    } else {
      fail('tier-2 fixture roles now fuzzy-match — this test no longer isolates tier-2');
    }

    const tier2Result = run(NODE, ['merge-tracker.mjs'], { env: { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_ADDITIONS: additionsDir } });
    if (tier2Result === null) {
      fail('merge-tracker.mjs crashed during tier-2 title preservation test');
    } else {
      const merged = readFileSync(tracker, 'utf-8');
      const initechRows = merged.split('\n').filter(l => l.includes('Initech'));

      // Characterization only — this pins that the update path RAN (one row,
      // not two, and the score moved), which is what makes the title assertion
      // below non-vacuous. It is not a claim that in-place update is the right
      // outcome for an uncorroborated tier-2 collision; see SCOPE above.
      if (initechRows.length === 1 && initechRows[0].includes('4.4/5')) {
        pass('tier-2 collision takes the in-place update path (pre-existing behavior)');
      } else {
        fail(`tier-2 match/update broken: ${initechRows.length} Initech rows: ${initechRows.join(' // ')}`);
      }

      if (initechRows.length === 1
          && initechRows[0].includes('Staff Data Engineer, Batch Pipelines')
          && !initechRows[0].includes('Technical Program Manager')) {
        pass('tier-2 update preserves the existing role title (only tier-1 may retitle)');
      } else {
        fail(`tier-2 title preservation broken: ${initechRows.join(' // ')}`);
      }
    }
  } finally {
    rmSync(tier2Tmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`merge-tracker tier-2 title preservation tests crashed: ${e.message}`);
}

// ── MERGE-TRACKER CROSS-CHANNEL VIA GUARD: NON-LATIN AGENCIES (#1603) ─────
// normalizeCompany() strips [^a-z0-9], so two different non-Latin agency
// names both collapse to '' and the #1596 cross-channel guard treated them
// as the same channel — silently merging two real submissions. The via
// comparison must use a Unicode-aware key.
console.log('\n🧪 Testing merge-tracker via guard with non-Latin agencies (#1603)...');
try {
  const viaTmp = mkdtempSync(join(tmpdir(), 'career-ops-via-'));
  try {
    mkdirSync(join(viaTmp, 'data'));
    mkdirSync(join(viaTmp, 'reports'));
    const additionsDir = join(viaTmp, 'additions');
    mkdirSync(additionsDir);
    const tracker = join(viaTmp, 'data', 'applications.md');
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|-----|------|-------|--------|-----|--------|-------|\n' +
      '| 1 | 2026-01-04 | ? | リクルート | Backend Engineer, Payments Platform | 4.0/5 | Evaluated | ❌ | [1](../reports/001-unknown-2026-01-04.md) | agency listing |\n');
    for (const n of ['001-unknown-2026-01-04', '002-unknown-2026-01-05', '003-unknown-2026-01-06']) {
      writeFileSync(join(viaTmp, 'reports', `${n}.md`), '# fixture\n');
    }
    // Same role, unknown employer, DIFFERENT non-Latin agency → a real second
    // submission that must be ADDED as its own row. (Role carries a
    // discriminating token — roleFuzzyMatch rejects baseline-only titles.)
    writeFileSync(join(additionsDir, '002-unknown.tsv'),
      '2\t2026-01-05\t?\tBackend Engineer, Payments Platform\tEvaluated\t4.1/5\t❌\t[2](reports/002-unknown-2026-01-05.md)\tsecond agency\tvia=パーソル\n');
    // Same role, SAME agency re-blasting the listing → duplicate, update in place.
    writeFileSync(join(additionsDir, '003-unknown.tsv'),
      '3\t2026-01-06\t?\tBackend Engineer, Payments Platform\tEvaluated\t4.2/5\t❌\t[3](reports/003-unknown-2026-01-06.md)\tre-blast\tvia=リクルート\n');

    const viaResult = run(NODE, ['merge-tracker.mjs'], { env: { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_ADDITIONS: additionsDir } });
    if (viaResult === null) {
      fail('merge-tracker.mjs crashed during non-Latin via guard test (#1603)');
    } else {
      const merged = readFileSync(tracker, 'utf-8');
      if (merged.includes('パーソル') && merged.includes('リクルート')) {
        pass('distinct non-Latin agencies kept as separate rows (#1603)');
      } else {
        fail('distinct non-Latin agencies were merged — via key collapsed to the same empty string (#1603)');
      }
      const recruitRows = merged.split('\n').filter(l => l.includes('リクルート'));
      if (recruitRows.length === 1 && recruitRows[0].includes('4.2/5')) {
        pass('same-agency re-blast still updates the existing row in place (#1603)');
      } else {
        fail(`same-agency re-blast handling broken: ${recruitRows.length} リクルート rows, expected 1 updated to 4.2/5`);
      }
    }
  } finally {
    rmSync(viaTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`non-Latin via guard tests crashed: ${e.message}`);
}

// ── ROLE TITLES IN NON-LATIN SCRIPTS (#2781) ──────────────────────
// roleTokens ran an [a-z0-9\s] strip, so every non-Latin role title tokenized
// to []. merge-tracker's dedup then never matched two spellings of the SAME
// role at the same company, and a re-evaluation was appended as a duplicate row
// instead of updating the existing one — while the Latin equivalent merged
// cleanly. normalizeTitle also stripped every \p{Mn}, folding Devanagari
// matras, Cyrillic breve and Japanese dakuten onto their bases.
console.log('\n🧪 Testing role tokenization across scripts (#2781)...');
try {
  const { roleTokens, roleFuzzyMatch } = await import(pathToFileURL(join(ROOT, 'role-matcher.mjs')).href);

  const empty = ['\u0411\u044D\u043A\u0435\u043D\u0434-\u0440\u0430\u0437\u0440\u0430\u0431\u043E\u0442\u0447\u0438\u043A', '\u0938\u0949\u092B\u094D\u091F\u0935\u0947\u092F\u0930 \u0907\u0902\u091C\u0940\u0928\u093F\u092F\u0930'].filter((t) => roleTokens(t).length === 0);
  empty.length === 0
    ? pass('space-separated non-Latin role titles produce tokens (#2781)')
    : fail(`role titles still tokenize to nothing: ${empty.join(', ')}`);

  const samePairs = [
    ['Backend Engineer, Payments', 'Backend Engineer (Payments)'],
    ['\u0411\u044D\u043A\u0435\u043D\u0434-\u0440\u0430\u0437\u0440\u0430\u0431\u043E\u0442\u0447\u0438\u043A, \u043F\u043B\u0430\u0442\u0435\u0436\u0438', '\u0411\u044D\u043A\u0435\u043D\u0434-\u0440\u0430\u0437\u0440\u0430\u0431\u043E\u0442\u0447\u0438\u043A (\u043F\u043B\u0430\u0442\u0435\u0436\u0438)'],
  ];
  const notMatched = samePairs.filter(([a, b]) => !roleFuzzyMatch(a, b));
  notMatched.length === 0
    ? pass('the same role written with different punctuation matches in every script (#2781)')
    : fail(`same-role pairs did not match: ${notMatched.map(([a]) => a).join('; ')}`);

  const diffPairs = [
    ['Backend Engineer', 'Data Scientist'],
    ['\u0411\u044D\u043A\u0435\u043D\u0434-\u0440\u0430\u0437\u0440\u0430\u0431\u043E\u0442\u0447\u0438\u043A', '\u0410\u043D\u0430\u043B\u0438\u0442\u0438\u043A \u0434\u0430\u043D\u043D\u044B\u0445'],
  ];
  const wronglyMatched = diffPairs.filter(([a, b]) => roleFuzzyMatch(a, b));
  wronglyMatched.length === 0
    ? pass('different roles stay distinct in every script (#2781)')
    : fail(`widening merged different roles: ${wronglyMatched.map(([a, b]) => `${a}/${b}`).join('; ')}`);

  // Marks that carry meaning survive; Latin accent-folding is unchanged (#2209).
  const marks = [
    ['\u0915\u0902\u092A\u0928\u0940', '\u0915\u092A\u0928\u0940', false, 'Devanagari matra'],
    ['\u0419\u043E\u0433\u0443\u0440\u0442', '\u0418\u043E\u0433\u0443\u0440\u0442', false, 'Cyrillic breve'],
    ['S\u00EAnior Backend Engineer', 'Senior Backend Engineer', true, 'Latin accent folding (#2209)'],
  ];
  const markWrong = marks.filter(([a, b, must]) => (roleTokens(a).join(' ') === roleTokens(b).join(' ')) !== must);
  markWrong.length === 0
    ? pass('meaningful marks survive while Latin accents still fold (#2781)')
    : fail(`mark handling wrong: ${markWrong.map(([a, b, m, why]) => `${a}/${b} expected ${m ? 'same' : 'different'} (${why})`).join('; ')}`);
} catch (e) {
  fail(`role tokenization guard crashed: ${e.message}`);
}

// ── MERGE-TRACKER: DISTINCT NON-LATIN COMPANIES (#2429) ───────────
// Sibling of the #1603 via guard, one column over. normalizeCompany() stripped
// [^a-z0-9], so EVERY non-Latin company name folded to '' and compared equal to
// every other one — merge-tracker's company+role fallback then treated
// applications at two different companies as the same row and silently
// overwrote one. applications.md is gitignored with no .bak, so the losing
// evaluation was unrecoverable.
console.log('\n🧪 Testing merge-tracker with distinct non-Latin companies (#2429)...');
try {
  const { normalizeCompany } = await import(pathToFileURL(join(ROOT, 'tracker-utils.mjs')).href);

  // Unit: distinct scripts must produce distinct, non-empty keys.
  const keys = ['アクメ株式会社', 'グロベックス合同会社', 'Яндекс', '北京字节跳动'].map(normalizeCompany);
  if (keys.every(k => k !== '') && new Set(keys).size === keys.length) {
    pass('normalizeCompany gives every non-Latin company a distinct non-empty key (#2429)');
  } else {
    fail(`non-Latin company keys collapsed: ${JSON.stringify(keys)}`);
  }
  // Combining marks must SURVIVE the fold. Indic matras have no precomposed
  // form, so a key that strips \p{M} makes Devanagari कंपनी and कपनी (and क
  // and का) identical — re-introducing, for the shipped hi/ar locales, exactly
  // the collision this fix removes for ja/zh/ru. This is why normalizeCompany
  // delegates to normalizeTextKey (which keeps \p{M}) rather than to a
  // company-local fold (#2429 review, #2445).
  const markPairs = [['कंपनी', 'कपनी'], ['क', 'का']];
  if (markPairs.every(([a, b]) => normalizeCompany(a) !== normalizeCompany(b))) {
    pass('company keys keep combining marks, so Devanagari names differing only in matras stay distinct (#2429)');
  } else {
    fail('combining marks stripped from the company key — Indic names differing only in matras now collide');
  }
  // The `?` unknown-employer marker MUST still fold to '' — the #1596
  // cross-channel guard depends on those rows sharing one key.
  if (normalizeCompany('?') === '' && normalizeCompany('—') === '') {
    pass('punctuation-only company still folds to the empty key, preserving the #1596 guard (#2429)');
  } else {
    fail('punctuation-only company no longer folds to empty — the #1596 cross-channel guard is broken');
  }
  // NFKC: full-width and half-width spellings are the same company.
  if (normalizeCompany('ＡＣＭＥ') === normalizeCompany('ACME')) {
    pass('NFKC folds full-width and half-width company spellings together (#2429)');
  } else {
    fail('full-width company name did not fold to its half-width spelling');
  }
  // Latin path unchanged.
  if (normalizeCompany('Acme Inc.') === 'acmeinc' && normalizeCompany('ACME, INC') === 'acmeinc') {
    pass('Latin company keys are unchanged by the Unicode-aware fold (#2429)');
  } else {
    fail('Latin company key changed — existing dedup/selector behaviour would shift');
  }

  // End-to-end: two different non-Latin companies, fuzzy-matching role titles.
  const coTmp = mkdtempSync(join(tmpdir(), 'career-ops-nonlatin-co-'));
  try {
    mkdirSync(join(coTmp, 'data'));
    mkdirSync(join(coTmp, 'reports'));
    const additionsDir = join(coTmp, 'additions');
    mkdirSync(additionsDir);
    const tracker = join(coTmp, 'data', 'applications.md');
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 1 | 2026-01-04 | アクメ株式会社 | Backend Engineer, Payments Platform | 4.0/5 | Evaluated | ❌ | [1](../reports/001-acme-2026-01-04.md) | first company |\n');
    for (const n of ['001-acme-2026-01-04', '002-globex-2026-01-05']) {
      writeFileSync(join(coTmp, 'reports', `${n}.md`), '# fixture\n');
    }
    // DIFFERENT company, same role title → a real second application that must
    // be ADDED, not silently merged over the first.
    writeFileSync(join(additionsDir, '002-globex.tsv'),
      '2\t2026-01-05\tグロベックス合同会社\tBackend Engineer, Payments Platform\tEvaluated\t4.1/5\t❌\t[2](reports/002-globex-2026-01-05.md)\tsecond company\n');

    const coResult = run(NODE, ['merge-tracker.mjs'], { env: { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_ADDITIONS: additionsDir } });
    if (coResult === null) {
      fail('merge-tracker.mjs crashed during non-Latin company test (#2429)');
    } else {
      const merged = readFileSync(tracker, 'utf-8');
      if (merged.includes('アクメ株式会社') && merged.includes('グロベックス合同会社')) {
        pass('two different non-Latin companies stay two rows (#2429)');
      } else {
        fail('a non-Latin company was silently overwritten by a different one — the evaluation is unrecoverable (#2429)');
      }
      const rows = merged.split('\n').filter(l => l.startsWith('| ') && /\| \d+ \|/.test(l));
      if (rows.length === 2) {
        pass('merge-tracker added the second non-Latin company instead of merging (#2429)');
      } else {
        fail(`expected 2 tracker rows after merge, got ${rows.length}`);
      }
    }
  } finally {
    rmSync(coTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`non-Latin company tests crashed: ${e.message}`);
}

// ── MERGE-TRACKER TSV COLUMN-ORDER TOLERANCE (#1427) ─────────────
// Batch TSVs write (status, score); applications.md is (score, status). A
// generator that swaps the two must not merge silently — the score column is
// identified by content pattern, and an undecidable pair is skipped loudly.
console.log('\n🧪 Testing merge-tracker TSV column-order tolerance (#1427)...');
try {
  const { resolveScoreStatus, looksLikeScoreCell } = await import(pathToFileURL(join(ROOT, 'tracker-parse.mjs')).href);

  // Unit: content-pattern discriminator
  if (looksLikeScoreCell('4.2/5') && looksLikeScoreCell('5/5') && looksLikeScoreCell('N/A') && looksLikeScoreCell('DUP') && looksLikeScoreCell('**3.5/5**')) {
    pass('looksLikeScoreCell accepts score cells (incl. N/A, DUP, bolded)');
  } else {
    fail('looksLikeScoreCell rejected a valid score cell');
  }
  if (!looksLikeScoreCell('Evaluated') && !looksLikeScoreCell('Applied') && !looksLikeScoreCell('')) {
    pass('looksLikeScoreCell rejects status labels and blanks');
  } else {
    fail('looksLikeScoreCell matched a non-score cell');
  }

  const std = resolveScoreStatus('Evaluated', '4.2/5');
  const swp = resolveScoreStatus('4.2/5', 'Evaluated');
  if (std && std.score === '4.2/5' && std.status === 'Evaluated' &&
      swp && swp.score === '4.2/5' && swp.status === 'Evaluated') {
    pass('resolveScoreStatus maps both column orders to the same result');
  } else {
    fail(`resolveScoreStatus order handling: std=${JSON.stringify(std)} swp=${JSON.stringify(swp)}`);
  }
  if (resolveScoreStatus('Evaluated', 'Applied') === null && resolveScoreStatus('4.2/5', '5/5') === null) {
    pass('resolveScoreStatus returns null when neither or both cells look like a score');
  } else {
    fail('resolveScoreStatus should be undecidable for two statuses or two scores');
  }

  // #1799: em dash / hyphen recognized as score-cell sentinels, matching the
  // tracker's own "no data" convention used in every other column, alongside
  // the pre-existing N/A / DUP sentinels — for backfilled no-score entries
  // (e.g. a rejection email for a role never run through an evaluation).
  if (looksLikeScoreCell('—') && looksLikeScoreCell('-')) {
    pass('looksLikeScoreCell accepts em-dash and hyphen sentinels (#1799)');
  } else {
    fail('looksLikeScoreCell rejected the em-dash/hyphen sentinels');
  }
  const backfilled = resolveScoreStatus('—', 'Rejected');
  const backfilledSwapped = resolveScoreStatus('Rejected', '—');
  if (backfilled && backfilled.score === '—' && backfilled.status === 'Rejected' &&
      backfilledSwapped && backfilledSwapped.score === '—' && backfilledSwapped.status === 'Rejected') {
    pass('resolveScoreStatus resolves a backfilled em-dash score against a status in either order (#1799)');
  } else {
    fail(`resolveScoreStatus backfilled em-dash handling: std=${JSON.stringify(backfilled)} swp=${JSON.stringify(backfilledSwapped)}`);
  }
  // The #1427 guard must still refuse truly ambiguous rows: two sentinel-like
  // cells give no way to tell score from status.
  if (resolveScoreStatus('—', '-') === null && resolveScoreStatus('—', 'N/A') === null) {
    pass('resolveScoreStatus still refuses two sentinel-like cells as ambiguous (#1427 guard intact)');
  } else {
    fail('resolveScoreStatus should stay undecidable for two sentinel-like cells');
  }

  // End-to-end: a swapped-column TSV merges correctly; an undecidable one is skipped.
  const colTmp = mkdtempSync(join(tmpdir(), 'career-ops-colorder-'));
  try {
    mkdirSync(join(colTmp, 'data'));
    mkdirSync(join(colTmp, 'reports'));
    const additionsDir = join(colTmp, 'additions');
    mkdirSync(additionsDir);
    const tracker = join(colTmp, 'data', 'applications.md');
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 1 | 2026-01-04 | AnchorCo | Platform Engineer | 4.0/5 | Evaluated | ❌ | [1](../reports/001-anchorco-2026-01-04.md) | existing |\n');
    for (const n of ['001-anchorco-2026-01-04', '002-swapco-2026-01-05', '003-ambigco-2026-01-05', '004-boldco-2026-01-05']) {
      writeFileSync(join(colTmp, 'reports', `${n}.md`), '# fixture\n');
    }
    // Swapped order: score BEFORE status (4.6/5 then Evaluated).
    writeFileSync(join(additionsDir, '002-swapco.tsv'),
      '2\t2026-01-05\tSwapCo\tData Engineer\t4.6/5\tEvaluated\t❌\t[2](reports/002-swapco-2026-01-05.md)\tswapped cols\n');
    // Undecidable: two status-like cells, no score → must be skipped, not merged.
    writeFileSync(join(additionsDir, '003-ambigco.tsv'),
      '3\t2026-01-05\tAmbigCo\tAnalyst\tEvaluated\tApplied\t❌\t[3](reports/003-ambigco-2026-01-05.md)\tno score\n');
    // Bold score cell → detected AND persisted write-canonical (unbolded).
    writeFileSync(join(additionsDir, '004-boldco.tsv'),
      '4\t2026-01-05\tBoldCo\tSRE\tEvaluated\t**4.7/5**\t❌\t[4](reports/004-boldco-2026-01-05.md)\tbold score\n');

    const mergeResult = run(NODE, ['merge-tracker.mjs'], { env: { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_ADDITIONS: additionsDir } });
    if (mergeResult === null) {
      fail('merge-tracker.mjs crashed during column-order test');
    } else {
      const merged = readFileSync(tracker, 'utf-8');
      const swapRow = merged.split('\n').find(l => l.includes('SwapCo')) || '';
      // buildRow writes `| … | score | status | … |`, so the score must land in the
      // score column and status in the status column despite the swapped input.
      if (swapRow.includes('| 4.6/5 | Evaluated |')) {
        pass('swapped-column TSV merges with score and status in the correct columns');
      } else {
        fail(`swapped TSV mis-merged: "${swapRow.trim()}"`);
      }
      if (!merged.includes('AmbigCo')) {
        pass('undecidable score/status row is skipped, not merged (no silent swap)');
      } else {
        fail('undecidable row was merged instead of skipped');
      }
      const boldRow = merged.split('\n').find(l => l.includes('BoldCo')) || '';
      if (boldRow.includes('| 4.7/5 | Evaluated |') && !boldRow.includes('**')) {
        pass('bold score cell is persisted write-canonical (unbolded) in the merged row');
      } else {
        fail(`bold score not canonicalized on write: "${boldRow.trim()}"`);
      }
    }
  } finally {
    rmSync(colTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`merge-tracker column-order tests crashed: ${e.message}`);
}

// ── MERGE-TRACKER PDF FLAG SYNC (#1429) ─────────────────────────
// generate-pdf.mjs can run after the tracker row already exists. The
// gitignored data/pdf-index.tsv manifest is the source of truth that the row's
// PDF was generated, so merge-tracker should flip only matching ❌ cells to ✅.
console.log('\n🧪 Testing merge-tracker PDF flag sync from data/pdf-index.tsv (#1429)...');
try {
  // A manifest row only means PDF-ready while its file is on disk (#4777), so a
  // fixture lists the files it expects to exist. The deleted-PDF cases live in
  // tests/merge-tracker.test.mjs.
  const runPdfSyncFixture = (name, trackerRow, pdfIndex = null, additions = [], pdfFiles = []) => {
    const tmp = mkdtempSync(join(tmpdir(), `career-ops-merge-pdf-${name}-`));
    mkdirSync(join(tmp, 'data'), { recursive: true });
    const additionsDir = join(tmp, 'additions');
    const tracker = join(tmp, 'data', 'applications.md');
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      trackerRow + '\n');
    if (pdfIndex !== null) writeFileSync(join(tmp, 'data', 'pdf-index.tsv'), pdfIndex);
    for (const file of pdfFiles) {
      mkdirSync(dirname(join(tmp, file)), { recursive: true });
      writeFileSync(join(tmp, file), '%PDF-1.4\n');
    }
    if (additions.length > 0) {
      mkdirSync(additionsDir, { recursive: true });
      for (const addition of additions) {
        writeFileSync(join(additionsDir, addition.name), addition.content);
      }
    }

    try {
    const result = run(NODE, ['merge-tracker.mjs'], {
      env: { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_ADDITIONS: additionsDir },
    });
    const merged = readFileSync(tracker, 'utf-8');
    return { result, merged };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };

  const matching = runPdfSyncFixture(
    'match',
    '| 7 | 2026-01-04 | Acme | Engineer | 4.2/5 | Evaluated | ❌ | [12](../reports/012-acme-2026-01-04.md) | ok |',
    '# report\tpdf\thtml\tformat\tdate\n' +
      '012\toutput/cv-acme.pdf\toutput/cv-acme.html\tletter\t2026-01-04\n',
    [],
    ['output/cv-acme.pdf'],
  );
  if (matching.result !== null && matching.merged.includes('| ✅ | [12](../reports/012-acme-2026-01-04.md) |')) {
    pass('merge-tracker flips a stale ❌ PDF cell when pdf-index.tsv has the row report number');
  } else {
    fail('merge-tracker did not flip the matching PDF cell from ❌ to ✅');
  }

  const nonMatching = runPdfSyncFixture(
    'miss',
    '| 8 | 2026-01-05 | Globex | Analyst | 3.8/5 | Evaluated | ❌ | [22](../reports/022-globex-2026-01-05.md) | ok |',
    '# report\tpdf\thtml\tformat\tdate\n' +
      '023\toutput/cv-other.pdf\toutput/cv-other.html\tletter\t2026-01-05\n',
  );
  if (nonMatching.result !== null && nonMatching.merged.includes('| ❌ | [22](../reports/022-globex-2026-01-05.md) |')) {
    pass('merge-tracker leaves PDF ❌ when the report number is absent from pdf-index.tsv');
  } else {
    fail('merge-tracker produced a false-positive PDF sync for a missing report number');
  }

  const missingManifest = runPdfSyncFixture(
    'missing',
    '| 9 | 2026-01-06 | Initech | Manager | 3.9/5 | Evaluated | ❌ | [31](../reports/031-initech-2026-01-06.md) | ok |',
  );
  if (missingManifest.result !== null && missingManifest.merged.includes('| ❌ | [31](../reports/031-initech-2026-01-06.md) |')) {
    pass('merge-tracker runs successfully when data/pdf-index.tsv does not exist');
  } else {
    fail('merge-tracker crashed or changed the PDF cell when pdf-index.tsv was missing');
  }

  const newAddition = runPdfSyncFixture(
    'new-addition',
    '',
    '# report\tpdf\thtml\tformat\tdate\n' +
      '041\toutput/cv-umbrella.pdf\toutput/cv-umbrella.html\tletter\t2026-01-07\n',
    [{
      name: '001-umbrella.tsv',
      content: '1\t2026-01-07\tUmbrella\tEngineer\t4.1/5\tEvaluated\t❌\t[41](../reports/041-umbrella-2026-01-07.md)\tok\n',
    }],
    ['output/cv-umbrella.pdf'],
  );
  if (newAddition.result !== null && newAddition.merged.includes('| 1 | 2026-01-07 | Umbrella | Engineer | 4.1/5 | Evaluated | ✅ | [41](../reports/041-umbrella-2026-01-07.md) | ok |')) {
    pass('merge-tracker applies pdf-index.tsv to a newly merged tracker row in the same run');
  } else {
    fail('merge-tracker left a newly merged row at ❌ despite a matching pdf-index.tsv entry');
  }

  // A re-evaluation REPLACES the row's report link, and the PDF flag describes
  // that report. Inheriting the old flag across the change carried the
  // superseded report's ✅ onto a report with no PDF: the row then claimed a
  // tailored CV exists, and the only PDF on disk belonged to the evaluation
  // that had just been superseded (#2594).
  const reevalRow = '| 3 | 2026-01-04 | Acme | Backend Engineer, Payments | 4.5/5 | Evaluated | ✅ | [1](../reports/001-acme-2026-01-04.md) | first |';
  const reevalTsv = (n) => ({
    name: `00${n}-acme.tsv`,
    content: `${n}\t2026-02-01\tAcme\tBackend Engineer, Payments\tEvaluated\t3.9/5\t❌\t[${n}](reports/00${n}-acme-2026-02-01.md)\tre-eval\n`,
  });

  const staleFlag = runPdfSyncFixture(
    'reeval-stale',
    reevalRow,
    '# report\tpdf\thtml\tformat\tdate\n1\toutput/acme-1.pdf\t\t\t2026-01-04\n',
    [reevalTsv(2)],
  );
  const staleRow = staleFlag.merged.split('\n').find((l) => l.startsWith('| 3 ')) || '';
  if (staleFlag.result !== null && /\[2\]/.test(staleRow) && staleRow.split('|')[7].trim() === '❌') {
    pass('a re-eval that changes the report clears a ✅ the new report has no PDF for (#2594)');
  } else {
    fail(`stale PDF flag survived a report change: ${staleRow.trim()}`);
  }

  // The `—`-to-`[2]` variant. extractReportNum returns null for `—`, so a guard
  // demanding BOTH sides be truthy fell straight back to duplicate.pdf and
  // inherited the stale ✅ exactly as before the fix. A `—` row carrying a ✅ is
  // ordinary — it is a tracker entry added before its evaluation (#2594 review).
  const dashRow = '| 4 | 2026-01-04 | Acme | Backend Engineer, Payments | 4.5/5 | Evaluated | ✅ | — | backfilled |';
  const dashFlag = runPdfSyncFixture(
    'reeval-dash',
    dashRow,
    '# report\tpdf\thtml\tformat\tdate\n',
    [reevalTsv(2)],
  );
  const dashResult = dashFlag.merged.split('\n').find((l) => l.startsWith('| 4 ')) || '';
  if (dashFlag.result !== null && /\[2\]/.test(dashResult) && dashResult.split('|')[7].trim() === '❌') {
    pass('a re-eval from a report-less (—) row clears the inherited ✅ too (#2594)');
  } else {
    fail(`stale PDF flag survived a —-to-[2] report change: ${dashResult.trim()}`);
  }

  const keptFlag = runPdfSyncFixture(
    'reeval-kept',
    reevalRow,
    '# report\tpdf\thtml\tformat\tdate\n1\toutput/acme-1.pdf\t\t\t2026-01-04\n2\toutput/acme-2.pdf\t\t\t2026-02-01\n',
    [reevalTsv(2)],
    ['output/acme-1.pdf', 'output/acme-2.pdf'],
  );
  const keptRow = keptFlag.merged.split('\n').find((l) => l.startsWith('| 3 ')) || '';
  if (keptFlag.result !== null && /\[2\]/.test(keptRow) && keptRow.split('|')[7].trim() === '✅') {
    pass('a re-eval keeps ✅ when the NEW report does have a generated PDF (#2594)');
  } else {
    fail(`re-eval wrongly cleared a valid PDF flag: ${keptRow.trim()}`);
  }
} catch (e) {
  fail(`merge-tracker PDF flag sync test crashed: ${e.message}`);
}

// ── MERGE-TRACKER REPORT-NUMBER COLLISION (#912) ─────────────────
// The report-number dedup check was not company-guarded: a TSV for NewCo
// with report [1] would find the existing tracker row [1] for OtherCo and
// update it in-place instead of appending NewCo as a new row.
console.log('\n🧪 Testing merge-tracker report-number cross-company collision (#912)...');
try {
  const col912Tmp = mkdtempSync(join(tmpdir(), 'career-ops-merge-912-'));
  try {
    mkdirSync(join(col912Tmp, 'data'));
    mkdirSync(join(col912Tmp, 'reports'));
    const col912Additions = join(col912Tmp, 'additions');
    mkdirSync(col912Additions);

    const col912Tracker = join(col912Tmp, 'data', 'applications.md');
    writeFileSync(col912Tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 1 | 2026-01-01 | OtherCo | Staff Engineer | 4.0/5 | Evaluated | ❌ | [1](../reports/001-otherco-2026-01-01.md) | original |\n');
    writeFileSync(join(col912Tmp, 'reports', '001-otherco-2026-01-01.md'), '# fixture\n');
    writeFileSync(join(col912Tmp, 'reports', '001-newco-2026-01-05.md'), '# fixture\n');

    // NewCo TSV also carries report number [1] — cross-company collision
    writeFileSync(join(col912Additions, '001-newco.tsv'),
      '1\t2026-01-05\tNewCo\tNew Role\tEvaluated\t2.7/5\t❌\t[1](reports/001-newco-2026-01-05.md)\tcollision\n');

    const col912Result = run(NODE, ['merge-tracker.mjs'], {
      env: { ...process.env, CAREER_OPS_TRACKER: col912Tracker, CAREER_OPS_ADDITIONS: col912Additions },
    });
    if (col912Result === null) {
      fail('merge-tracker crashed during report-number collision test (#912)');
    } else {
      const col912Merged = readFileSync(col912Tracker, 'utf-8');
      const col912Rows = col912Merged.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| #') && !l.startsWith('|---'));
      const expectedOtherCoRow = '| 1 | 2026-01-01 | OtherCo | Staff Engineer | 4.0/5 | Evaluated | ❌ | [1](../reports/001-otherco-2026-01-01.md) | original |';

      if (col912Rows.length === 2) {
        pass('report-number collision (#912): merged tracker has exactly 2 rows');
      } else {
        fail(`report-number collision (#912): expected 2 rows, got ${col912Rows.length}`);
      }

      if (col912Rows.some(r => r.trim() === expectedOtherCoRow.trim())) {
        pass('report-number collision (#912): existing OtherCo row left untouched (exact match)');
      } else {
        fail('report-number collision (#912): OtherCo row was overwritten by NewCo addition');
      }

      const expectedNewCoRow = '| 2 | 2026-01-05 | NewCo | New Role | 2.7/5 | Evaluated | ❌ | [1](../reports/001-newco-2026-01-05.md) | collision |';
      if (col912Rows.some(r => r.trim() === expectedNewCoRow.trim())) {
        pass('report-number collision (#912): NewCo appended as a new entry with correct data');
      } else {
        fail('report-number collision (#912): NewCo entry was swallowed or has incorrect data');
      }
    }
  } finally {
    rmSync(col912Tmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`merge-tracker report-number collision test crashed: ${e.message}`);
}

// ── MERGE-TRACKER STALE-NUMBER COLLISION WITH AN EXISTING ROW (#1704) ────
// Different from the #912 test above: that one is a same-run collision where
// the incoming TSV's num equals an EXISTING row's num (addition.num <= maxNum,
// already handled by the old ++maxNum fallback). This one exercises the actual
// #1704 gap: an existing row's number is invisible to the plain maxNum scan
// (merge-tracker's own header/separator-skip heuristic excludes any row whose
// company/role text happens to contain "Empresa" or "---" — a real Spanish-
// market company name is a realistic trigger), so the naive
// `addition.num > maxNum` check trusted a colliding number as free. The fix
// builds a Set of every number actually on the tracker (independent of that
// heuristic) and refuses to trust a number already in it.
console.log('\n🧪 Testing merge-tracker stale-number collision with a hidden existing row (#1704)...');
try {
  const staleNumTmp = mkdtempSync(join(tmpdir(), 'career-ops-merge-1704-'));
  try {
    mkdirSync(join(staleNumTmp, 'data'));
    const staleNumAdditions = join(staleNumTmp, 'additions');
    mkdirSync(staleNumAdditions);

    const staleNumTracker = join(staleNumTmp, 'data', 'applications.md');
    // Row #9's company text contains "Empresa" — merge-tracker's existingApps
    // loop skips this line entirely (the same heuristic it uses to skip the
    // Spanish-locale header row), so its number is NOT counted toward the old
    // plain maxNum scan.
    writeFileSync(staleNumTracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 9 | 2026-01-02 | Empresa Digital SA | Analyst | 3.5/5 | Evaluated | ❌ | — | original |\n');

    // Stale TSV for an unrelated company also embeds num=9 — numerically
    // "ahead" of the naive maxNum(0) computed from the hidden row, but already
    // used.
    writeFileSync(join(staleNumAdditions, '001-newco.tsv'),
      '9\t2026-01-10\tNewCo\tFresh Role\tEvaluated\t2.9/5\t❌\t—\tstale number\n');

    const staleNumResult = run(NODE, ['merge-tracker.mjs'], {
      env: { ...process.env, CAREER_OPS_TRACKER: staleNumTracker, CAREER_OPS_ADDITIONS: staleNumAdditions },
    });
    if (staleNumResult === null) {
      fail('merge-tracker crashed during stale-number collision test (#1704)');
    } else {
      const staleNumMerged = readFileSync(staleNumTracker, 'utf-8');
      const staleNumRows = staleNumMerged.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| #') && !l.startsWith('|---'));

      if (staleNumRows.length === 2) {
        pass('stale-number collision (#1704): merged tracker has exactly 2 rows');
      } else {
        fail(`stale-number collision (#1704): expected 2 rows, got ${staleNumRows.length}`);
      }

      const numsUsed = staleNumRows.map(r => parseInt(r.split('|')[1].trim(), 10));
      if (new Set(numsUsed).size === numsUsed.length) {
        pass('stale-number collision (#1704): no two rows share a tracker number');
      } else {
        fail(`stale-number collision (#1704): duplicate tracker number produced — ${numsUsed.join(', ')}`);
      }

      if (staleNumRows.some(r => r.includes('Empresa Digital SA') && /^\| 9 \|/.test(r))) {
        pass('stale-number collision (#1704): hidden existing row #9 (Empresa Digital SA) untouched');
      } else {
        fail(`stale-number collision (#1704): existing #9 row was overwritten\n${staleNumMerged}`);
      }

      if (staleNumRows.some(r => r.includes('NewCo') && !/^\| 9 \|/.test(r))) {
        pass('stale-number collision (#1704): NewCo bumped to a truly free number instead of reusing #9');
      } else {
        fail(`stale-number collision (#1704): NewCo was not bumped off the colliding number\n${staleNumMerged}`);
      }
    }
  } finally {
    rmSync(staleNumTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`merge-tracker stale-number collision test crashed: ${e.message}`);
}

// ── MERGE-TRACKER RESERVED-NUMBER FIDELITY (#1733) ──────────────
// Parallel workers may reserve numbers in order but finish out of order. A
// free reserved number remains valid even when a later number has already
// reached the tracker; merge-tracker must preserve it, and only renumber on a
// real collision (with a visible warning).
console.log('\n🧪 Testing merge-tracker reserved-number fidelity (#1733)...');
try {
  const reservedTmp = mkdtempSync(join(tmpdir(), 'career-ops-merge-reserved-'));
  try {
    mkdirSync(join(reservedTmp, 'data'));
    const reservedAdditions = join(reservedTmp, 'additions');
    mkdirSync(reservedAdditions);
    const reservedTracker = join(reservedTmp, 'data', 'applications.md');
    writeFileSync(reservedTracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 10 | 2026-01-10 | LaterCo | Engineer | 4.0/5 | Evaluated | ❌ | — | finished first |\n');

    writeFileSync(join(reservedAdditions, '005-early.tsv'),
      '5\t2026-01-05\tEarlyCo\tEngineer\tEvaluated\t4.1/5\t❌\t[5](reports/005-early-2026-01-05.md)\treserved first\n');
    const preserveResult = run(NODE, ['merge-tracker.mjs'], {
      env: { ...process.env, CAREER_OPS_TRACKER: reservedTracker, CAREER_OPS_ADDITIONS: reservedAdditions },
    });
    const afterPreserve = readFileSync(reservedTracker, 'utf-8');
    if (preserveResult !== null && /^\| 5 \|[^\n]*\| EarlyCo \|/m.test(afterPreserve)) {
      pass('merge-tracker preserves a free reserved ID below the current maximum');
    } else {
      fail(`merge-tracker renumbered a free reserved ID\n${afterPreserve}`);
    }

    writeFileSync(join(reservedAdditions, '005-collision.tsv'),
      '5\t2026-01-11\tCollisionCo\tAnalyst\tEvaluated\t3.8/5\t❌\t—\tstale reservation\n');
    const collisionResult = spawnSync(NODE, [join(ROOT, 'merge-tracker.mjs')], {
      cwd: ROOT,
      encoding: 'utf-8',
      env: { ...process.env, CAREER_OPS_TRACKER: reservedTracker, CAREER_OPS_ADDITIONS: reservedAdditions },
    });
    const afterCollision = readFileSync(reservedTracker, 'utf-8');
    const collisionOutput = `${collisionResult.stdout || ''}\n${collisionResult.stderr || ''}`;
    if (collisionResult.status === 0
        && /^\| 11 \|[^\n]*\| CollisionCo \|/m.test(afterCollision)
        && /#5[^\n]*(?:already|collision)[^\n]*#11/i.test(collisionOutput)) {
      pass('merge-tracker renumbers only a real collision and warns with both IDs');
    } else {
      fail(`merge-tracker collision fallback was not loud and deterministic\n${collisionOutput}\n${afterCollision}`);
    }
  } finally {
    rmSync(reservedTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`merge-tracker reserved-number fidelity test crashed: ${e.message}`);
}

// ── DEDUP BLINDNESS FROM `---` / "Empresa" IN A DATA ROW (#2265) ─────────
// Readers recognized the markdown separator row with `line.includes('---')`,
// which also matched any DATA row whose free text contained three hyphens — a
// URL slug like `Senior-Engineer---Platform-Team`, an em dash typed as
// `---` — or, via the sibling `.includes('Empresa')` guard, a Spanish-market
// company name. Such a row never reached `existingApps`, so it was invisible to
// duplicate detection: re-evaluating that exact role appended a second row
// instead of updating the first in place.
//
// #1704 fixed the NUMBERING half of this (the separate usedNumbers pass, so the
// hidden row's number is never reissued) and deliberately left `existingApps`
// alone. This covers the dedup half, and pins the row-format check that shares
// the same heuristic.
console.log('\n🧪 Testing dedup blindness from `---` / "Empresa" in a data row...');
try {
  const hyphenTmp = mkdtempSync(join(tmpdir(), 'career-ops-dedup-hyphen-'));
  try {
    const hData = join(hyphenTmp, 'data');
    const hReports = join(hyphenTmp, 'reports');
    const hAdditions = join(hyphenTmp, 'additions');
    mkdirSync(hData);
    mkdirSync(hReports);
    mkdirSync(hAdditions);

    const hTracker = join(hData, 'applications.md');
    const hHeader =
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n';
    // Row #2 hides behind `---` (URL slug); row #1 hides behind "Empresa"
    // (a Spanish company name). Both must be visible to dedup.
    const hRows =
      '| 2 | 2026-01-05 | Acme Corp | Director, Data Platform | 4.3/5 | Evaluated | ❌ | ' +
      '[2](../reports/002-acme-corp-2026-01-05.md) | URL slug says Senior-Engineer---Platform-Team. |\n' +
      '| 1 | 2026-01-05 | Empresa Ejemplo | Data Lead | 3.9/5 | Evaluated | ❌ | ' +
      '[1](../reports/001-empresa-ejemplo-2026-01-05.md) | Madrid hybrid. |\n';
    writeFileSync(hTracker, hHeader + hRows);
    for (const r of ['002-acme-corp-2026-01-05.md', '001-empresa-ejemplo-2026-01-05.md']) {
      writeFileSync(join(hReports, r), '# fixture\n');
    }

    // Re-evaluation of BOTH existing roles at a higher score. Correct behavior
    // is two in-place updates and zero new rows.
    writeFileSync(join(hAdditions, '002-acme-corp.tsv'),
      '2\t2026-01-06\tAcme Corp\tDirector, Data Platform\tEvaluated\t4.8/5\t❌\t' +
      '[2](reports/002-acme-corp-2026-01-05.md)\tre-evaluated after JD update\n');
    writeFileSync(join(hAdditions, '001-empresa-ejemplo.tsv'),
      '1\t2026-01-06\tEmpresa Ejemplo\tData Lead\tEvaluated\t4.1/5\t❌\t' +
      '[1](reports/001-empresa-ejemplo-2026-01-05.md)\tre-evaluated after JD update\n');

    const hOut = run(NODE, ['merge-tracker.mjs'], {
      env: { ...process.env, CAREER_OPS_TRACKER: hTracker, CAREER_OPS_ADDITIONS: hAdditions },
    });

    if (hOut === null) {
      fail('merge-tracker crashed on the `---`/"Empresa" fixture');
    } else {
      if (/Existing: 2 entries/.test(hOut)) {
        pass('rows containing `---` and "Empresa" are both visible to merge-tracker');
      } else {
        fail(`merge-tracker did not see both rows — expected "Existing: 2 entries", got: ${hOut.split('\n').find(l => l.includes('Existing:')) || '(none)'}`);
      }

      const hMerged = readFileSync(hTracker, 'utf-8');
      const hDataRows = hMerged.split('\n').filter(l => /^\|\s*\d+\s*\|/.test(l));

      if (hDataRows.length === 2) {
        pass('re-evaluating a `---`/"Empresa" row updates in place, no duplicate row appended');
      } else {
        fail(`expected 2 rows after two in-place updates, got ${hDataRows.length}`);
      }

      if (/4\.8\/5/.test(hMerged) && /4\.1\/5/.test(hMerged)) {
        pass('both re-evaluated scores landed on the existing rows');
      } else {
        fail('re-evaluated scores did not reach the existing rows');
      }

      // The separator row must still be found, or new rows land in the wrong
      // place (or nowhere) — the structural match has to keep working.
      if (hMerged.includes('|---|------|')) {
        pass('table separator row survives the merge intact');
      } else {
        fail('table separator row was consumed or rewritten');
      }
    }

    // verify-pipeline's row-format check shares the heuristic: a malformed row
    // carrying `---` used to skip the column-count check entirely.
    const hBadRow = join(hData, 'applications-badrow.md');
    writeFileSync(hBadRow, hHeader +
      '| 3 | 2026-01-05 | Acme | Truncated Row --- with hyphens |\n' + hRows);
    let badOut = '';
    let badCode = 0;
    try {
      badOut = execFileSync(NODE, ['verify-pipeline.mjs'], {
        cwd: ROOT, encoding: 'utf-8', timeout: 30000,
        env: { ...process.env, CAREER_OPS_TRACKER: hBadRow, CAREER_OPS_REPORTS: hReports },
      });
    } catch (e) {
      badOut = String(e.stdout ?? '');
      badCode = e.status ?? -1;
    }
    if (/Row with too few columns/.test(badOut) && badCode === 1) {
      pass('verify-pipeline flags a malformed row even when it contains `---`');
    } else {
      fail(`verify-pipeline did not flag a short row containing \`---\` (exit ${badCode})`);
    }

    // Header detection must key on the whole header SCHEMA, not one telltale
    // cell: a malformed row carrying an exact `Empresa`/`Company` cell (a
    // company genuinely named that, a one-word note) must not be mistaken for
    // the header and skip the column-count check.
    const hHeaderish = join(hData, 'applications-headerish.md');
    writeFileSync(hHeaderish, hHeader +
      '| 4 | 2026-01-05 | Empresa | Short Row |\n' +
      '| 5 | 2026-01-05 | Company | Also Short |\n' + hRows);
    let hdrOut = '';
    let hdrCode = 0;
    try {
      hdrOut = execFileSync(NODE, ['verify-pipeline.mjs'], {
        cwd: ROOT, encoding: 'utf-8', timeout: 30000,
        env: { ...process.env, CAREER_OPS_TRACKER: hHeaderish, CAREER_OPS_REPORTS: hReports },
      });
    } catch (e) {
      hdrOut = String(e.stdout ?? '');
      hdrCode = e.status ?? -1;
    }
    const shortRowErrors = (hdrOut.match(/Row with too few columns/g) || []).length;
    if (shortRowErrors === 2 && hdrCode === 1) {
      pass('a malformed row with an exact Empresa/Company cell is not mistaken for the header');
    } else {
      fail(`expected 2 short-row errors for header-like malformed rows, got ${shortRowErrors} (exit ${hdrCode})`);
    }

    // …and the real header row must still be recognized, or every tracker
    // reports its own header as a malformed row.
    if (!/Row with too few columns[^\n]*# \| Date \| Company/.test(hdrOut)) {
      pass('the genuine header row is still recognized as header furniture');
    } else {
      fail('the genuine header row was flagged as a malformed data row');
    }

    // A FULLY localized header must map through the alias table, not fall back
    // to LEGACY_COLMAP (#2274). On a plain 9-column table the fallback happens
    // to line up and hides the bug; with a Location column inserted, the Score
    // cell is read from Location instead — an ES tracker scored "Remote".
    // `date` is not in REQUIRED_HEADER_FIELDS, so a missing `fecha` alias does
    // not fail the header — it resolves with no date column and every row comes
    // back with an empty date (#3705). Assert the Fecha column is actually
    // resolved, not silently absent.
    const trackerParse = await import(pathToFileURL(join(ROOT, 'tracker-parse.mjs')).href);
    const esHeader = '| # | Fecha | Empresa | Puesto | Location | Score | Status | PDF | Report | Notes |';
    const esMap = trackerParse.detectColumns([esHeader]);
    if (esMap && esMap.date === 2 && esMap.score === 6 && esMap.company === 3 && esMap.role === 4 && esMap.location === 5) {
      pass('a fully localized header maps through the alias table (#2274, #3705)');
    } else {
      fail(`localized header did not map: ${JSON.stringify(esMap)}`);
    }

    // The two readers must agree on every shape, or validation skips as
    // furniture what column detection cannot parse.
    const headerShapes = [
      ['| # | Date | Company | Role | Score | Status | PDF | Report | Notes |', true],
      ['| # | Date | Company | Role | Location | Score | Status | PDF | Report | Notes |', true],
      ['| # | Fecha | Empresa | Puesto | Score | Status | PDF | Report | Notes |', true],
      [esHeader, true],
      ['| 4 | 2026-01-05 | Company | Short Row |', false],
      ['| 5 | 2026-01-05 | Empresa | Also Short |', false],
      ['| 6 | 2026-01-05 | Acme Corp | Director | 4.0/5 | Evaluated | ❌ | — | note |', false],
      ['|---|------|---------|------|-------|--------|-----|--------|-------|', false],
    ];
    const disagreements = headerShapes.filter(([line, expected]) => {
      const isHeader = trackerParse.isHeaderRow(line);
      const detects = trackerParse.detectColumns([line]) !== null;
      return isHeader !== detects || isHeader !== expected;
    });
    if (disagreements.length === 0) {
      pass('isHeaderRow and detectColumns agree on every header shape');
    } else {
      fail(`isHeaderRow/detectColumns disagree on: ${disagreements.map(d => d[0].slice(0, 40)).join(' | ')}`);
    }
  } finally {
    rmSync(hyphenTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`dedup blindness test crashed: ${e.message}`);
}

// ── MERGE-TRACKER REQ/JOB-NUMBER DEDUP GUARD (#1524) ─────────────────────
// Tier-3 dedup (company + fuzzy role match) had no req/job-number awareness:
// two distinct postings at the same company with similarly-worded titles were
// silently collapsed into one row whenever a req/job number in the Notes
// column was the only thing distinguishing them. Covers: (a) same-looking
// titles + different req numbers → NOT a duplicate, (b) same-looking titles +
// same req number → still a duplicate, (c) no req number on either side →
// existing fuzzy-match behavior unchanged, (d) req number on only one side →
// falls back to fuzzy-match behavior (can't prove a mismatch without both).
console.log('\n🧪 Testing merge-tracker req/job-number dedup guard (#1524)...');
try {
  const reqTmp = mkdtempSync(join(tmpdir(), 'career-ops-merge-1524-'));
  try {
    mkdirSync(join(reqTmp, 'data'));
    mkdirSync(join(reqTmp, 'reports'));
    const reqAdditions = join(reqTmp, 'additions');
    mkdirSync(reqAdditions);
    const reqTracker = join(reqTmp, 'data', 'applications.md');
    writeFileSync(reqTracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 1 | 2026-01-01 | Fabrikam | Learning Development Designer III | 3.8/5 | Evaluated | ❌ | [1](../reports/001-fabrikam-2026-01-01.md) | Req R_1000001 |\n' +
      '| 2 | 2026-01-01 | Fabrikam | Curriculum Program Coordinator | 3.5/5 | Evaluated | ❌ | [2](../reports/002-fabrikam-2026-01-01.md) | no req number here |\n' +
      '| 3 | 2026-01-01 | Northwind | Operations Analyst | 3.6/5 | Evaluated | ❌ | [3](../reports/003-northwind-2026-01-01.md) | Job 2026-55501 |\n');
    for (const n of [
      '001-fabrikam-2026-01-01', '002-fabrikam-2026-01-01', '003-northwind-2026-01-01',
      '004-fabrikam-2026-01-02', '005-fabrikam-2026-01-02', '006-fabrikam-2026-01-02', '007-northwind-2026-01-02',
    ]) {
      writeFileSync(join(reqTmp, 'reports', `${n}.md`), '# fixture\n');
    }

    // (a) Same-looking title, DIFFERENT req number → must NOT be treated as a duplicate.
    writeFileSync(join(reqAdditions, '004-fabrikam.tsv'),
      '4\t2026-01-02\tFabrikam\tLearning Development Curriculum Designer\tEvaluated\t4.5/5\t❌\t[4](reports/004-fabrikam-2026-01-02.md)\tReq R_1000002 — distinct posting (#1524)\n');
    // (b) Same-looking title, SAME req number → still a duplicate (lower score → skipped, row untouched).
    writeFileSync(join(reqAdditions, '005-fabrikam.tsv'),
      '5\t2026-01-02\tFabrikam\tLearning Development Designer III (Repost)\tEvaluated\t3.0/5\t❌\t[5](reports/005-fabrikam-2026-01-02.md)\tReq R_1000001 — same posting repost\n');
    // (c) No req number on either side → existing fuzzy-match behavior unchanged (still deduped).
    writeFileSync(join(reqAdditions, '006-fabrikam.tsv'),
      '6\t2026-01-02\tFabrikam\tCurriculum Program Coordinator II\tEvaluated\t3.9/5\t❌\t[6](reports/006-fabrikam-2026-01-02.md)\tno req number, higher score\n');
    // (d) Req number on only one side → can't prove a mismatch, falls back to fuzzy-match (still deduped).
    writeFileSync(join(reqAdditions, '007-northwind.tsv'),
      '7\t2026-01-02\tNorthwind\tOperations Analyst\tEvaluated\t3.2/5\t❌\t[7](reports/007-northwind-2026-01-02.md)\tno req number on this side\n');

    const reqResult = run(NODE, ['merge-tracker.mjs'], { env: { ...process.env, CAREER_OPS_TRACKER: reqTracker, CAREER_OPS_ADDITIONS: reqAdditions } });
    if (reqResult === null) {
      fail('merge-tracker.mjs crashed during req/job-number dedup guard test (#1524)');
    } else {
      const reqMerged = readFileSync(reqTracker, 'utf-8');
      const reqRows = reqMerged.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| #') && !l.startsWith('|---'));

      // (a) Different req numbers: distinct posting added as a NEW row, existing #1 left untouched.
      const distinctRow = reqRows.find(r => r.includes('Learning Development Curriculum Designer'));
      const originalRow1 = reqRows.find(r => r.includes('Learning Development Designer III') && !r.includes('(Repost)') && !r.includes('Curriculum Designer'));
      if (distinctRow && originalRow1 && originalRow1.includes('3.8/5') && originalRow1.includes('R_1000001')) {
        pass('(#1524a) different req numbers on similar titles → NOT deduped, both rows present');
      } else {
        fail('(#1524a) different req numbers on similar titles were incorrectly deduped');
      }

      // (b) Same req number: still recognized as a duplicate — no separate "(Repost)" row,
      // and since the new score (3.0) is lower than the existing (3.8), the existing row is left as-is.
      const repostRow = reqRows.find(r => r.includes('(Repost)'));
      if (!repostRow && originalRow1 && originalRow1.includes('3.8/5')) {
        pass('(#1524b) same req number on similar titles → still deduped (skipped, lower score)');
      } else {
        fail('(#1524b) same req number should have been deduped away, not added as a new row');
      }

      // (c) No req number on either side: existing fuzzy-match-only behavior preserved — deduped and
      // updated in place (higher score), not appended as a new row.
      const coordinatorRows = reqRows.filter(r => r.includes('Curriculum Program Coordinator'));
      if (coordinatorRows.length === 1 && coordinatorRows[0].includes('3.9/5')) {
        pass('(#1524c) no req number on either side → fuzzy-match behavior unchanged (updated in place)');
      } else {
        fail(`(#1524c) fuzzy-match-only behavior regressed: expected 1 'Curriculum Program Coordinator' row at 3.9/5, got ${coordinatorRows.length}`);
      }

      // (d) Req number on only one side (existing row has "Job 2026-55501", addition has none):
      // can't prove a mismatch without both numbers, so falls back to fuzzy match → still deduped
      // into exactly one row. The addition's score (3.2) is lower than the existing (3.6), so the
      // existing row is left as-is rather than updated.
      const opsAnalystRows = reqRows.filter(r => r.includes('Operations Analyst'));
      if (opsAnalystRows.length === 1 && opsAnalystRows[0].includes('3.6/5')) {
        pass('(#1524d) req number on only one side → falls back to fuzzy match, still deduped');
      } else {
        fail(`(#1524d) one-sided req number should fall back to fuzzy match: expected 1 'Operations Analyst' row at 3.6/5, got ${opsAnalystRows.length}`);
      }
    }
  } finally {
    rmSync(reqTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`merge-tracker req/job-number dedup guard test crashed: ${e.message}`);
}

// ── MERGE-TRACKER CONCURRENT WRITES (#781 follow-up) ─────────────────────
// Report-number reservation is atomic now (#803), but tracker merges are a
// separate read/modify/write step. If two merge-tracker processes read the same
// old applications.md snapshot and then write back independently, one process
// can erase the row added by the other. This fixture gives each process a
// different additions dir and pauses the first process after it has read the
// tracker, making the old race deterministic.
console.log('\n🧪 Testing merge-tracker concurrent writes...');
try {
  let retries = 1;
  while (retries >= 0) {
    const mergeTmp = mkdtempSync(join(tmpdir(), 'career-ops-merge-lock-'));
    /**
     * Spawn one isolated `merge-tracker.mjs` process against the temporary fixture.
     *
     * Each spawned process receives the same tracker path and lock path but a
     * different additions directory. Without serialization, both processes can
     * read the same old tracker and the later write can lose the other row. The
     * first worker also sends an IPC readiness message after reading the tracker
     * and before its test hold, which lets the test launch the second worker at
     * the exact old race point instead of relying on scheduler timing.
     *
     * @param {string} additionsDir - Directory containing this process's TSV row.
     * @param {number} [holdMs=0] - Optional post-read delay injected into the merge.
     * @returns {{ready: Promise<void>, result: Promise<{code:number|null,stdout:string,stderr:string}>}}
     * Worker readiness and final process result promises.
     */
    function spawnMerge(additionsDir, holdMs = 0) {
      let markReady;
      let readyMarked = false;
      const ready = new Promise(resolve => { markReady = resolve; });
      const result = new Promise(resolve => {
        const child = spawn(NODE, ['merge-tracker.mjs'], {
          cwd: ROOT,
          env: {
            ...process.env,
            CAREER_OPS_TRACKER: join(mergeTmp, 'data', 'applications.md'),
            CAREER_OPS_ADDITIONS: additionsDir,
            CAREER_OPS_BATCH_STATE: join(mergeTmp, 'batch-state.tsv'),
            CAREER_OPS_TRACKER_LOCK: join(mergeTmp, 'career-ops-merge-tracker-fixture.lock'),
            CAREER_OPS_MERGE_HOLD_MS: String(holdMs),
            CAREER_OPS_MERGE_READY_IPC: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let stdout = '';
        let stderr = '';
        const resolveReady = () => {
          if (readyMarked) return;
          readyMarked = true;
          markReady();
        };
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('message', msg => {
          if (msg?.type === 'merge-tracker-ready') resolveReady();
        });
        child.on('error', err => {
          resolveReady();
          resolve({ code: -1, stdout, stderr: String(err) });
        });
        child.on('close', code => {
          resolveReady();
          resolve({ code, stdout, stderr });
        });
      });
      return { ready, result };
    }

    /**
     * Fail fast when a worker never reaches the deterministic race checkpoint.
     *
     * A missing readiness signal would otherwise hang the test suite. Timing out
     * turns that broken test contract into a normal assertion failure with a clear
     * message.
     *
     * @param {Promise<void>} ready - Worker readiness promise.
     * @param {number} timeoutMs - Maximum milliseconds to wait.
     * @returns {Promise<void>} Resolves when ready arrives before the timeout.
     */
    function waitForReady(ready, timeoutMs) {
      return Promise.race([
        ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error('merge worker did not signal readiness')), timeoutMs)),
      ]);
    }

    try {
      mkdirSync(join(mergeTmp, 'data'));
      mkdirSync(join(mergeTmp, 'reports'));
      const additionsA = join(mergeTmp, 'additions-a');
      const additionsB = join(mergeTmp, 'additions-b');
      mkdirSync(additionsA);
      mkdirSync(additionsB);

      writeFileSync(join(mergeTmp, 'data', 'applications.md'),
        '# Applications Tracker\n\n' +
        '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
        '|---|------|---------|------|-------|--------|-----|--------|-------|\n');
      writeFileSync(join(mergeTmp, 'reports', '010-alpha-2026-01-07.md'), '# fixture\n');
      writeFileSync(join(mergeTmp, 'reports', '011-beta-2026-01-07.md'), '# fixture\n');
      writeFileSync(join(additionsA, '010-alpha.tsv'),
        '10\t2026-01-07\tAlpha\tPlatform Engineer\tEvaluated\t4.1/5\t❌\t[10](reports/010-alpha-2026-01-07.md)\tfirst concurrent merge\n');
      writeFileSync(join(additionsB, '011-beta.tsv'),
        '11\t2026-01-07\tBeta\tData Engineer\tEvaluated\t4.2/5\t❌\t[11](reports/011-beta-2026-01-07.md)\tsecond concurrent merge\n');

      const first = spawnMerge(additionsA, 350);
      await waitForReady(first.ready, 10_000); // Widen to 10s
      const second = spawnMerge(additionsB, 0);
      const [firstResult, secondResult] = await Promise.all([first.result, second.result]);

      if (firstResult.code === 0 && secondResult.code === 0) {
        pass('concurrent merge processes both exited successfully');
      } else {
        throw new Error(`concurrent merge process failed: first=${firstResult.code} second=${secondResult.code} stderr=${firstResult.stderr || secondResult.stderr}`);
      }

      const merged = readFileSync(join(mergeTmp, 'data', 'applications.md'), 'utf-8');
      if (merged.includes('Alpha') && merged.includes('Beta')) {
        pass('concurrent tracker merges preserve rows from both processes');
      } else {
        throw new Error(`concurrent tracker merge lost a row: ${merged}`);
      }
      break;
    } catch (e) {
      if (retries > 0) {
        warn(`merge-tracker concurrent write test flaked (${e.message}). Retrying once...`);
        retries -= 1;
      } else {
        fail(`merge-tracker concurrent write test crashed: ${e.message}`);
        break;
      }
    } finally {
      rmSync(mergeTmp, { recursive: true, force: true });
    }
  }
} catch (e) {
  fail(`merge-tracker concurrent write test crashed: ${e.message}`);
}

// ── 12. COLD-START TRIGGER ──────────────────────────────────────

console.log('\n12. Cold-start trigger (deterministic onboarding state)');

try {
  // Virgin env: none of the 3 user-layer prerequisites present → must onboard.
  const virgin = mkdtempSync(join(tmpdir(), 'co-cold-'));
  const v = JSON.parse(run(NODE, ['doctor.mjs', '--json', '--target', virgin]) || '{}');
  if (
    v.onboardingNeeded === true &&
    Array.isArray(v.missing) &&
    v.missing.length === 3 &&
    Array.isArray(v.warnings)
  ) {
    pass('Virgin env → onboarding triggered (3 prerequisites missing)');
  } else {
    fail(`Virgin env not flagged for onboarding: ${JSON.stringify(v)}`);
  }
  rmSync(virgin, { recursive: true, force: true });

  // Fully provisioned env: all 3 present → must NOT onboard.
  const ready = mkdtempSync(join(tmpdir(), 'co-ready-'));
  mkdirSync(join(ready, 'config'), { recursive: true });
  mkdirSync(join(ready, 'modes'), { recursive: true });
  for (const f of ['cv.md', 'config/profile.yml', 'modes/_profile.md']) {
    writeFileSync(join(ready, f), 'x');
  }
  const r = JSON.parse(run(NODE, ['doctor.mjs', '--json', '--target', ready]) || '{}');
  if (r.onboardingNeeded === false && Array.isArray(r.warnings)) {
    pass('Provisioned env → no onboarding');
  } else {
    fail(`Provisioned env falsely flagged for onboarding: ${JSON.stringify(r)}`);
  }
  rmSync(ready, { recursive: true, force: true });

  // Auto-copy template: when modes/_profile.md or modes/_custom.md is missing but template exists,
  // doctor --json --init-templates copies them, records them in autoCopied, and does not report them as missing (#1369).
  const autoCopy = mkdtempSync(join(tmpdir(), 'co-autocopy-'));
  mkdirSync(join(autoCopy, 'config'), { recursive: true });
  mkdirSync(join(autoCopy, 'modes'), { recursive: true });
  for (const f of ['cv.md', 'config/profile.yml']) {
    writeFileSync(join(autoCopy, f), 'x');
  }
  writeFileSync(join(autoCopy, 'modes/_profile.template.md'), '# profile template\n');
  writeFileSync(join(autoCopy, 'modes/_custom.template.md'), '# custom template\n');
  const ac = JSON.parse(run(NODE, ['doctor.mjs', '--json', '--init-templates', '--target', autoCopy]) || '{}');
  if (
    ac.onboardingNeeded === false &&
    Array.isArray(ac.missing) &&
    ac.missing.length === 0 &&
    Array.isArray(ac.autoCopied) &&
    ac.autoCopied.includes('modes/_profile.md') &&
    ac.autoCopied.includes('modes/_custom.md') &&
    existsSync(join(autoCopy, 'modes/_profile.md')) &&
    readFileSync(join(autoCopy, 'modes/_profile.md'), 'utf-8') === '# profile template\n' &&
    existsSync(join(autoCopy, 'modes/_custom.md')) &&
    readFileSync(join(autoCopy, 'modes/_custom.md'), 'utf-8') === '# custom template\n'
  ) {
    pass('Explicit onboarding → modes/_profile.md and modes/_custom.md copied with --init-templates (#1369)');
  } else {
    fail(`Template initialization failed: ${JSON.stringify(ac)}`);
  }
  rmSync(autoCopy, { recursive: true, force: true });

  const claudeDoc = readFile('CLAUDE.md');
  const agentsDoc = readFile('AGENTS.md');
  const claudeWrapperLines = claudeDoc.trim().split(/\r?\n/).filter(Boolean);
  if (
    /node\s+doctor\.mjs\s+--json/.test(agentsDoc) &&
    /"warnings"\s*:\s*\[\.\.\.\]/.test(agentsDoc) &&
    /"autoCopied"\s*:\s*\[\.\.\.\]/.test(agentsDoc) &&
    claudeWrapperLines[0] === '@AGENTS.md' &&
    claudeWrapperLines.length <= 8 &&
    !/Does\s+`cv\.md`\s+exist\?/i.test(claudeDoc)
  ) {
    pass('AGENTS.md delegates onboarding state and autoCopied to doctor --json; CLAUDE.md stays thin');
  } else {
    fail('AGENTS.md misses onboarding state docs or CLAUDE.md is not a thin wrapper');
  }
} catch (e) {
  fail(`Cold-start trigger test crashed: ${e.message}`);
}

// ── 13. BATCH RATE-LIMIT PAUSE ──────────────────────────────────

console.log('\n13. Batch rate-limit pause');

try {
  const tmp = mkdtempSync(join(tmpdir(), 'co-batch-rate-'));
  const batchDir = join(tmp, 'batch');
  const fakeBin = join(tmp, 'bin');
  mkdirSync(batchDir, { recursive: true });
  mkdirSync(join(tmp, 'reports'), { recursive: true });
  mkdirSync(join(tmp, 'data'), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });

  writeFileSync(join(batchDir, 'batch-runner.sh'), readFileSync(join(ROOT, 'batch/batch-runner.sh'), 'utf-8').replace(/\r\n/g, '\n'));
  if (process.platform === 'win32') {
    try { execFileSync(getBash(), ['-c', 'chmod +x batch/batch-runner.sh'], { cwd: tmp }); } catch {}
  } else {
    execFileSync('chmod', ['+x', join(batchDir, 'batch-runner.sh')]);
  }
  writeFileSync(join(tmp, 'merge-tracker.mjs'), 'console.log("merge fixture");\n');
  writeFileSync(join(tmp, 'verify-pipeline.mjs'), 'console.log("verify fixture");\n');
  // The runner stops an offer whose report-number reservation returns nothing,
  // so the fixture has to hand out a number for the worker to be launched.
  writeFileSync(join(tmp, 'reserve-report-num.mjs'), 'console.log("001");\n');
  writeFileSync(join(batchDir, 'batch-prompt.md'), 'URL={{URL}}\nJD={{JD_FILE}}\nREPORT={{REPORT_NUM}}\n');
  writeFileSync(join(batchDir, 'batch-input.tsv'), [
    'id\turl\tsource\tnotes',
    '1\thttps://example.com/one\tfixture\t-',
    '2\thttps://example.com/two\tfixture\t-',
    '3\thttps://example.com/three\tfixture\t-',
  ].join('\n') + '\n');
  writeFileSync(join(fakeBin, 'claude'), [
    '#!/usr/bin/env bash',
    'echo "You\\x27ve hit your session limit · resets 12:30pm (Asia/Taipei)"',
    'exit 1',
  ].join('\n') + '\n');
  // The runner now prefetches JDs with curl. Keep this offline fixture
  // deterministic and exercise the existing WebFetch fallback instead of
  // waiting on a public example.com request.
  writeFileSync(join(fakeBin, 'curl'), '#!/usr/bin/env bash\nexit 1\n');
  if (process.platform === 'win32') {
    try { execFileSync(getBash(), ['-c', 'chmod +x bin/claude bin/curl'], { cwd: tmp }); } catch {}
  } else {
    execFileSync('chmod', ['+x', join(fakeBin, 'claude'), join(fakeBin, 'curl')]);
  }

  const env = { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH}` };
  const out = run(getBash(), [toBashPath(join(batchDir, 'batch-runner.sh')), '--parallel', '1', '--max-retries', '3', '--rate-limit-sleep', '0'], {
    cwd: tmp,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) || '';
  const state = readFileSync(join(batchDir, 'batch-state.tsv'), 'utf-8').trim().split('\n');
  const first = state[1]?.split('\t') || [];

  if (state.length === 2 && first[0] === '1' && first[2] === 'paused_rate_limit' && first[8] === '0') {
    pass('session-limit pauses batch without consuming retry budget or scheduling more jobs');
  } else {
    fail(`session-limit pause wrong: lines=${state.length}, first=${JSON.stringify(first)}, out=${JSON.stringify(out.slice(-240))}`);
  }

  writeFileSync(join(batchDir, 'batch-state.tsv'), [
    'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries',
    '1\thttps://example.com/one\tpaused_rate_limit\t2026-01-01T00:00:00Z\t2026-01-01T00:00:01Z\t001\t-\tsession-limit; paused\t0',
    '2\thttps://example.com/two\tfailed\t2026-01-01T00:00:00Z\t2026-01-01T00:00:01Z\t002\t-\tworker-crash\t1',
  ].join('\n') + '\n');
  const dry = run(getBash(), [toBashPath(join(batchDir, 'batch-runner.sh')), '--resume-paused', '--dry-run'], {
    cwd: tmp,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) || '';
  if (dry.includes('#1: https://example.com/one') && !dry.includes('#2: https://example.com/two')) {
    pass('--resume-paused dry-run selects paused jobs only');
  } else {
    fail(`--resume-paused selection wrong: ${dry}`);
  }

  rmSync(join(batchDir, 'batch-input.tsv'), { force: true });
  rmSync(join(batchDir, 'batch-prompt.md'), { force: true });
  rmSync(join(fakeBin, 'claude'), { force: true });
  writeFileSync(join(batchDir, 'batch-state.tsv'), [
    'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries',
    '1\thttps://example.com/one\tcompleted\t2026-01-01T00:00:00Z\t2026-01-01T00:00:01Z\t001\t4.5\t-\t0',
    '2\thttps://example.com/two\tcompleted\t2026-01-01T00:00:00Z\t2026-01-01T00:00:01Z\t002\tbad);system("oops")\t-\t0',
    '3\thttps://example.com/three\tskipped\t2026-01-01T00:00:00Z\t2026-01-01T00:00:01Z\t003\t3.5\tbelow-min-score\t0',
  ].join('\n') + '\n');
  const statusOnly = run(getBash(), [toBashPath(join(batchDir, 'batch-runner.sh')), '--status'], {
    cwd: tmp,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) || '';
  if (statusOnly.includes('Average score: 4.5/5 (1 scored)') && statusOnly.includes('bad);system("oops")')) {
    pass('--status reads existing state without full batch prerequisites');
  } else {
    fail(`--status prerequisite/score handling wrong: ${statusOnly}`);
  }

  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
} catch (e) {
  fail(`Batch rate-limit pause test crashed: ${e.message}`);
}

// ── 13b. RECOVERY-RECORD RECONCILE MUST NOT ROLL BACK TERMINAL ROWS ──

console.log('\n13b. Recovery-record reconcile vs terminal state');

try {
  const tmp = mkdtempSync(join(tmpdir(), 'co-batch-recon-'));
  const batchDir = join(tmp, 'batch');
  const recoveryDir = join(batchDir, 'batch-state-recovery.d');
  const fakeBin = join(tmp, 'bin');
  mkdirSync(recoveryDir, { recursive: true });
  mkdirSync(join(tmp, 'reports'), { recursive: true });
  mkdirSync(join(tmp, 'data'), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });

  writeFileSync(join(batchDir, 'batch-runner.sh'), readFileSync(join(ROOT, 'batch/batch-runner.sh'), 'utf-8').replace(/\r\n/g, '\n'));
  if (process.platform === 'win32') {
    try { execFileSync(getBash(), ['-c', 'chmod +x batch/batch-runner.sh'], { cwd: tmp }); } catch {}
  } else {
    execFileSync('chmod', ['+x', join(batchDir, 'batch-runner.sh')]);
  }
  writeFileSync(join(tmp, 'merge-tracker.mjs'), 'console.log("merge fixture");\n');
  writeFileSync(join(tmp, 'verify-pipeline.mjs'), 'console.log("verify fixture");\n');
  writeFileSync(join(batchDir, 'batch-prompt.md'), 'URL={{URL}}\nJD={{JD_FILE}}\nREPORT={{REPORT_NUM}}\n');
  writeFileSync(join(batchDir, 'batch-input.tsv'), [
    'id\turl\tsource\tnotes',
    '42\thttps://example.com/forty-two\tfixture\t-',
  ].join('\n') + '\n');

  // The offer already reached a terminal state, with a score and a
  // completion timestamp worth protecting.
  writeFileSync(join(batchDir, 'batch-state.tsv'), [
    'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries',
    '42\thttps://example.com/forty-two\tcompleted\t2026-08-07T00:00:00Z\t2026-08-07T00:05:00Z\t900\t8.5\t\t1',
  ].join('\n') + '\n');

  // A recovery record written EARLIER, while the lock was jammed, carrying
  // the pre-success rate_limited transition. Merging it blindly would drop
  // the score and re-queue the offer (rate_limited is not terminal).
  writeFileSync(join(recoveryDir, 'rec-stale1'),
    '42\thttps://example.com/forty-two\trate_limited\t2026-08-07T00:00:00Z\t\t900\t-\trate limited\t1\n');

  // check_prerequisites() aborts main() with "claude CLI not found" before
  // reconcile_recovery_records() runs when `claude` is absent from PATH, which
  // is the case on CI runners. Stub it (offer 42 is terminal, so no worker ever
  // invokes it) so the reconcile path is actually exercised, matching test 13.
  writeFileSync(join(fakeBin, 'claude'), '#!/usr/bin/env bash\nexit 0\n');
  if (process.platform === 'win32') {
    try { execFileSync(getBash(), ['-c', 'chmod +x bin/claude'], { cwd: tmp }); } catch {}
  } else {
    execFileSync('chmod', ['+x', join(fakeBin, 'claude')]);
  }

  run(getBash(), [toBashPath(join(batchDir, 'batch-runner.sh')), '--parallel', '1', '--rate-limit-sleep', '0'], {
    cwd: tmp,
    env: { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stateLines = readFileSync(join(batchDir, 'batch-state.tsv'), 'utf-8').trim().split('\n');
  const row = (stateLines.find(l => l.startsWith('42\t')) || '').split('\t');
  const [, , rowStatus, , rowCompleted, , rowScore] = row;

  if (rowStatus === 'completed' && rowScore === '8.5' && rowCompleted === '2026-08-07T00:05:00Z') {
    pass('reconcile leaves a terminal row intact when the recovery record is older');
  } else {
    fail(`reconcile rolled back a terminal row: status=${rowStatus} score=${rowScore} completed=${rowCompleted}`);
  }

  if (!existsSync(join(recoveryDir, 'rec-stale1'))) {
    pass('reconcile discards the superseded recovery record instead of retrying it every run');
  } else {
    fail('superseded recovery record was left in place — it would retry the rollback on every subsequent run');
  }

  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
} catch (e) {
  fail(`Recovery-record reconcile test crashed: ${e.message}`);
}

// ── 13c. RECOVERY-RECORD RECONCILE MUST NOT SHIFT FIELDS ON EMPTY COLUMNS ──

console.log('\n13c. Recovery-record reconcile field alignment (empty interior columns)');

try {
  const tmp = mkdtempSync(join(tmpdir(), 'co-batch-recon2-'));
  const batchDir = join(tmp, 'batch');
  const recoveryDir = join(batchDir, 'batch-state-recovery.d');
  const fakeBin = join(tmp, 'bin');
  mkdirSync(recoveryDir, { recursive: true });
  mkdirSync(join(tmp, 'reports'), { recursive: true });
  mkdirSync(join(tmp, 'data'), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });

  writeFileSync(join(batchDir, 'batch-runner.sh'), readFileSync(join(ROOT, 'batch/batch-runner.sh'), 'utf-8').replace(/\r\n/g, '\n'));
  if (process.platform === 'win32') {
    try { execFileSync(getBash(), ['-c', 'chmod +x batch/batch-runner.sh'], { cwd: tmp }); } catch {}
  } else {
    execFileSync('chmod', ['+x', join(batchDir, 'batch-runner.sh')]);
  }
  writeFileSync(join(tmp, 'merge-tracker.mjs'), 'console.log("merge fixture");\n');
  writeFileSync(join(tmp, 'verify-pipeline.mjs'), 'console.log("verify fixture");\n');
  writeFileSync(join(batchDir, 'batch-prompt.md'), 'URL={{URL}}\nJD={{JD_FILE}}\nREPORT={{REPORT_NUM}}\n');
  // Same claude stub as test 13/13b: check_prerequisites() aborts before
  // reconcile runs when claude is absent (CI has no claude). Offer 42 is
  // terminal, so no worker invokes it.
  writeFileSync(join(fakeBin, 'claude'), '#!/usr/bin/env bash\nexit 0\n');
  if (process.platform === 'win32') {
    try { execFileSync(getBash(), ['-c', 'chmod +x bin/claude'], { cwd: tmp }); } catch {}
  } else {
    execFileSync('chmod', ['+x', join(fakeBin, 'claude')]);
  }
  // Only a terminal offer is in the input, so main() processes nothing and the
  // merged row below is written solely by reconcile_recovery_records().
  writeFileSync(join(batchDir, 'batch-input.tsv'), [
    'id\turl\tsource\tnotes',
    '42\thttps://example.com/forty-two\tfixture\t-',
  ].join('\n') + '\n');

  // Offer 99 is NON-terminal (failed), so its recovery record takes the merge
  // path (not the superseded path). The record has an empty completed_at
  // (column 5) and an empty score (column 7) — exactly the interior columns a
  // tab-collapsing `IFS=$'\t' read` would drop, shifting every later field left.
  writeFileSync(join(batchDir, 'batch-state.tsv'), [
    'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries',
    '42\thttps://example.com/forty-two\tcompleted\t2026-08-07T00:00:00Z\t2026-08-07T00:05:00Z\t900\t8.5\t\t1',
    '99\thttps://example.com/99\tfailed\t2026-08-06T00:00:00Z\t\t800\t\tolderr\t1',
  ].join('\n') + '\n');
  writeFileSync(join(recoveryDir, 'rec-shift1'),
    '99\thttps://example.com/99\tfailed\t2026-08-07T09:00:00Z\t\t901\t\trate limited\t2\n');

  run(getBash(), [toBashPath(join(batchDir, 'batch-runner.sh')), '--parallel', '1', '--rate-limit-sleep', '0'], {
    cwd: tmp,
    env: { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stateLines = readFileSync(join(batchDir, 'batch-state.tsv'), 'utf-8').trim().split('\n');
  const row = (stateLines.find(l => l.startsWith('99\t')) || '').split('\t');
  const [, , status99, , completed99, report99, score99, error99, retries99] = row;

  if (status99 === 'failed' && completed99 === '' && report99 === '901' && score99 === '' && error99 === 'rate limited' && retries99 === '2') {
    pass('reconcile merges a record with empty interior columns without shifting fields');
  } else {
    fail(`reconcile shifted fields on empty columns: status=${status99} completed_at=${completed99} report=${report99} score=${score99} error=${error99} retries=${retries99}`);
  }

  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
} catch (e) {
  fail(`Recovery-record field-alignment test crashed: ${e.message}`);
}

// ── 14. BATCH SPEND TIER MODEL ROUTING ───────────────────────────

console.log('\n14. Batch spend_tier model routing');

// Helper: create a fully isolated tmp fixture for one spend_tier sub-test.
// Each sub-test gets its own mkdtempSync so no batch-state.tsv from a prior
// sub-test can bleed in, regardless of OS-level I/O ordering on CI runners.
function makeTierFixture(profileYml) {
  const tmp = mkdtempSync(join(tmpdir(), 'co-batch-tier-'));
  const batchDir = join(tmp, 'batch');
  const fakeBin = join(tmp, 'bin');
  const configDir = join(tmp, 'config');
  mkdirSync(batchDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(tmp, 'reports'), { recursive: true });
  mkdirSync(join(tmp, 'data'), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });

  writeFileSync(join(batchDir, 'batch-runner.sh'), readFileSync(join(ROOT, 'batch/batch-runner.sh'), 'utf-8').replace(/\r\n/g, '\n'));
  if (process.platform === 'win32') {
    try { execFileSync(getBash(), ['-c', 'chmod +x batch/batch-runner.sh'], { cwd: tmp }); } catch {}
  } else {
    execFileSync('chmod', ['+x', join(batchDir, 'batch-runner.sh')]);
  }
  writeFileSync(join(tmp, 'merge-tracker.mjs'), 'console.log("merge fixture");\n');
  writeFileSync(join(tmp, 'verify-pipeline.mjs'), 'console.log("verify fixture");\n');
  // The runner stops an offer whose report-number reservation returns nothing,
  // so the fixture has to hand out a number for the worker to be launched.
  writeFileSync(join(tmp, 'reserve-report-num.mjs'), 'console.log("001");\n');
  writeFileSync(join(batchDir, 'batch-prompt.md'), 'URL={{URL}}\nJD={{JD_FILE}}\nREPORT={{REPORT_NUM}}\n');
  writeFileSync(join(batchDir, 'batch-input.tsv'), [
    'id\turl\tsource\tnotes',
    '1\thttps://example.com/one\tfixture\t-',
  ].join('\n') + '\n');
  writeFileSync(join(configDir, 'profile.yml'), profileYml);
  writeFileSync(join(fakeBin, 'claude'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$@" > "$BATCH_ARG_FILE"',
    'exit 0',
  ].join('\n') + '\n');
  // This fixture tests worker/model routing, not network access. Make the
  // runner's optional JD prefetch fail fast and use its fallback path.
  writeFileSync(join(fakeBin, 'curl'), '#!/usr/bin/env bash\nexit 1\n');
  if (process.platform === 'win32') {
    try { execFileSync(getBash(), ['-c', 'chmod +x bin/claude bin/curl'], { cwd: tmp }); } catch {}
  } else {
    execFileSync('chmod', ['+x', join(fakeBin, 'claude'), join(fakeBin, 'curl')]);
  }
  return { tmp, batchDir, fakeBin };
}

// economy tier
try {
  const { tmp, batchDir, fakeBin } = makeTierFixture('spend_tier: economy\n');
  const argFile = join(tmp, 'claude-argv.txt');
  const env = { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH}`, BATCH_ARG_FILE: argFile };
  const out = run(getBash(), [toBashPath(join(batchDir, 'batch-runner.sh')), '--parallel', '1'], { cwd: tmp, env, stdio: ['pipe', 'pipe', 'pipe'] }) || '';
  const argv = existsSync(argFile) ? readFileSync(argFile, 'utf-8') : '';
  if (argv.includes('--model') && argv.includes('claude-haiku-5-5') && out.includes('spend_tier=economy')) {
    pass('economy spend_tier resolves to claude-haiku-5-5');
  } else {
    fail(`economy spend_tier did not route to haiku: argv=${JSON.stringify(argv)}, out=${JSON.stringify(out.slice(-240))}`);
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
} catch (e) { fail(`Batch spend_tier routing test crashed (economy): ${e.message}`); }

// premium tier
try {
  const { tmp, batchDir, fakeBin } = makeTierFixture('spend_tier: premium\n');
  const argFile = join(tmp, 'claude-argv.txt');
  const env = { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH}`, BATCH_ARG_FILE: argFile };
  const premiumOut = run(getBash(), [toBashPath(join(batchDir, 'batch-runner.sh')), '--parallel', '1'], { cwd: tmp, env, stdio: ['pipe', 'pipe', 'pipe'] }) || '';
  const premiumArgv = existsSync(argFile) ? readFileSync(argFile, 'utf-8') : '';
  if (premiumArgv.includes('--model') && premiumArgv.includes('claude-opus-5-5') && premiumOut.includes('spend_tier=premium')) {
    pass('premium spend_tier resolves to claude-opus-5-5');
  } else {
    fail(`premium spend_tier did not route to opus: argv=${JSON.stringify(premiumArgv)}, out=${JSON.stringify(premiumOut.slice(-240))}`);
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
} catch (e) { fail(`Batch spend_tier routing test crashed (premium): ${e.message}`); }

// --model override takes precedence over spend_tier
try {
  const { tmp, batchDir, fakeBin } = makeTierFixture('spend_tier: premium\n');
  const argFile = join(tmp, 'claude-argv.txt');
  const env = { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH}`, BATCH_ARG_FILE: argFile };
  const overrideOut = run(getBash(), [toBashPath(join(batchDir, 'batch-runner.sh')), '--parallel', '1', '--model', 'claude-sonnet-5-5'], { cwd: tmp, env, stdio: ['pipe', 'pipe', 'pipe'] }) || '';
  const overrideArgv = existsSync(argFile) ? readFileSync(argFile, 'utf-8') : '';
  if (overrideArgv.includes('--model') && overrideArgv.includes('claude-sonnet-5-5') && !overrideArgv.includes('claude-opus-5-5') && overrideOut.includes('explicit --model override')) {
    pass('--model override takes precedence over spend_tier');
  } else {
    fail(`--model override did not win: argv=${JSON.stringify(overrideArgv)}, out=${JSON.stringify(overrideOut.slice(-240))}`);
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
} catch (e) { fail(`Batch spend_tier routing test crashed (--model override): ${e.message}`); }

// missing spend_tier key defaults to standard
try {
  const { tmp, batchDir, fakeBin } = makeTierFixture('# no spend_tier key\nname: test\n');
  const argFile = join(tmp, 'claude-argv.txt');
  const env = { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH}`, BATCH_ARG_FILE: argFile };
  const standardDefaultOut = run(getBash(), [toBashPath(join(batchDir, 'batch-runner.sh')), '--parallel', '1'], { cwd: tmp, env, stdio: ['pipe', 'pipe', 'pipe'] }) || '';
  const standardDefaultArgv = existsSync(argFile) ? readFileSync(argFile, 'utf-8') : '';
  if (standardDefaultArgv.includes('--model') && standardDefaultArgv.includes('claude-sonnet-5-5') && standardDefaultOut.includes('spend_tier=standard')) {
    pass('missing spend_tier key defaults to standard tier (claude-sonnet-5-5)');
  } else {
    fail(`missing spend_tier did not default to standard: argv=${JSON.stringify(standardDefaultArgv)}, out=${JSON.stringify(standardDefaultOut.slice(-240))}`);
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
} catch (e) { fail(`Batch spend_tier routing test crashed (missing key): ${e.message}`); }

// invalid spend_tier value falls back to standard with a warning
try {
  const { tmp, batchDir, fakeBin } = makeTierFixture('spend_tier: turbo\n');
  const argFile = join(tmp, 'claude-argv.txt');
  const env = { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH}`, BATCH_ARG_FILE: argFile };
  const invalidTierOut = run(getBash(), [toBashPath(join(batchDir, 'batch-runner.sh')), '--parallel', '1'], { cwd: tmp, env, stdio: ['pipe', 'pipe', 'pipe'] }) || '';
  const invalidTierArgv = existsSync(argFile) ? readFileSync(argFile, 'utf-8') : '';
  if (invalidTierArgv.includes('--model') && invalidTierArgv.includes('claude-sonnet-5-5') && invalidTierOut.includes('spend_tier=standard')) {
    pass('invalid spend_tier value falls back to standard tier (claude-sonnet-5-5)');
  } else {
    fail(`invalid spend_tier did not fall back to standard: argv=${JSON.stringify(invalidTierArgv)}, out=${JSON.stringify(invalidTierOut.slice(-240))}`);
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
} catch (e) { fail(`Batch spend_tier routing test crashed (invalid value): ${e.message}`); }

// ── 14b. BATCH PRE-SCREEN DISCARD LOG ────────────────────────────

console.log('\n14b. Batch pre-screen discard log (log_discard helper)');

try {
  const tmp = mkdtempSync(join(tmpdir(), 'co-batch-discard-'));
  const batchDir = join(tmp, 'batch');
  mkdirSync(batchDir, { recursive: true });

  const runnerSrc = readFileSync(join(ROOT, 'batch/batch-runner.sh'), 'utf-8').replace(/\r\n/g, '\n');
  if (!runnerSrc.includes('log_discard()')) {
    fail('batch-runner.sh is missing the log_discard() helper required for the auditable discard log');
  } else {
    // Source only the function definitions (guard against `main "$@"` running)
    // by stripping the trailing invocation line, then call log_discard directly.
    const sourceable = runnerSrc.replace(/\nmain "\$@"\s*$/, '\n');
    writeFileSync(join(batchDir, 'batch-runner.lib.sh'), sourceable);
    const script = [
      'set -euo pipefail',
      `source "${toBashPath(join(batchDir, 'batch-runner.lib.sh'))}"`,
      'log_discard "7" "https://example.com/mismatch" "wrong seniority band"',
      `cat "${toBashPath(join(batchDir, 'logs', 'discard.log'))}"`,
    ].join('\n');
    const out = run(getBash(), ['-c', script], { cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'] }) || '';
    const line = out.trim().split('\n').pop() || '';
    const cols = line.split('\t');

    if (
      cols.length === 4 &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(cols[0]) &&
      cols[1] === '7' &&
      cols[2] === 'https://example.com/mismatch' &&
      cols[3] === 'wrong seniority band'
    ) {
      pass('log_discard appends a one-line, auditable {timestamp, id, url, reason} record to batch/logs/discard.log');
    } else {
      fail(`log_discard output malformed: ${JSON.stringify(out)}`);
    }
  }

  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
} catch (e) {
  fail(`Batch pre-screen discard log test crashed: ${e.message}`);
}

// ── 15. BATCH RUNNER MCP ISOLATION (#506) ───────────────────────

console.log('\n15. Batch runner MCP isolation');

try {
  const batchRunner = readFileSync(join(ROOT, 'batch', 'batch-runner.sh'), 'utf-8');
  // Workers must be spawned with --strict-mcp-config so they don't inherit the
  // parent session's MCP servers (e.g. Playwright) and deadlock fighting over a
  // single browser when --parallel > 1 (issue #506).
  const claudeArgsLine = batchRunner
    .split('\n')
    .find(l => l.includes('claude_args=('));
  if (claudeArgsLine && claudeArgsLine.includes('--strict-mcp-config')) {
    pass('batch workers spawn with --strict-mcp-config (no inherited MCP)');
  } else {
    fail('batch-runner.sh worker spawn missing --strict-mcp-config (issue #506 regression)');
  }
} catch (e) {
  fail(`Batch runner MCP isolation test crashed: ${e.message}`);
}

// ── 19. FONT INLINING (#951) ────────────────────────────────────

console.log('\n19. Font inlining (data: URLs, #951)');

try {
  // Importing must not trigger the CLI (the import.meta.url guard); it
  // exposes inlineLocalFonts, which renderHtmlToPdf runs before setContent.
  const { inlineLocalFonts } = await import(pathToFileURL(join(ROOT, 'generate-pdf.mjs')).href);

  // Chromium blocks file:// subresources from setContent() pages (the page
  // stays at about:blank), so ./fonts refs must become data: URLs (#951).
  // Not a `__…` name: tests/generate-pdf-font-cache.test.mjs keeps probe
  // files called that in fonts/ while it runs, which can be during this
  // section (#5146), and one of those is gone again a moment later.
  const fontFile = readdirSync(join(ROOT, 'fonts')).find(f => f.endsWith('.woff2') && !f.startsWith('__'));
  const inlined = await inlineLocalFonts(
    `<style>@font-face { src: url('./fonts/${fontFile}') format('woff2'); }</style>`
  );
  if (inlined.includes('data:font/woff2;base64,') && !inlined.includes('./fonts/')) {
    pass('local ./fonts references are inlined as data: URLs');
  } else {
    fail('./fonts reference was not inlined as a data: URL — fonts will silently fall back (#951)');
  }

  // A missing font file must not corrupt the HTML or throw.
  const missing = await inlineLocalFonts(`<style>src: url('./fonts/does-not-exist.woff2');</style>`);
  if (missing.includes(`url('./fonts/does-not-exist.woff2')`)) {
    pass('missing font files keep their original reference');
  } else {
    fail('missing font file mangled the url() reference');
  }

  // Traversal outside fonts/ must never be inlined — neither via ".."
  // segments nor via absolute names (resolve() returns those verbatim).
  const traversal = await inlineLocalFonts(`<style>src: url('./fonts/../cv.md');</style>`);
  if (traversal.includes(`url('./fonts/../cv.md')`)) {
    pass('path traversal outside fonts/ is not inlined');
  } else {
    fail('path traversal escaped the fonts/ directory');
  }
  const absolute = await inlineLocalFonts(`<style>src: url('./fonts//etc/passwd');</style>`);
  if (absolute.includes(`url('./fonts//etc/passwd')`)) {
    pass('absolute-path escape (./fonts//etc/passwd) is not inlined');
  } else {
    fail('absolute-path reference escaped the fonts/ directory');
  }
} catch (e) {
  fail(`font inlining test crashed: ${e.message}`);
}

// ── 20. LATEX VALIDATOR I18N ────────────────────────────────────

console.log('\n20. LaTeX validator i18n (localized sections + CJK guard)');

// Run generate-latex.mjs and return its JSON report, capturing stdout even
// when it exits non-zero (validation issues exit 1 but still print the report).
function latexValidate(tex) {
  const dir = mkdtempSync(join(tmpdir(), 'latex-i18n-'));
  const texPath = join(dir, 'cv.tex');
  writeFileSync(texPath, tex, 'utf-8');
  let out;
  try {
    out = execFileSync(NODE, ['generate-latex.mjs', texPath], { cwd: ROOT, encoding: 'utf-8', timeout: 30000 });
  } catch (e) {
    out = (e.stdout || '').toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  try { return JSON.parse(out); } catch { return null; }
}

const baseTex = (sectionTitle) => `\\documentclass{article}
\\pdfgentounicode=1
\\begin{document}
\\section{${sectionTitle}}
\\section{Experiencia}
\\section{Proyectos}
\\section{Habilidades}
\\resumeSubheading
\\resumeItem
\\resumeProjectHeading
\\end{document}
`;

try {
  // Localized (Spanish) section titles must not trigger a "Missing section".
  const localized = latexValidate(baseTex('Educación'));
  if (localized && !localized.issues.some((i) => /section/i.test(i))) {
    pass('localized section titles validate (no spurious "Missing section")');
  } else {
    fail(`localized section titles wrongly flagged: ${JSON.stringify(localized && localized.issues)}`);
  }

  // Too few sections must still be flagged.
  const tooFew = latexValidate(`\\documentclass{article}
\\pdfgentounicode=1
\\begin{document}
\\section{Education}
\\resumeSubheading
\\resumeItem
\\resumeProjectHeading
\\end{document}
`);
  if (tooFew && tooFew.issues.some((i) => /at least 4/i.test(i))) {
    pass('fewer than 4 sections is still flagged');
  } else {
    fail('section-count check did not flag a CV with too few sections');
  }

  // CJK content must be rejected with actionable guidance when no CJK-capable
  // engine/template is in play (pdflatex-only, or no engine resolved at all —
  // whatever this CI box actually has on PATH).
  const cjk = latexValidate(baseTex('職務経歴'));
  if (cjk && cjk.issues.some((i) => /CJK/.test(i)) && cjk.valid === false) {
    pass('CJK content is rejected with guidance to use pdf mode');
  } else {
    fail(`CJK content was not rejected with guidance: ${JSON.stringify(cjk && cjk.issues)}`);
  }
} catch (e) {
  fail(`LaTeX validator i18n test crashed: ${e.message}`);
}

// ── 20a. LATEX CJK TEMPLATE (tectonic path, #3553) ──────────────
// This drives validateLatexContent() directly with a forced `engine` value
// so the tectonic-vs-pdflatex branch is deterministic regardless of what
// LaTeX engine (if any) is actually installed on the machine running the
// suite — see generate-latex.mjs's resolveLatexEngine()/CJK_PACKAGE_RE.

console.log('\n20a. LaTeX CJK template (tectonic engine path)');

try {
  const { validateLatexContent } = await import(pathToFileURL(join(ROOT, 'generate-latex.mjs')).href);

  const cjkTemplatePath = join(ROOT, 'templates', 'cv-template.cjk.tex');
  if (fileExists(join('templates', 'cv-template.cjk.tex'))) {
    pass('templates/cv-template.cjk.tex exists');
  } else {
    fail('templates/cv-template.cjk.tex is missing');
  }
  const cjkTemplateSrc = existsSync(cjkTemplatePath) ? readFileSync(cjkTemplatePath, 'utf-8') : '';
  if (/\\usepackage\{fontspec\}/.test(cjkTemplateSrc) && /\\usepackage\{xeCJK\}/.test(cjkTemplateSrc) && /\\setCJKmainfont\{/.test(cjkTemplateSrc)) {
    pass('cv-template.cjk.tex loads fontspec + xeCJK + a CJK main font');
  } else {
    fail('cv-template.cjk.tex is missing fontspec/xeCJK/\\setCJKmainfont');
  }
  // Same required commands/placeholders as the base template — it must stay
  // a drop-in variant, not a divergent structure.
  const requiredTokens = ['\\resumeSubheading', '\\resumeItem', '\\resumeProjectHeading', '{{NAME}}', '{{EDUCATION}}', '{{EXPERIENCE}}', '{{PROJECTS}}', '{{AWARDS}}', '{{SKILLS}}'];
  const missingTokens = requiredTokens.filter((t) => !cjkTemplateSrc.includes(t));
  if (cjkTemplateSrc && missingTokens.length === 0) {
    pass('cv-template.cjk.tex keeps the same required commands/placeholders as the base template');
  } else {
    fail(`cv-template.cjk.tex is missing tokens: ${JSON.stringify(missingTokens)}`);
  }

  const cjkFilledTemplate = () => cjkTemplateSrc
    .replace(/\{\{NAME\}\}/g, 'Test Candidate')
    .replace(/\{\{CONTACT_LINE\}\}/g, 'Toronto, ON')
    .replace(/\{\{EMAIL_URL\}\}/g, 'test@example.com')
    .replace(/\{\{EMAIL_DISPLAY\}\}/g, 'test@example.com')
    .replace(/\{\{LINKEDIN_URL\}\}/g, 'https://linkedin.com/in/test')
    .replace(/\{\{LINKEDIN_DISPLAY\}\}/g, 'linkedin.com/in/test')
    .replace(/\{\{GITHUB_URL\}\}/g, 'https://github.com/test')
    .replace(/\{\{GITHUB_DISPLAY\}\}/g, 'github.com/test')
    .replace(/\{\{EDUCATION\}\}/g, '    \\resumeSubheading\n      {示例大学}{Toronto, ON}\n      {计算机科学硕士学位}{2023 - 2025}')
    .replace(/\{\{EXPERIENCE\}\}/g, '    \\resumeSubheading\n      {示例公司}{2022 - Present}\n      {软件工程师}{Remote}\n      \\resumeItemListStart\n            \\resumeItem{设计并交付了多个内部工具}\n      \\resumeItemListEnd')
    .replace(/\{\{PROJECTS\}\}/g, '    \\resumeProjectHeading\n      {\\textbf{示例项目}}{2024}\n      \\resumeItemListStart\n            \\resumeItem{构建了一个交互式数据分析平台}\n      \\resumeItemListEnd')
    .replace(/\{\{AWARDS\}\}/g, '    \\resumeProjectHeading\n      {\\textbf{优秀毕业生奖}}{2024}')
    .replace(/\{\{SKILLS\}\}/g, '        \\textbf{语言}{: 中文，英语} \\\\');

  // A CJK-filled cv-template.cjk.tex, resolved to tectonic, must NOT be
  // blocked — the whole point of #3553 is that this path now compiles.
  const filled = cjkFilledTemplate();
  const tectonicCjk = validateLatexContent(filled, false, 'tectonic');
  if (tectonicCjk.issues.length === 0) {
    pass('CJK content + xeCJK template + tectonic engine validates clean (no CJK block)');
  } else {
    fail(`CJK content + xeCJK template + tectonic engine was unexpectedly blocked: ${JSON.stringify(tectonicCjk.issues)}`);
  }

  // CJK content on tectonic WITHOUT the CJK package loaded (e.g. someone
  // pastes CJK text into the base cv-template.tex) must still be blocked,
  // but with guidance pointing at --template=cjk instead of only "use pdf mode".
  const baseTemplateWithCjk = baseTex('職務経歴');
  const tectonicNoPackage = validateLatexContent(baseTemplateWithCjk, false, 'tectonic');
  if (tectonicNoPackage.issues.some((i) => /CJK/.test(i) && /--template=cjk/.test(i))) {
    pass('CJK content on tectonic without xeCJK/ctex loaded is blocked with --template=cjk guidance');
  } else {
    fail(`CJK content on tectonic without CJK package was not blocked with the expected guidance: ${JSON.stringify(tectonicNoPackage.issues)}`);
  }

  // The pdflatex-only guard must not regress: even the CJK-aware template
  // (xeCJK loaded) stays blocked when the resolved engine is pdflatex, since
  // pdflatex has no Unicode/CJK font support regardless of packages loaded.
  const pdflatexCjk = validateLatexContent(filled, false, 'pdflatex');
  if (pdflatexCjk.issues.some((i) => /CJK/.test(i))) {
    pass('CJK content stays blocked on pdflatex even with the CJK template (pdflatex cannot render CJK)');
  } else {
    fail(`CJK content should stay blocked on pdflatex: ${JSON.stringify(pdflatexCjk.issues)}`);
  }

  // No engine resolved at all (engine=null) — same as the pre-#3553 default.
  const noEngineCjk = validateLatexContent(filled, false, null);
  if (noEngineCjk.issues.some((i) => /CJK/.test(i))) {
    pass('CJK content stays blocked when no LaTeX engine is resolved');
  } else {
    fail(`CJK content should stay blocked with no engine resolved: ${JSON.stringify(noEngineCjk.issues)}`);
  }

  // Supplementary-plane ideographs (CJK Unified Ideographs Extension B and
  // later, e.g. U+20000) must be caught too, not just the BMP ranges — a
  // codepoint-range regex without the `u` flag only ever sees lone UTF-16
  // surrogate halves for these and silently misses them (CodeRabbit finding).
  const supplementaryChar = String.fromCodePoint(0x20000);
  const supplementaryCjk = validateLatexContent(baseTex(supplementaryChar), false, null);
  if (supplementaryCjk.issues.some((i) => /CJK/.test(i))) {
    pass('supplementary-plane CJK ideograph (U+20000) is detected, not just BMP CJK');
  } else {
    fail(`supplementary-plane CJK ideograph (U+20000) was not detected: ${JSON.stringify(supplementaryCjk.issues)}`);
  }

  // CJK_PACKAGE_RE must recognize xeCJK/ctex as part of a comma-separated
  // \usepackage list, not only as the package's sole argument.
  const listFormTex = baseTex('職務経歴').replace('\\documentclass{article}', '\\documentclass{article}\n\\usepackage{fontspec,xeCJK}');
  const listFormResult = validateLatexContent(listFormTex, false, 'tectonic');
  if (listFormResult.issues.length === 0) {
    pass('\\usepackage{fontspec,xeCJK} (comma-separated list) is recognized as loading xeCJK');
  } else {
    fail(`comma-separated \\usepackage list with xeCJK was not recognized: ${JSON.stringify(listFormResult.issues)}`);
  }

  // CJK_PACKAGE_RE must also recognize the ctex bundle's own document classes
  // (ctexart/ctexrep/ctexbook), which auto-configure CJK support without a
  // separate \usepackage{xeCJK} line.
  const ctexClassTex = baseTex('職務経歴').replace('\\documentclass{article}', '\\documentclass[fontset=windows]{ctexart}');
  const ctexClassResult = validateLatexContent(ctexClassTex, false, 'tectonic');
  if (ctexClassResult.issues.length === 0) {
    pass('\\documentclass{ctexart} (ctex document class) is recognized as CJK-capable');
  } else {
    fail(`ctex document class was not recognized as CJK-capable: ${JSON.stringify(ctexClassResult.issues)}`);
  }
} catch (e) {
  fail(`LaTeX CJK template test crashed: ${e.message}`);
}

// ── 20b. LATEX-TEX IN-PLACE TAILORING ───────────────────────────

console.log('\n20b. LaTeX-tex in-place tailoring (extract / patch / compile-only)');

try {
  const { detectFamily, buildManifest, applyPatches } = await import(pathToFileURL(join(ROOT, 'lib/latex-content.mjs')).href);
  const { validateLatexContent } = await import(pathToFileURL(join(ROOT, 'generate-latex.mjs')).href);

  const resumeFixture = readFileSync(join(ROOT, 'examples/latex-tex/resume-subheading.tex'), 'utf-8');
  const tabularFixture = readFileSync(join(ROOT, 'examples/latex-tex/tabularx-itemize.tex'), 'utf-8');

  if (detectFamily(resumeFixture) === 'resumeSubheading') {
    pass('resume-subheading fixture detected as resumeSubheading family');
  } else {
    fail('resume-subheading fixture family detection failed');
  }

  if (detectFamily(tabularFixture) === 'tabularx-itemize') {
    pass('tabularx-itemize fixture detected as tabularx-itemize family');
  } else {
    fail('tabularx-itemize fixture family detection failed');
  }

  if (detectFamily('\\documentclass{article}\\begin{document}Hello\\end{document}') === null) {
    pass('unknown LaTeX layout returns null family');
  } else {
    fail('unknown LaTeX layout should not match a supported family');
  }

  const manifest = buildManifest('resume-subheading.tex', resumeFixture);
  if (manifest.supported && manifest.slots.length >= 3) {
    pass(`resume-subheading manifest exposes editable slots (${manifest.slots.length})`);
  } else {
    fail(`resume-subheading manifest missing slots: ${JSON.stringify(manifest)}`);
  }

  const tabManifest = buildManifest('tabularx-itemize.tex', tabularFixture);
  if (tabManifest.supported && tabManifest.slots.length >= 2) {
    pass(`tabularx-itemize manifest exposes item slots (${tabManifest.slots.length})`);
  } else {
    fail(`tabularx-itemize manifest missing slots: ${JSON.stringify(tabManifest)}`);
  }

  const firstBullet = manifest.slots.find(s => s.kind === 'bullet');
  if (firstBullet) {
    const patched = applyPatches(resumeFixture, [{ id: firstBullet.id, text: 'Tailored summary bullet for testing.' }], manifest.slots);
    if (patched.includes('Tailored summary bullet for testing.')) {
      pass('applyPatches rewrites a resumeItem bullet in place');
    } else {
      fail('applyPatches did not insert tailored bullet text');
    }
  } else {
    fail('resume-subheading manifest has no bullet slot to patch');
  }

  // resumeItemWithoutTitle variant: `\resumeItemWithoutTitle{}{...}` bullets,
  // `\resumeSubItem{Cat}{items}` skills, and preamble macro defs that must NOT
  // leak into slots (the defs contain \resumeItem{#1}{#2} / \textbf{#1}{: #2}).
  const withoutTitleFixture = readFileSync(join(ROOT, 'examples/latex-tex/resume-subheading-withouttitle.tex'), 'utf-8');

  if (detectFamily(withoutTitleFixture) === 'resumeSubheading') {
    pass('resumeItemWithoutTitle fixture detected as resumeSubheading family');
  } else {
    fail('resumeItemWithoutTitle fixture family detection failed');
  }

  const wtManifest = buildManifest('resume-subheading-withouttitle.tex', withoutTitleFixture);
  const wtBullets = wtManifest.slots.filter(s => s.kind === 'bullet');
  const wtSkills = wtManifest.slots.filter(s => s.kind === 'skill');
  if (wtBullets.length === 2 && wtSkills.length === 3) {
    pass('resumeItemWithoutTitle manifest extracts 2 bullets + 3 skill values');
  } else {
    fail(`resumeItemWithoutTitle slot mismatch (want 2 bullets/3 skills): ${JSON.stringify(wtManifest.slots.map(s => ({ id: s.id, text: s.text.slice(0, 40) })))}`);
  }

  if (wtManifest.slots.every(s => !s.text.includes('#1') && !s.text.includes('#2'))) {
    pass('preamble macro definitions are not extracted as slots');
  } else {
    fail('extraction leaked preamble macro definitions (#1/#2) into slots');
  }

  if (wtManifest.slots.every(s => !s.text.includes('Stale commented bullet'))) {
    pass('commented-out macro calls are not extracted as slots');
  } else {
    fail('extraction leaked a commented-out bullet into slots');
  }

  // Slot spans must point at the prose group: patching every slot with its own
  // extracted text must reproduce the input byte-for-byte.
  const wtRoundTrip = applyPatches(
    withoutTitleFixture,
    wtManifest.slots.map(s => ({ id: s.id, text: s.text })),
    wtManifest.slots,
    { escape: false },
  );
  if (wtRoundTrip === withoutTitleFixture) {
    pass('no-op patch round-trip is byte-identical (spans point at prose groups)');
  } else {
    fail('no-op patch round-trip altered the document — slot spans are misaligned');
  }

  const wtBullet = wtBullets[0];
  const wtPatched = applyPatches(withoutTitleFixture, [{ id: wtBullet.id, text: 'Tailored withouttitle bullet.' }], wtManifest.slots);
  if (wtPatched.includes('\\resumeItemWithoutTitle{}{Tailored withouttitle bullet.}')) {
    pass('applyPatches rewrites a resumeItemWithoutTitle bullet in place');
  } else {
    fail('applyPatches did not rewrite the resumeItemWithoutTitle prose group');
  }

  const compileOnlyTex = `\\documentclass{article}\\begin{document}Minimal user CV\\end{document}`;
  const compileOnlyValidation = validateLatexContent(compileOnlyTex, true);
  if (compileOnlyValidation.issues.length === 0) {
    pass('--compile-only validation accepts minimal user .tex without career-ops macros');
  } else {
    fail(`compile-only validation too strict: ${compileOnlyValidation.issues.join('; ')}`);
  }

  const strictValidation = validateLatexContent(compileOnlyTex, false);
  if (strictValidation.issues.some(i => /section|resumeSubheading|pdfgentounicode/i.test(i))) {
    pass('default validation still enforces career-ops template checks');
  } else {
    fail('default validation should reject non-template .tex');
  }

  const extractDir = mkdtempSync(join(tmpdir(), 'latex-tex-'));
  const extractOut = join(extractDir, 'manifest.json');
  execFileSync(NODE, ['extract-latex-content.mjs', join(ROOT, 'examples/latex-tex/resume-subheading.tex'), '--out', extractOut], { cwd: ROOT, encoding: 'utf-8' });
  const extracted = JSON.parse(readFileSync(extractOut, 'utf-8'));
  const patchPayload = {
    slots: extracted.slots,
    patches: [{ id: extracted.slots[0].id, text: 'CLI patch path works.' }],
  };
  const patchJson = join(extractDir, 'patches.json');
  const patchedTex = join(extractDir, 'out.tex');
  writeFileSync(patchJson, JSON.stringify(patchPayload));
  execFileSync(NODE, ['patch-latex-content.mjs', join(ROOT, 'examples/latex-tex/resume-subheading.tex'), patchJson, patchedTex], { cwd: ROOT, encoding: 'utf-8' });
  const patchedContent = readFileSync(patchedTex, 'utf-8');
  if (patchedContent.includes('CLI patch path works.')) {
    pass('extract-latex-content.mjs + patch-latex-content.mjs CLI round-trip');
  } else {
    fail('CLI patch round-trip did not update the .tex file');
  }
  rmSync(extractDir, { recursive: true, force: true });
} catch (e) {
  fail(`LaTeX-tex tailoring test crashed: ${e.message}`);
}

// ── 21. CJK CV RENDERING (Japanese + Simplified Chinese) ─────────

console.log('\n21. CJK CV rendering (lang="ja" font fallback)');

try {
  // The bundled webfonts are Latin-only, so a Japanese CV (html lang="ja")
  // needs a CJK system-font fallback or it renders as tofu (□) in headless
  // Chromium. This mirrors the existing lang="ar" handling.
  const template = readFileSync(join(ROOT, 'templates', 'cv-template.html'), 'utf-8');

  if (/html\[lang="ja"\]\s+body/.test(template)) {
    pass('cv-template.html has a lang="ja" body rule for CJK text');
  } else {
    fail('cv-template.html is missing a lang="ja" font fallback — Japanese CVs render as tofu (□)');
  }

  // The fallback must name a real CJK font family, not just rely on sans-serif
  // (the generic sans-serif has no CJK glyphs on minimal/CI environments).
  const cjkFonts = ['Hiragino Sans', 'Yu Gothic', 'Noto Sans CJK JP', 'Noto Sans JP', 'Meiryo', 'MS PGothic'];
  const jaBlock = template.slice(template.indexOf('html[lang="ja"]'));
  if (cjkFonts.some((f) => jaBlock.includes(f))) {
    pass('lang="ja" rules name a concrete CJK font family');
  } else {
    fail('lang="ja" rules do not name any CJK font family — CJK fallback will not work');
  }

  for (const templateName of ['cv-template.html', 'resume-template.html']) {
    const zhTemplate = readFileSync(join(ROOT, 'templates', templateName), 'utf-8');
    const zhStart = zhTemplate.indexOf('html[lang="zh-CN"] body');
    const zhBlock = zhStart >= 0 ? zhTemplate.slice(zhStart) : '';
    const zhFonts = ['PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC'];

    if (zhStart >= 0 && zhFonts.some((font) => zhBlock.includes(font))) {
      pass(`${templateName} has concrete zh-CN font fallbacks`);
    } else {
      fail(`${templateName} is missing concrete zh-CN font fallbacks`);
    }

    if (/line-break:\s*strict/.test(zhBlock) && /overflow-wrap:\s*break-word/.test(zhBlock)) {
      pass(`${templateName} applies strict Chinese line breaking without clipping long mixed tokens`);
    } else {
      fail(`${templateName} is missing zh-CN line-breaking safeguards`);
    }

    if (/html\[lang="zh-CN"\]\s+\.contact-row/.test(zhBlock)) {
      pass(`${templateName} applies an explicit zh-CN fallback to contact details`);
    } else {
      fail(`${templateName} is missing an explicit zh-CN contact-row fallback`);
    }
  }

  const resumeHtml = readFileSync(join(ROOT, 'templates', 'resume-template.html'), 'utf-8');
  const resumeZhBlock = resumeHtml.slice(resumeHtml.indexOf('html[lang="zh-CN"] body'));
  const headingGroup = resumeZhBlock.slice(resumeZhBlock.indexOf('html[lang="zh-CN"] .header h1'), resumeZhBlock.indexOf('html[lang="zh-CN"] .summary-text'));
  if (!/\.competency-tag|\.skill-category/.test(headingGroup)) {
    pass('resume-template.html keeps competency and skill labels out of the zh-CN heading-font group');
  } else {
    fail('resume-template.html assigns competency or skill labels to the zh-CN heading font');
  }
} catch (e) {
  fail(`CJK rendering test crashed: ${e.message}`);
}

// ── 27. ATS LIGATURE SUPPRESSION ────────────────────────────────

console.log('\n27. ATS ligature suppression');

try {
  // Headless Chromium substitutes fi/fl/ffi with the Unicode ligature glyphs
  // U+FB01/FB02/FB03 at PDF layout time. PDF text extractors (what ATS reads)
  // decode them back to those codepoints, so "verification" parses as
  // "veriﬁcation" and a literal keyword search misses it. The templates disable
  // common, contextual, and discretionary ligatures in CSS so the output stays
  // font-independent. A live render-and-extract test is font and OS dependent
  // (the bug only appears where a ligature-bearing font is installed), so it is
  // not reliable in CI; this guards the CSS source, which is the fix itself.
  const LIGATURE_TEMPLATES = [
    'cv-template.html',
    'resume-template.html',
  ];
  const variantRe = /font-variant-ligatures:\s*none/;
  const featureRe = /font-feature-settings:\s*"liga"\s*0\s*,\s*"clig"\s*0\s*,\s*"dlig"\s*0/;

  for (const name of LIGATURE_TEMPLATES) {
    const css = readFileSync(join(ROOT, 'templates', name), 'utf-8');
    if (variantRe.test(css) && featureRe.test(css)) {
      pass(`${name} disables ligatures (font-variant-ligatures + font-feature-settings)`);
    } else {
      fail(`${name} is missing ligature suppression (PDF text extraction would read "veriﬁcation" not "verification")`);
    }
  }
} catch (e) {
  fail(`ATS ligature suppression test crashed: ${e.message}`);
}

// ── 28. OPTIONAL PROFILE PHOTO (opt-in, DACH/European — #264) ────

console.log('\n28. Optional profile photo (opt-in, DACH/European, #264)');

try {
  const cvTemplate = readFileSync(join(ROOT, 'templates', 'cv-template.html'), 'utf-8');

  // The opt-in photo must exist as a .cv-photo CSS rule.
  if (/\.cv-photo\s*\{/.test(cvTemplate)) {
    pass('cv-template.html defines a .cv-photo rule');
  } else {
    fail('cv-template.html is missing a .cv-photo rule — #264 opt-in photo not wired');
  }

  // It MUST be floated (taken out of normal flow) so a present photo is wrapped
  // by the text beside it (the classic DACH top-corner photo) and an absent one
  // leaves the layout unchanged. Anchor the check to the .cv-photo rule block so
  // it can't accidentally read another rule (e.g. the lang="ar" float:left
  // mirror) via offset slicing.
  const photoRule = cvTemplate.match(/\.cv-photo\s*\{[^}]*\}/);
  if (photoRule && /float:\s*right/.test(photoRule[0])) {
    pass('.cv-photo floats right (text wraps when present; absent ⇒ unchanged layout)');
  } else {
    fail('.cv-photo must float so a present photo sits beside the text and an absent one does not shift the layout (#264)');
  }

  // The photo is an opt-in {{PHOTO}} slot, empty by default. The agent fills it
  // only when config/profile.yml sets candidate.photo; otherwise it stays empty.
  if (cvTemplate.includes('{{PHOTO}}')) {
    pass('cv-template.html exposes a {{PHOTO}} opt-in slot (empty by default)');
  } else {
    fail('cv-template.html is missing the {{PHOTO}} opt-in slot (#264)');
  }

  // The slot MUST sit before the header (outside .header): the float anchors at
  // the top of the page, and removing the line when absent cannot then perturb
  // the header's own structure. Guards against a regression that moves the slot
  // inside .header (which would shift the photoless layout).
  const photoIdx = cvTemplate.indexOf('{{PHOTO}}');
  const headerIdx = cvTemplate.indexOf('<!-- HEADER -->');
  if (photoIdx !== -1 && headerIdx !== -1 && photoIdx < headerIdx) {
    pass('{{PHOTO}} slot precedes the header (outside .header — keeps the photoless layout intact)');
  } else {
    fail('{{PHOTO}} slot must sit before <!-- HEADER --> so an absent photo leaves the header unchanged (#264)');
  }

  // The shipped template must NOT carry an active <img>: photos are opt-in,
  // never the default (recruiters in the US/UK/many markets penalize photos).
  if (!/<img[^>]*class="cv-photo"/.test(cvTemplate)) {
    pass('default template has no active <img class="cv-photo"> (opt-in, not default)');
  } else {
    fail('cv-template.html ships an active photo <img> — photos must be opt-in, never default (#264)');
  }

  // RTL (Arabic) must mirror the photo to the opposite corner, like the other
  // lang="ar" rules in this template.
  if (/html\[lang="ar"\]\s+\.cv-photo/.test(cvTemplate)) {
    pass('lang="ar" mirrors .cv-photo to the opposite corner');
  } else {
    fail('cv-template.html is missing an RTL mirror for .cv-photo (#264)');
  }

  const resumeTemplate = readFileSync(join(ROOT, 'templates', 'resume-template.html'), 'utf-8');

  // The opt-in photo must exist as a .cv-photo CSS rule.
  if (/\.cv-photo\s*\{/.test(resumeTemplate)) {
    pass('resume-template.html defines a .cv-photo rule');
  } else {
    fail('resume-template.html is missing a .cv-photo rule — #264 opt-in photo not wired');
  }

  // It MUST be floated (taken out of normal flow) so a present photo is wrapped
  // by the text beside it (the classic DACH top-corner photo) and an absent one
  // leaves the layout unchanged. Anchor the check to the .cv-photo rule block so
  // it can't accidentally read another rule (e.g. the lang="ar" float:left
  // mirror) via offset slicing.
  const photoRuleResume = resumeTemplate.match(/\.cv-photo\s*\{[^}]*\}/);
  if (photoRuleResume && /float:\s*right/.test(photoRuleResume[0])) {
    pass('.cv-photo floats right in resume-template.html (text wraps when present; absent ⇒ unchanged layout)');
  } else {
    fail('.cv-photo must float in resume-template.html so a present photo sits beside the text and an absent one does not shift the layout (#264)');
  }

  // The photo is an opt-in {{PHOTO}} slot, empty by default. The agent fills it
  // only when config/profile.yml sets candidate.photo; otherwise it stays empty.
  if (resumeTemplate.includes('{{PHOTO}}')) {
    pass('resume-template.html exposes a {{PHOTO}} opt-in slot (empty by default)');
  } else {
    fail('resume-template.html is missing the {{PHOTO}} opt-in slot (#264)');
  }

  // The slot MUST sit before the header (outside .header): the float anchors at
  // the top of the page, and removing the line when absent cannot then perturb
  // the header's own structure. Guards against a regression that moves the slot
  // inside .header (which would shift the photoless layout).
  const photoIdxResume = resumeTemplate.indexOf('{{PHOTO}}');
  const headerIdxResume = resumeTemplate.indexOf('<!-- HEADER -->');
  if (photoIdxResume !== -1 && headerIdxResume !== -1 && photoIdxResume < headerIdxResume) {
    pass('{{PHOTO}} slot precedes the header in resume-template.html (outside .header — keeps the photoless layout intact)');
  } else {
    fail('{{PHOTO}} slot must sit before <!-- HEADER --> in resume-template.html so an absent photo leaves the header unchanged (#264)');
  }

  // The shipped template must NOT carry an active <img>: photos are opt-in,
  // never the default (recruiters in the US/UK/many markets penalize photos).
  if (!/<img[^>]*class="cv-photo"/.test(resumeTemplate)) {
    pass('default resume template has no active <img class="cv-photo"> (opt-in, not default)');
  } else {
    fail('resume-template.html ships an active photo <img> — photos must be opt-in, never default (#264)');
  }

  // RTL (Arabic) must mirror the photo to the opposite corner, like the other
  // lang="ar" rules in this template.
  if (/html\[lang="ar"\]\s+\.cv-photo/.test(resumeTemplate)) {
    pass('lang="ar" mirrors .cv-photo to the opposite corner in resume-template.html');
  } else {
    fail('resume-template.html is missing an RTL mirror for .cv-photo (#264)');
  }
} catch (e) {
  fail(`profile photo test crashed: ${e.message}`);
}

// ── 44b. openrouter-runner — prompt-cache breakpoint (#1709) ────
console.log('\n44b. openrouter-runner — prompt-cache breakpoint (#1709)');
try {
  const { buildCachedSystemMessage } = await import(pathToFileURL(join(ROOT, 'openrouter-runner.mjs')).href);
  const prefix = 'STATIC SYSTEM PREFIX — shared + profile + mode + cv';
  const msg = buildCachedSystemMessage(prefix);
  const block = msg?.content?.[0];
  // The static prefix must ride as a structured content block carrying an
  // ephemeral cache_control breakpoint, with the prompt text preserved verbatim
  // (caching must never alter what the model reads).
  if (
    msg.role === 'system' &&
    Array.isArray(msg.content) && msg.content.length === 1 &&
    block.type === 'text' && block.text === prefix &&
    block.cache_control && block.cache_control.type === 'ephemeral'
  ) {
    pass('buildCachedSystemMessage marks the static prefix with an ephemeral cache_control breakpoint, text unchanged (#1709)');
  } else {
    fail(`buildCachedSystemMessage shape wrong: ${JSON.stringify(msg)}`);
  }
} catch (e) {
  fail(`openrouter-runner prompt-cache test crashed: ${e.message}`);
}

// ── 44d. gemini-eval — static prefix as systemInstruction (#1709) ────
// Gemini has no cache_control field; its implicit prefix caching keys on a
// stable systemInstruction, so the static context must sit there — not inline in
// contents. Source-level, since gemini-eval runs on import.
console.log('\n44d. gemini-eval — static prefix as systemInstruction (#1709)');
try {
  const src = readFileSync(join(ROOT, 'gemini-eval.mjs'), 'utf-8');
  const usesSystemInstruction = /getGenerativeModel\(\{[\s\S]*?systemInstruction:\s*systemPrompt/.test(src);
  // the per-request call must NOT re-embed the full systemPrompt inline (that
  // would defeat stable-prefix caching and duplicate the context)
  const noInlinePrefix = !/generateContent\(\[[\s\S]*?\{\s*text:\s*systemPrompt\s*\}/.test(src);
  const carriesJdTurn = /generateContent\(`JOB DESCRIPTION TO EVALUATE/.test(src);
  if (usesSystemInstruction && noInlinePrefix && carriesJdTurn) {
    pass('gemini-eval moves the static prefix to systemInstruction and sends only the JD turn (#1709)');
  } else {
    fail(`gemini-eval systemInstruction wiring: sys=${usesSystemInstruction} noInline=${noInlinePrefix} jd=${carriesJdTurn}`);
  }
} catch (e) {
  fail(`gemini-eval systemInstruction source test crashed: ${e.message}`);
}

// ── 44f. openai-tailor — host-gated prompt-cache breakpoint (#1709, #2432) ──
// openai-tailor.mjs runs on import (arg parse + fetch), so it can't be imported
// to unit-test the helper — assert the host-gated shape at the source level,
// same approach as 44c for its sibling openai-eval.mjs.
console.log('\n44f. openai-tailor — host-gated prompt-cache breakpoint (#1709, #2432)');
try {
  const src = readFileSync(join(ROOT, 'openai-tailor.mjs'), 'utf-8');
  const checks = [
    // api.openai.com gets a plain-string system message (auto-caches; may reject the field)
    { name: 'openai-tailor gates cache_control off for api.openai.com', re: /host === 'api\.openai\.com'\)\s*return\s*\{\s*role:\s*'system',\s*content:\s*prompt\s*\}/ },
    // other OpenAI-compatible hosts get the ephemeral cache_control breakpoint, text preserved
    { name: 'openai-tailor sends an ephemeral cache_control breakpoint to compatible gateways', re: /text:\s*prompt,\s*cache_control:\s*\{\s*type:\s*'ephemeral'\s*\}/ },
    // and it's actually wired into the request, keyed on the resolved endpoint host
    { name: 'openai-tailor builds the system message via buildSystemMessage(systemPrompt, endpointHost)', re: /buildSystemMessage\(systemPrompt,\s*endpointHost\)/ },
  ];
  const missing = checks.filter((c) => !c.re.test(src));
  if (missing.length === 0) pass('openai-tailor host-gates the #1709 prompt-cache breakpoint and wires it into the request');
  else fail(`openai-tailor prompt-cache wiring missing: ${missing.map((m) => m.name).join('; ')}`);
} catch (e) {
  fail(`openai-tailor prompt-cache source test crashed: ${e.message}`);
}

// ── 44e. ollama-eval — temperature must live in options ────────
// Ollama's /api/chat reads generation params from `options` only; a top-level
// `temperature` is silently ignored (defaulting to 0.8). Assert it sits in
// options so the eval stays deterministic. Source-level: ollama-eval runs on import.
console.log('\n44e. ollama-eval — temperature in options');
try {
  const src = readFileSync(join(ROOT, 'ollama-eval.mjs'), 'utf-8');
  const inOptions = /options:\s*\{[^}]*temperature:\s*0\.4[^}]*num_ctx/.test(src);
  // must NOT set a top-level temperature in the request body (silently ignored)
  const noTopLevel = !/\n\s*temperature:\s*0\.4,\s*\n\s*options:/.test(src);
  if (inOptions && noTopLevel) {
    pass('ollama-eval sets temperature inside options (not silently ignored at the top level)');
  } else {
    fail(`ollama-eval temperature placement: inOptions=${inOptions} noTopLevel=${noTopLevel}`);
  }
} catch (e) {
  fail(`ollama-eval temperature test crashed: ${e.message}`);
}

// ── 46. Keyword coverage (ATS match) ────────────────────────────
console.log('\n46. Keyword coverage (ATS match)');

try {
  const { analyzeCoverage, extractKeywords, countOccurrences, variantForms, htmlToText } =
    await import(pathToFileURL(join(ROOT, 'keyword-match.mjs')).href);

  const cv = [
    'Senior engineer. Built Python services with FastAPI. Python remains my primary language.',
    'Deployed on k8s. Owned CI/CD pipelines. Wrote C++ modules and some JavaScript.',
    'Strong in machine  learning and PostgreSQL. Set up observability once.',
  ].join('\n');
  const keywords = ['Python', 'FastAPI', 'Kubernetes', 'CI/CD', 'C++',
    'Machine Learning', 'Postgres', 'observability', 'Java', 'gRPC'];
  const r = analyzeCoverage(keywords, cv);

  if (r.present.includes('Python')) pass('keyword coverage: exact match (Python)');
  else fail('keyword coverage: Python should be present');

  if (!r.thin.includes('Python')) pass('keyword coverage: count>1 keyword not flagged thin (Python x2)');
  else fail('keyword coverage: Python appears twice and must not be thin');

  if (r.present.includes('Kubernetes')) pass('keyword coverage: synonym match (k8s -> Kubernetes)');
  else fail('keyword coverage: Kubernetes should match via k8s synonym');

  if (r.present.includes('Machine Learning')) pass('keyword coverage: case + collapsed-whitespace match');
  else fail('keyword coverage: Machine Learning should match "machine  learning"');

  if (r.present.includes('C++') && r.present.includes('CI/CD')) pass('keyword coverage: symbol-bearing keywords match (C++, CI/CD)');
  else fail('keyword coverage: C++ / CI/CD should match');

  if (r.present.includes('Postgres')) pass('keyword coverage: synonym match (PostgreSQL -> Postgres)');
  else fail('keyword coverage: Postgres should match via postgresql synonym');

  if (!r.present.includes('Java') && r.missing.includes('Java')) pass('keyword coverage: word boundary holds (Java != JavaScript)');
  else fail('keyword coverage: Java must not match inside JavaScript');

  if (r.missing.includes('gRPC')) pass('keyword coverage: genuine miss reported (gRPC)');
  else fail('keyword coverage: gRPC should be missing');

  if (r.thin.includes('observability')) pass('keyword coverage: count-1 keyword flagged thin (observability)');
  else fail('keyword coverage: observability should be thin');

  if (r.coveragePct === 80) pass('keyword coverage: percentage computed correctly (8/10 = 80%)');
  else fail(`keyword coverage: percentage wrong: ${r.coveragePct} (expected 80)`);

  if (countOccurrences('java', 'javascript and java') === 1) pass('keyword coverage: countOccurrences respects word boundaries');
  else fail(`keyword coverage: countOccurrences boundary wrong: ${countOccurrences('java', 'javascript and java')}`);

  if (!variantForms('aws').includes('aw') && !variantForms('k8s').includes('k8')) pass('keyword coverage: variantForms does not truncate short acronyms (aws, k8s)');
  else fail(`keyword coverage: variantForms truncates acronyms: ${JSON.stringify(variantForms('aws'))}`);

  const stripped = htmlToText('<style>.x{}</style><p>Python &amp; <b>gRPC</b></p>');
  if (stripped === 'Python & gRPC') pass('keyword coverage: htmlToText strips tags/style and decodes entities');
  else fail(`keyword coverage: htmlToText wrong: ${JSON.stringify(stripped)}`);

  // Adversarial: a nested entity must resolve to the literal text "&lt;" (guards the
  // &amp;-decoded-last fix, so it is not re-decoded into a "<" tag char), and a
  // comment-sheltered or attribute-laden <script> must still be stripped (tag-filter fix).
  const hardened = htmlToText('<!--<script>x</script>--><script type="text/js">evil()</script>a &amp;lt;b&gt; c');
  if (hardened === 'a &lt;b> c') pass('keyword coverage: htmlToText resists nested-entity + sheltered-script bypass');
  else fail(`keyword coverage: htmlToText hardening wrong: ${JSON.stringify(hardened)}`);

  const htmlCv = '<html><body><h2>Summary</h2><p>Built Python and gRPC services.</p></body></html>';
  const rHtml = analyzeCoverage(['Python', 'gRPC', 'Java'], htmlToText(htmlCv));
  if (rHtml.coveragePct === 67 && rHtml.present.includes('gRPC')) pass('keyword coverage: scans text extracted from tailored HTML');
  else fail(`keyword coverage: HTML scan wrong: ${JSON.stringify(rHtml)}`);

  const kws = extractKeywords('## Keywords extracted\n- Python\n- FastAPI, gRPC\n\n## Next');
  if (kws.length === 3 && kws[0] === 'Python' && kws[2] === 'gRPC') pass('keyword coverage: extractKeywords parses bullets + commas, stops at next heading');
  else fail(`keyword coverage: extractKeywords wrong: ${JSON.stringify(kws)}`);

  // Negative-path CLI: --self-test never touches the report/CV file-resolution path,
  // so exercise it directly. A nonexistent report (and a no-arg invocation) must fail
  // GRACEFULLY — clean exit 1 + a readable message, never an uncaught stack trace.
  const kmCli = join(ROOT, 'keyword-match.mjs');
  const noStack = (s) => !/\n\s+at\s/.test(s); // Node prints "    at <frame>" on an uncaught throw
  const runCli = (argv) => {
    try {
      execFileSync(NODE, [kmCli, ...argv], { cwd: ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
      return { status: 0, stderr: '' };
    } catch (e) {
      return { status: e.status, stderr: (e.stderr || '').toString() };
    }
  };

  const missing = runCli([join(ROOT, '.tmp-test-no-such-report.md')]);
  if (missing.status === 1 && /not found/i.test(missing.stderr) && noStack(missing.stderr)) {
    pass('keyword coverage: CLI exits 1 with a clean message on a missing report file');
  } else {
    fail(`keyword coverage: CLI missing-report handling wrong: status=${missing.status} stderr=${JSON.stringify(missing.stderr)}`);
  }

  const noArg = runCli([]);
  if (noArg.status === 1 && /Usage:/i.test(noArg.stderr) && noStack(noArg.stderr)) {
    pass('keyword coverage: CLI prints usage + exits 1 when no report arg is given');
  } else {
    fail(`keyword coverage: CLI no-arg handling wrong: status=${noArg.status} stderr=${JSON.stringify(noArg.stderr)}`);
  }

  // A mistyped flag or a stray second path must fail fast instead of silently
  // producing Markdown when JSON was asked for (both rejected before any file I/O).
  const unknownOpt = runCli(['--jsno']);
  if (unknownOpt.status === 1 && /Unknown option: --jsno/.test(unknownOpt.stderr) && noStack(unknownOpt.stderr)) {
    pass('keyword coverage: CLI rejects an unknown option with exit 1');
  } else {
    fail(`keyword coverage: CLI unknown-option handling wrong: status=${unknownOpt.status} stderr=${JSON.stringify(unknownOpt.stderr)}`);
  }

  const extraArg = runCli(['first-report.md', 'second-report.md']);
  if (extraArg.status === 1 && /Unexpected argument: second-report\.md/.test(extraArg.stderr) && noStack(extraArg.stderr)) {
    pass('keyword coverage: CLI rejects an extra positional argument with exit 1');
  } else {
    fail(`keyword coverage: CLI extra-argument handling wrong: status=${extraArg.status} stderr=${JSON.stringify(extraArg.stderr)}`);
  }

} catch (e) {
  fail(`keyword coverage tests crashed: ${e.message}`);
}

// ── 20. PATH RESOLUTION LAYER AND OVERRIDES ───────────────────

console.log('\n20. Path resolution layer and overrides');

try {
  const { getCareerOpsRoot } = await import(pathToFileURL(join(ROOT, 'path-resolver.mjs')).href);

  // 1. The default, with nothing set, is checked in step 6 below, against a
  //    copy of the resolver: asked of this checkout it is the marker's target
  //    for anyone who has a .career-ops-data file, and failed for them.
  try {
    // 2. CAREER_OPS_ROOT should override the resolved path
    const testOverridePath = join(ROOT, 'test-override-path');
    process.env.CAREER_OPS_ROOT = testOverridePath;
    const overriddenRoot = getCareerOpsRoot();
    if (overriddenRoot === testOverridePath) {
      pass('getCareerOpsRoot() respects process.env.CAREER_OPS_ROOT override');
    } else {
      fail(`getCareerOpsRoot() returned ${overriddenRoot}, expected ${testOverridePath}`);
    }
    process.env.CAREER_OPS_ROOT = '';

    // 3. CAREER_OPS_DATA_DIR should override the resolved path
    process.env.CAREER_OPS_DATA_DIR = testOverridePath;
    const overriddenDataDirRoot = getCareerOpsRoot();
    if (overriddenDataDirRoot === testOverridePath) {
      pass('getCareerOpsRoot() respects process.env.CAREER_OPS_DATA_DIR override');
    } else {
      fail(`getCareerOpsRoot() returned ${overriddenDataDirRoot}, expected ${testOverridePath}`);
    }
  } finally {
    // Back to the suite's own data root. Restoring by deleting, as the steps
    // below used to, left every later section resolving to the developer's.
    pinSandboxDataRoot();
  }

  // 4. Test doctor.mjs respects target directory or target override when CAREER_OPS_ROOT is set
  const tempTarget = mkdtempSync(join(ROOT, `${SCRATCH_PREFIX}co-temp-target-`));
  // The override goes in the child's env, here and below, not in this
  // process's: nothing then has to be put back.
  try {
    const r = JSON.parse(run(NODE, ['doctor.mjs', '--json'], {
      env: { ...process.env, CAREER_OPS_ROOT: tempTarget, CAREER_OPS_DATA_DIR: '' },
    }) || '{}');
    if (r.onboardingNeeded === true && r.missing.includes('cv.md')) {
      pass('doctor.mjs respects CAREER_OPS_ROOT default root check');
    } else {
      fail(`doctor.mjs with CAREER_OPS_ROOT override failed: ${JSON.stringify(r)}`);
    }

    // 4b. Test doctor.mjs respects CAREER_OPS_DATA_DIR override
    const rDataDir = JSON.parse(run(NODE, ['doctor.mjs', '--json'], {
      env: { ...process.env, CAREER_OPS_ROOT: '', CAREER_OPS_DATA_DIR: tempTarget },
    }) || '{}');
    if (rDataDir.onboardingNeeded === true && rDataDir.missing.includes('cv.md')) {
      pass('doctor.mjs respects CAREER_OPS_DATA_DIR override check');
    } else {
      fail(`doctor.mjs with CAREER_OPS_DATA_DIR override failed: ${JSON.stringify(rDataDir)}`);
    }
  } finally {
    rmSync(tempTarget, { recursive: true, force: true });
  }

  // 5. Test normalize-statuses respects CAREER_OPS_ROOT and does not touch main repo tracker
  const tempRoot = mkdtempSync(join(ROOT, `${SCRATCH_PREFIX}co-temp-root-`));
  const tempTrackerDir = join(tempRoot, 'data');
  mkdirSync(tempTrackerDir, { recursive: true });
  const tempTracker = join(tempTrackerDir, 'applications.md');
  const dummyContent = `
# Applications

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-07-01 | TestCo | Engineer | 4.0 | **Applied** | ❌ | - | - |
`;
  writeFileSync(tempTracker, dummyContent, 'utf-8');


  try {
    run(NODE, ['normalize-statuses.mjs'], {
      env: { ...process.env, CAREER_OPS_ROOT: tempRoot, CAREER_OPS_DATA_DIR: '' },
    });
    const updated = readFileSync(tempTracker, 'utf-8');
    if (updated.includes('| Applied |') && !updated.includes('**Applied**')) {
      pass('normalize-statuses.mjs respects CAREER_OPS_ROOT and modifies the correct tracker file');
    } else {
      fail(`normalize-statuses.mjs did not modify target tracker correctly, content: ${updated}`);
    }

  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  // 6. Test .career-ops-data marker file resolution
  //
  // Against a copy of path-resolver.mjs, never the checkout's own marker. The
  // resolver looks for the marker beside itself, so a copy in a scratch
  // directory reads a scratch marker. This used to write the repo-root marker
  // and put the developer's back afterwards, inside a `catch {}`: an
  // interrupted or failed restore left every script resolving to a temp
  // directory that no longer existed, and said nothing (#5113).
  // realpathSync: the copy locates itself through import.meta.url, which Node
  // gives as a real path, and macOS's temp directory is a symlink.
  const tempMarkerCode = realpathSync(mkdtempSync(join(tmpdir(), 'co-temp-marker-code-')));
  const tempMarkerRoot = mkdtempSync(join(tmpdir(), 'co-temp-marker-data-'));
  try {
    copyFileSync(join(ROOT, 'path-resolver.mjs'), join(tempMarkerCode, 'path-resolver.mjs'));
    const { getCareerOpsRoot: getRootWithMarker } = await import(pathToFileURL(join(tempMarkerCode, 'path-resolver.mjs')).href);
    // The marker, and the default behind it, only apply when neither variable
    // is set.
    delete process.env.CAREER_OPS_ROOT;
    delete process.env.CAREER_OPS_DATA_DIR;
    const defaultRoot = getRootWithMarker();
    if (defaultRoot === tempMarkerCode) {
      pass('getCareerOpsRoot() defaults to codebase root when environment variables are unset');
    } else {
      fail(`getCareerOpsRoot() returned ${defaultRoot}, expected ${tempMarkerCode}`);
    }

    writeFileSync(join(tempMarkerCode, MARKER_FILE), tempMarkerRoot, 'utf-8');
    const resolved = getRootWithMarker();
    if (resolved === tempMarkerRoot) {
      pass('getCareerOpsRoot() respects .career-ops-data marker file');
    } else {
      fail(`getCareerOpsRoot() with marker returned ${resolved}, expected ${tempMarkerRoot}`);
    }
  } finally {
    pinSandboxDataRoot();
    rmSync(tempMarkerCode, { recursive: true, force: true });
    rmSync(tempMarkerRoot, { recursive: true, force: true });
  }

  // 7. Test resolveTrackerPathForWrite
  const { resolveTrackerPathForWrite: getWriteTracker } = await import(pathToFileURL(join(ROOT, 'path-resolver.mjs')).href + '?cachebust=' + Date.now());
  const expectedWritePath = join(ROOT, 'data/applications.md');
  const actualWritePath = getWriteTracker(ROOT);
  if (actualWritePath === expectedWritePath) {
    pass('resolveTrackerPathForWrite() returns the canonical data/applications.md path deterministically');
  } else {
    fail(`resolveTrackerPathForWrite() returned ${actualWritePath}, expected ${expectedWritePath}`);
  }

} catch (e) {
  fail(`Path resolution layer test crashed: ${e.message}`);
}

console.log('\n59. CV template resolver (cv-templates.mjs)');
{
  // The unit suite moved to tests/ and is auto-discovered (#3247); what stays
  // here is the CLI surface, which discovery does not cover.
  const listed = run(NODE, ['cv-templates.mjs', 'list', 'cv']);
  if (listed && listed.includes('"name"')) pass('CLI: list cv returns JSON');
  else fail('CLI: list cv did not return JSON');

  // Hermetic: point at a nonexistent profile so this exercises the unset -> base
  // fallback regardless of the developer's real config/profile.yml (cv.template).
  const noProfile = { env: { ...process.env, CAREER_OPS_PROFILE: join(tmpdir(), 'career-ops-no-such-profile.yml') } };
  const resolved = run(NODE, ['cv-templates.mjs', 'resolve', 'cv'], noProfile);
  if (resolved && resolved.endsWith('cv-template.html')) pass('CLI: resolve cv (unset) -> base template');
  else fail(`CLI: resolve cv (unset) unexpected: ${resolved}`);
}


console.log('\n59c. The exported script budget matches the one run() enforces');
{
  // DEFAULT_SCRIPT_TIMEOUT_MS and the `timeout: 30000` literal inside run() are
  // the same number held in two places, because that execFileSync call is kept
  // byte-identical on purpose — editing it makes CodeQL re-attribute its
  // long-standing "uncontrolled command line" finding to whichever PR touched
  // the line. A comment asks the two to stay in step, and a comment is not a
  // mechanism: if they drift, the slow-script warning starts measuring against
  // a budget nobody is enforcing, and the first sign is a script killed at a
  // limit the suite never mentioned. Read the literal back and compare.
  // Anchored on run()'s own `(exe, args, …)` call signature rather than on
  // `execFileSync` alone: that file has six other execFileSync calls, and a
  // pattern that takes the FIRST match would start comparing against whichever
  // one grows a `timeout:` first — a guard quietly measuring the wrong number,
  // which is worse than no guard because it still reports green.
  //
  // Zero or several matches is therefore a failure in its own right, not a
  // reason to fall back to a best guess.
  const helpersSrc = readFileSync(join(ROOT, 'tests', 'helpers.mjs'), 'utf-8');
  const enforced = [...helpersSrc.matchAll(/execFileSync\(\s*exe\s*,\s*args\s*,\s*\{[^}]*?timeout:\s*([1-9]\d*)\s*(?=[,}])/g)];
  if (enforced.length !== 1) {
    fail(`expected exactly one timeout literal in run()'s execFileSync call, found ${enforced.length}`
      + ' — if that call was refactored or duplicated, update this check alongside it');
  } else if (Number(enforced[0][1]) === DEFAULT_SCRIPT_TIMEOUT_MS) {
    pass(`run()'s enforced timeout (${enforced[0][1]}ms) matches the exported DEFAULT_SCRIPT_TIMEOUT_MS`);
  } else {
    fail(`budget drift: run() enforces ${enforced[0][1]}ms but DEFAULT_SCRIPT_TIMEOUT_MS is ${DEFAULT_SCRIPT_TIMEOUT_MS}ms`);
  }
}

console.log('\n62. User path drift-guard (no codebase-root path resolution for user-layer files)');
try {
  const USER_SEGMENTS = [
    'data', 'reports', 'output',
    'cv.md', 'article-digest.md', 'portals.yml',
    'config/profile.yml',
    'applications.md', 'pipeline.md', 'active-interviews.md', 'follow-ups.md',
    'scan-history.tsv', 'scan-runs.tsv', 'salary-observations.tsv',
    'assessments.tsv', 'pdf-index.tsv', 'batch-state.tsv',
  ];
  const segAlt = USER_SEGMENTS.map(s => s.replace(/\./g, () => '\\.').replace(/\//g, () => '[/\\\\]')).join('|');

  const listScripts = (dir) => {
    const out = [];
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(dir, name);
      const statResult = statSync(p);
      if (statResult.isDirectory()) continue;
      if (!name.endsWith('.mjs')) continue;
      if (/-tests?\.mjs$/.test(name) || /\.test\.mjs$/.test(name)) continue;
      out.push(p);
    }
    return out;
  };

  const violations = [];

  for (const file of listScripts(ROOT)) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');

    const codeRootVars = new Set();
    for (const m of src.matchAll(/const\s+(\w+)\s*=\s*dirname\(fileURLToPath\(import\.meta\.url\)\)/g)) codeRootVars.add(m[1]);
    for (const m of src.matchAll(/const\s+(\w+)\s*=\s*process\.cwd\(\)/g)) codeRootVars.add(m[1]);
    if (codeRootVars.size === 0) continue;

    const varAlt = [...codeRootVars].join('|');
    const joinRe = new RegExp(`\\b(?:join|resolve)\\(\\s*(?:${varAlt})\\s*,\\s*'(?:${segAlt})`, 'g');

    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      let m;
      joinRe.lastIndex = 0;
      while ((m = joinRe.exec(line)) !== null) {
        violations.push({ file: file.replace(ROOT + '\\', '').replace(ROOT + '/', ''), line: i + 1, root: m[1], code: trimmed.slice(0, 90) });
      }
    });
  }

  if (violations.length === 0) {
    pass('all user-layer paths resolve through getCareerOpsRoot() (no silent split)');
  } else {
    fail(`${violations.length} user-layer path(s) built from the CODEBASE root instead of getCareerOpsRoot():\n` +
      violations.map(v => `    ${v.file}:L${v.line} (${v.root}) ${v.code}`).join('\n')
    );
  }
} catch (e) {
  fail(`user path drift-guard check crashed: ${e.message}`);
}

// ── 69. Jurisdiction-prohibited content signal (#2018) ─────────

console.log('\n69. Jurisdiction-prohibited content signal (#2018)');

const ofertaMode = readOfertaMode();

// --- jurisdiction-prohibited content signal (#2018): table + oferta Block G + apply Step 5c ---
{
  try {
    const { load } = await import('js-yaml');
    const tableSrc = readFile('templates/jurisdiction-prohibited-content.yml');
    const table = load(tableSrc);
    const entries = Array.isArray(table?.entries) ? table.entries : [];
    const byKey = Object.fromEntries(entries.map((e) => [e.jurisdiction, e]));
    const entryOk = (e) =>
      e && typeof e.prohibited === 'string' && typeof e.matching === 'string' &&
      typeof e.legal_basis === 'string' && typeof e.effective === 'string' &&
      Array.isArray(e.sources) && e.sources.length > 0;
    const caOn = byKey['CA-ON'];
    const usCa = byKey['US-CA'];
    if (
      entryOk(caOn) && caOn.prohibited.includes('Canadian experience') && caOn.effective === '2026-01-01' &&
      entryOk(usCa) && usCa.prohibited.toLowerCase().includes('salary history') && usCa.effective === '2018-01-01' &&
      tableSrc.includes('no entry without a citable legal source')
    ) {
      pass('jurisdiction-prohibited-content.yml parses with both verified seed entries, sources, and the contribution rule (#2018)');
    } else {
      fail('jurisdiction-prohibited-content.yml missing/incomplete seed entries (CA-ON, US-CA) or contribution rule (#2018)');
    }
  } catch (e) {
    fail(`templates/jurisdiction-prohibited-content.yml failed to load/parse as YAML: ${e.message} (#2018)`);
  }

  if (
    ofertaMode.includes('**12. Jurisdiction-Prohibited Content**') &&
    ofertaMode.includes('templates/jurisdiction-prohibited-content.yml') &&
    ofertaMode.includes('⚠️ **Jurisdiction-prohibited content signal:**') &&
    ofertaMode.includes('not legal advice') &&
    ofertaMode.includes('never naive keyword matching')
  ) {
    pass('oferta Block G signal 10 reads the jurisdiction table with agent-judged matching and a not-legal-advice note (#2018)');
  } else {
    fail('oferta Block G missing the jurisdiction-prohibited content signal, table reference, or not-legal-advice note (#2018)');
  }

  // Phrasing discipline (#2018): the new mode text states verifiable facts about
  // the posting/form only. Outside the explicit "never assert ..." guidance
  // sentence, the new sections must not contain employer-lawbreaking language.
  const signal9 = ofertaMode.slice(
    ofertaMode.indexOf('**12. Jurisdiction-Prohibited Content**'),
    ofertaMode.indexOf('**13. Pay-Transparency Range-Width Check**')
  );
  const allowedGuidance = /assert that the employer is breaking the law or committing a violation/g;
  const residue = signal9.replace(allowedGuidance, '');
  if (
    signal9.length > 0 &&
    !/illegal|violat|breaking the law|lawbreak/i.test(residue)
  ) {
    pass('jurisdiction-prohibited sections keep phrasing discipline — no employer-lawbreaking assertions outside the guidance sentence (#2018)');
  } else {
    fail('jurisdiction-prohibited sections contain employer-lawbreaking language outside the "never assert" guidance (#2018)');
  }
}

// ---------------------------------------------------------------------------
console.log('\n72. formatRunFailure keeps the END of an over-long stream (#3035)');

try {
  // A red run is the only time this output is read, so what it keeps decides
  // whether a CI failure is actionable. It kept the head. For the suites here,
  // which print a tick per assertion, the head is the setup that PASSED and the
  // tail carries the `Results:` line and the newest cases — so the later a case
  // was added, the more certain it was to be cut. windows-latest cut
  // tests/agent-inbox.test.mjs mid-word, one assertion short of the §8 verdict added
  // specifically to attribute that failure.
  //
  // Drive it through a real failing run() rather than by reaching into the
  // module's private lastFailure, so this covers the path CI actually takes.
  const CAP = 1200;
  const HEAD = 'HEAD-MARKER-AN-EARLY-STACK-WOULD-SIT-HERE';
  const marker = 'TAIL-MARKER-THE-RESULTS-LINE-SITS-HERE';
  const FILL = 8000;
  // One line, no newlines. formatRunFailure re-indents every newline in the
  // clipped text, which would inflate any length measured off the rendered
  // string; a newline-free payload keeps the arithmetic below exact.
  //
  // Exit from the write CALLBACK, not the next statement: stdout to a pipe is
  // async, and process.exit() discards whatever has not flushed — which would
  // silently shrink the fixture and make the cap assertion pass for the wrong
  // reason.
  const okOut = run(NODE, ['-e',
    `process.stdout.write('${HEAD}' + 'x'.repeat(${FILL}) + '${marker}', () => process.exit(1));`]);
  const streamLen = HEAD.length + FILL + marker.length;

  if (okOut !== null) {
    fail('formatRunFailure fixture: the child was expected to exit non-zero');
  } else {
    const rendered = formatRunFailure(CAP);

    if (rendered.includes(marker)) {
      pass('formatRunFailure keeps the tail of an over-long stdout (the failure summary)');
    } else {
      fail('formatRunFailure dropped the tail — a red run loses its newest assertions and its Results line');
    }

    // Never zero head: an early stack trace is the other common shape, and
    // keeping only the tail would just invert the bug rather than fix it.
    if (rendered.includes(HEAD)) {
      pass('formatRunFailure still keeps the head (an early stack trace survives too)');
    } else {
      fail('formatRunFailure dropped the head — tail-only inverts the original defect');
    }

    if (/\.\.\. \(\d+ more chars elided\)/.test(rendered)) {
      pass('formatRunFailure marks the elision with the dropped-character count');
    } else {
      fail('formatRunFailure elides silently — a reader cannot tell output is missing');
    }

    // The cap is a promise about the returned string, so the marker's own
    // width has to come out of the budget rather than sit on top of it.
    //
    // Measure via the reported dropped-count rather than off `rendered`: the
    // caller re-indents newlines and prefixes ` (exit N)\n    stdout: `, so the
    // rendered length is not the clipped length. kept = streamLen - dropped is
    // exact, and this fixture has no newlines of its own to be re-indented.
    const elided = rendered.match(/\.\.\. \((\d+) more chars elided\)/);
    if (!elided) {
      fail('formatRunFailure cap check: no elision marker to measure against');
    } else {
      const dropped = Number(elided[1]);
      const markerLen = `\n    ... (${dropped} more chars elided)\n`.length;
      const clipped = (streamLen - dropped) + markerLen;
      if (clipped <= CAP) {
        pass(`formatRunFailure keeps the clipped stream within maxChars, marker included (${clipped} <= ${CAP})`);
      } else {
        fail(`formatRunFailure overruns its own cap: ${clipped} chars returned for maxChars=${CAP} (marker not budgeted)`);
      }
    }

    // Squeeze the content budget down to exactly two characters — the smallest
    // that can still hold both ends. Math.floor(budget * 0.35) is 0 below
    // budget 3, so without a floor the head vanishes here and the tail takes
    // everything, which is the inversion this whole case exists to prevent.
    //
    // Own fixture with single-character boundaries that appear nowhere else in
    // the rendered output — not in ` (exit 1)`, not in `stdout: `, not in the
    // marker — so "both ends survived" is asserted precisely rather than by
    // matching a letter that could have come from anywhere.
    const TINY_FILL = 500;
    const okTiny = run(NODE, ['-e',
      `process.stdout.write('<' + 'x'.repeat(${TINY_FILL}) + '>', () => process.exit(1));`]);
    if (okTiny !== null) {
      fail('formatRunFailure tiny-budget fixture: the child was expected to exit non-zero');
    } else {
      const tinyLen = TINY_FILL + 2;
      const tinyCap = `\n    ... (${tinyLen} more chars elided)\n`.length + 2;
      const tiny = formatRunFailure(tinyCap);
      if (tiny.includes('<') && tiny.includes('>')) {
        pass('formatRunFailure keeps both ends even at a two-character content budget');
      } else {
        fail(`formatRunFailure drops an end at a two-character budget (head=${tiny.includes('<')}, tail=${tiny.includes('>')})`);
      }
    }
  }
} catch (e) {
  fail(`formatRunFailure clipping check: ${e.message}`);
}
console.log('\n73. Gemini evaluator and encoding');

let geminiTmp = null;
try {
  geminiTmp = mkdtempSync(join(ROOT, `${SCRATCH_PREFIX}co-gemini-`));
  const configDir = join(geminiTmp, 'config');
  const modesDir = join(geminiTmp, 'modes', 'tr');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(modesDir, { recursive: true });

  // 1. Create a profile.yml setting modes_dir to modes/tr
  writeFileSync(
    join(configDir, 'profile.yml'),
    '\uFEFFlanguage:\n  modes_dir: modes/tr\n', // Starts with a UTF-8 BOM
    'utf-8'
  );

  // 2. Create localized dummy files in modes/tr/
  // is-ilani.md contains Turkish/Czech characters: Türkiye, Čeština
  writeFileSync(join(modesDir, '_shared.md'), 'Shared Turkish context', 'utf-8');
  writeFileSync(join(modesDir, 'is-ilani.md'), 'Türkiye Čeština logic', 'utf-8');

  // 3. Create other required files
  writeFileSync(join(geminiTmp, 'cv.md'), 'My CV', 'utf-8');
  mkdirSync(join(geminiTmp, 'modes'), { recursive: true });
  writeFileSync(join(geminiTmp, 'modes', '_profile.md'), 'My Profile', 'utf-8');

  // 4. Create a mock job description file with a BOM and UTF-8 characters
  const jdPath = join(geminiTmp, 'mock-jd.txt');
  writeFileSync(jdPath, '\uFEFFJob in Türkiye Čeština with BOM', 'utf-8');

  // Run ROOT/gemini-eval.mjs directly with cwd: geminiTmp.
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync(NODE, [join(ROOT, 'gemini-eval.mjs'), '--file', jdPath, '--no-save'], {
      cwd: geminiTmp,
      env: {
        ...process.env,
        GEMINI_API_KEY: 'mock-api-key-12345'
      },
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000
    });
  } catch (err) {
    stdout = err.stdout || '';
    stderr = err.stderr || '';
  }

  // Assertions:
  if (stdout.includes('Loading context files...')) {
    pass('Gemini evaluator loads files phase started');
  } else {
    fail('Gemini evaluator failed to start file loading phase');
  }

  if (stdout.includes('modes/tr/_shared.md not found') || stdout.includes('modes/tr/is-ilani.md not found')) {
    fail('Gemini evaluator failed to resolve custom modes directory or filenames');
  } else {
    pass('Gemini evaluator resolved custom modes directory (modes/tr/) and localized filenames (is-ilani.md)');
  }

  if (stderr.includes('API_KEY') || stderr.includes('API key')) {
    pass('Gemini evaluator reached API phase with mock key');
  } else {
    fail(`Gemini evaluator failed before reaching API phase or crashed: ${stderr}`);
  }
} catch (e) {
  fail(`Gemini evaluator test crashed: ${e.message}`);
} finally {
  if (geminiTmp && existsSync(geminiTmp)) {
    rmSync(geminiTmp, { recursive: true, force: true });
  }
}
// ── INLINE SECTIONS: END ────────────────────────────────────────

if (INLINE_CHILD !== null) {
  inlineSectionsCompleted = true;
  inlineRunnerFailed = Boolean(process.exitCode);
  // Whatever is still queued for a pipe is lost to an exit; the parent prints
  // the suites straight after, so a cut here would be a hole in mid-log.
  await new Promise((resolve) => process.stdout.write('', resolve));
  await new Promise((resolve) => process.stderr.write('', resolve));
  // exit(), as finish() does: a section may have left a handle open.
  process.exit(0);
}

await runDiscovered();

finish();
