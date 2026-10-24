#!/usr/bin/env node

/**
 * check-liveness.mjs — Playwright job link liveness checker
 *
 * Tests whether job posting URLs are still active or have expired.
 * Uses the same detection logic as scan.md step 7.5.
 * Zero Claude API tokens. Two rungs: a free public-API check first
 * (liveness-api.mjs, no browser), then Playwright for everything else.
 *
 * Usage:
 *   node check-liveness.mjs <url1> [url2] ...
 *   node check-liveness.mjs --file urls.txt
 *
 * Exit code: 0 if all active, 1 if any expired or uncertain
 */

import { chromium } from 'playwright';
import { readFile } from 'fs/promises';
import {
  checkUrlLivenessWithFallback,
  createHeadedPageProvider,
  newLivenessPage,
  createHostSpacer,
  takeSuppressedBlockCount,
  sleep,
} from './liveness-browser.mjs';
import { checkLivenessViaApi } from './liveness-api.mjs';
import { trackerLivenessTargets, DEFAULT_TRACKER_STATUSES } from './liveness-core.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';

const USAGE = `Usage:
  node check-liveness.mjs [--no-fallback] [--throttle[=ms]] <url1> [url2] ...
  node check-liveness.mjs [--no-fallback] [--throttle[=ms]] --file urls.txt
  node check-liveness.mjs --tracker [--status=Evaluated,Applied]   # postings of tracker rows in these statuses
  node check-liveness.mjs --help                  # print this usage block and exit
  node check-liveness.mjs -h                      # alias for --help`;

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }

  // Portals like pracuj.pl serve a Cloudflare anti-bot wall to headless Chromium.
  // On a challenge we retry once in a headed browser (which clears it); pass
  // --no-fallback to stay fully headless (e.g. on a machine with no display).
  const noFallback = args.includes('--no-fallback');
  // --throttle or --throttle=<ms>: wait base..2*base ms (jittered) between browser
  // checks of the same host (createHostSpacer in liveness-browser.mjs)
  // to stay under rate-based WAF limits. pracuj.pl's Cloudflare flags the session
  // after ~2 rapid hits, so a bulk run needs spacing. Default base 5000ms.
  const throttleArg = args.find((a) => a === '--throttle' || a.startsWith('--throttle='));
  const throttleBaseMs = throttleArg ? (Number(throttleArg.split('=')[1]) || 5000) : 0;
  const statusArg = args.find((a) => a.startsWith('--status='));
  const fromTracker = args.includes('--tracker');
  const positional = args.filter((a) => a !== '--no-fallback' && a !== throttleArg
    && a !== '--tracker' && a !== statusArg);

  if (positional.length === 0 && !fromTracker) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  let urls;
  const labels = new Map();
  if (fromTracker) {
    const root = getCareerOpsRoot();
    const trackerPath = resolveTrackerPath(root);
    const reportsRoot = join(root, 'reports');
    if (!existsSync(trackerPath)) {
      console.error(`No tracker at ${trackerPath}. Evaluate a role first.`);
      process.exitCode = 1;
      return;
    }
    const trackerText = readFileSync(trackerPath, 'utf-8');
    const statuses = statusArg ? statusArg.slice('--status='.length).split(',') : DEFAULT_TRACKER_STATUSES;
    const { targets, noUrl } = trackerLivenessTargets(trackerText, { statuses, reportsRoot });
    console.log(`Tracker rows with status ${statuses.join(' or ')}: ${targets.length} with a posting URL${noUrl.length ? `, ${noUrl.length} without (${noUrl.map((n) => `#${n}`).join(' ')})` : ''}`);
    for (const t of targets) labels.set(t.url, `#${t.num} ${t.company} · ${t.role} (${t.status})`);
    urls = targets.map((t) => t.url);
  } else if (positional[0] === '--file') {
    const text = await readFile(positional[1], 'utf-8');
    urls = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } else {
    urls = positional;
  }

  const notes = [
    noFallback ? null : 'headed fallback on challenge',
    throttleBaseMs ? `throttle ~${throttleBaseMs / 1000}-${(throttleBaseMs * 2) / 1000}s` : null,
  ].filter(Boolean);
  console.log(`Checking ${urls.length} URL(s)...${notes.length ? ` (${notes.join(', ')})` : ''}\n`);

  // Lazy browser: the API rung resolves ATS postings with no browser at all, so we
  // only launch Playwright if a URL actually needs the fallback.
  let browser = null, page = null, headed = null;
  async function ensureBrowser() {
    if (browser) return;
    const launched = await chromium.launch({ headless: true });
    try {
      page = await newLivenessPage(launched);
      headed = noFallback ? null : createHeadedPageProvider(chromium);
    } catch (err) {
      // Never leave a launched process behind when setup fails half way.
      await launched.close().catch(() => {});
      throw err;
    }
    browser = launched;
  }

  let active = 0, expired = 0, uncertain = 0, viaApi = 0;
  const verdicts = [];
  // --throttle spaces repeat browser visits to the same host; the API rung is
  // cheap and not WAF-rate-limited, so it never waits.
  const spacer = createHostSpacer(throttleBaseMs);
  // An Ashby board answers for every posting under its org: fetch each board
  // once per run, not once per posting.
  const boardCache = new Map();

  // Sequential — project rule: never Playwright in parallel
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    let result, reason, code;

    // Rung 1: zero-token ATS API check. A conclusive active/expired wins; otherwise fall through.
    const api = await checkLivenessViaApi(url, { boardCache });
    if (api) {
      ({ result, reason, code } = api);
      viaApi++;
    } else {
      // Rung 2: Playwright — handles non-ATS pages and inconclusive API results.
      // A browser that will not launch (missing binaries after a Playwright
      // update, no display) must not end the batch: every URL after it would
      // lose its verdict, including API-checkable ATS URLs that never needed
      // the browser. Report the URLs that needed it as uncertain with the
      // install hint and keep going; the exit code still reflects that they
      // were not confirmed.
      try {
        await ensureBrowser();
        const wait = spacer.waitBefore(url);
        if (wait) await sleep(wait);
        const getHeadedPage = headed ? () => headed.get() : undefined;
        try {
          ({ result, reason, code } = await checkUrlLivenessWithFallback(page, url, { getHeadedPage }));
        } finally {
          // A failed visit counts too: that is when a WAF is most likely involved.
          spacer.visited(url);
        }
      } catch (err) {
        result = 'uncertain';
        code = 'browser_unavailable';
        reason = `browser unavailable (${String(err?.message ?? err).split('\n')[0]}); run \`npx playwright install\` and re-run`;
      }
    }

    const icon = { active: '✅', expired: '❌', uncertain: '⚠️' }[result];
    console.log(`${icon} ${result.padEnd(10)} ${api ? '(api) ' : '      '}${labels.has(url) ? `${labels.get(url)}  ` : ''}${url}`);
    if (result !== 'active') console.log(`           ${reason}`);
    if (result === 'active') active++;
    else if (result === 'expired') expired++;
    else uncertain++;
    verdicts.push({ url, result, code });
  }

  if (headed) await headed.close();
  if (browser) await browser.close();

  console.log(`\nResults: ${active} active  ${expired} expired  ${uncertain} uncertain  (${viaApi} via API, no browser)`);
  const quietBlocks = takeSuppressedBlockCount();
  if (quietBlocks) console.log(`(${quietBlocks} tracker/analytics requests skipped: their host had no usable address, e.g. a DNS ad-blocker; not counted against any posting)`);

  if (expired > 0 || uncertain > 0) process.exitCode = 1;
}

// Only run main() when invoked directly (`node check-liveness.mjs`), not when
// imported — the arg parsing above would otherwise read an importing test's argv.
if (isMainModule(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exitCode = 1;
  });
}
