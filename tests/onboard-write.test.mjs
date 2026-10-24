import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as yaml from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'onboard-write.mjs');

const FICTIONAL_EMAIL = ['avery.quinn', 'example.test'].join('@');

const ANSWERS = {
  candidate: {
    full_name: 'Avery Quinn',
    email: FICTIONAL_EMAIL,
    location: 'Denver, CO',
    linkedin: 'linkedin.com/in/avery-quinn-example',
  },
  target_roles: ['Data Analyst', 'Analytics Engineer'],
  compensation: { target_range: '$95K-120K', currency: 'USD', minimum: '$85K' },
  location: { country: 'United States', city: 'Denver', timezone: 'America/Denver' },
  spend_tier: 'economy',
};

function run(answers, ...flags) {
  const dir = mkdtempSync(join(tmpdir(), 'onboard-write-'));
  mkdirSync(join(dir, 'config'));
  const file = join(dir, 'answers.json');
  writeFileSync(file, JSON.stringify(answers));
  const env = { ...process.env };
  for (const k of ['CAREER_OPS_ROOT', 'CAREER_OPS_DATA_DIR', 'CAREER_OPS_PROFILE', 'CAREER_OPS_PORTALS']) delete env[k];
  const res = spawnSync(process.execPath, [SCRIPT, '--answers', file, '--target', dir, ...flags], { encoding: 'utf8', env });
  return { dir, res, read: (p) => readFileSync(join(dir, p), 'utf8') };
}

function cleanup(dir) { rmSync(dir, { recursive: true, force: true }); }

test('writes the profile from answers and keeps the template comments', () => {
  const { dir, res, read } = run(ANSWERS);
  try {
    assert.equal(res.status, 0, res.stderr);
    const text = read('config/profile.yml');
    const p = yaml.load(text);
    assert.equal(p.candidate.full_name, 'Avery Quinn');
    assert.equal(p.candidate.email, FICTIONAL_EMAIL);
    assert.equal(p.candidate.location, 'Denver, CO');
    assert.equal(p.candidate.linkedin, 'linkedin.com/in/avery-quinn-example');
    assert.deepEqual(p.target_roles.primary, ['Data Analyst', 'Analytics Engineer']);
    assert.equal(p.compensation.target_range, '$95K-120K');
    assert.equal(p.compensation.minimum, '$85K');
    assert.equal(p.location.city, 'Denver');
    assert.equal(p.location.timezone, 'America/Denver');
    assert.equal(p.spend_tier, 'economy');
    assert.match(text, /^# Career-Ops Profile Configuration/);
    assert.ok(p.narrative, 'sections the answers do not cover stay in place');
  } finally { cleanup(dir); }
});

test('contact fields the user did not give are blanked, not left as the example person', () => {
  const { dir, res, read } = run(ANSWERS);
  try {
    assert.equal(res.status, 0, res.stderr);
    const p = yaml.load(read('config/profile.yml'));
    for (const key of ['phone', 'portfolio_url', 'github', 'twitter']) {
      assert.equal(p.candidate[key], '', `${key} should be blank`);
    }
    assert.doesNotMatch(JSON.stringify(p.candidate), /janesmith|Jane Smith|555-0123/);
  } finally { cleanup(dir); }
});

test('existing files are kept unless --force, and the summary says which', () => {
  const { dir, res } = run(ANSWERS);
  try {
    assert.equal(res.status, 0, res.stderr);
    const env = { ...process.env };
    delete env.CAREER_OPS_ROOT;
    const again = spawnSync(process.execPath, [SCRIPT, '--answers', join(dir, 'answers.json'), '--target', dir], { encoding: 'utf8', env });
    assert.equal(again.status, 0, again.stderr);
    const out = JSON.parse(again.stdout);
    assert.deepEqual(out.written, []);
    assert.deepEqual(out.kept, ['config/profile.yml']);
    const forced = spawnSync(process.execPath, [SCRIPT, '--answers', join(dir, 'answers.json'), '--target', dir, '--force'], { encoding: 'utf8', env });
    assert.equal(forced.status, 0, forced.stderr);
    assert.deepEqual(JSON.parse(forced.stdout).written, ['config/profile.yml']);
  } finally { cleanup(dir); }
});

test('a flag with no value, or with another flag as its value, exits 1 and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onboard-write-'));
  try {
    const file = join(dir, 'answers.json');
    writeFileSync(file, JSON.stringify(ANSWERS));
    const env = { ...process.env };
    delete env.CAREER_OPS_ROOT;
    for (const args of [['--answers', file, '--target'], ['--answers', '--force']]) {
      const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
      assert.equal(res.status, 1, args.join(' '));
      assert.match(res.stderr, /needs a value/, args.join(' '));
    }
    assert.equal(existsSync(join(dir, 'config', 'profile.yml')), false);
  } finally { cleanup(dir); }
});

test('a forced rewrite replaces the file whole and leaves no temp files behind', () => {
  const { dir, res } = run(ANSWERS);
  try {
    assert.equal(res.status, 0, res.stderr);
    const env = { ...process.env };
    delete env.CAREER_OPS_ROOT;
    const again = spawnSync(process.execPath, [SCRIPT, '--answers', join(dir, 'answers.json'), '--target', dir, '--force'], { encoding: 'utf8', env });
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
    assert.deepEqual(readdirSync(join(dir, 'config')).filter((f) => f.endsWith('.tmp')), []);
    assert.equal(yaml.load(readFileSync(join(dir, 'config', 'profile.yml'), 'utf8')).candidate.full_name, 'Avery Quinn');
  } finally { cleanup(dir); }
});

test('a salary range without its currency exits 1 instead of assuming USD', () => {
  const answers = { ...ANSWERS, compensation: { target_range: '95-120K' } };
  const { dir, res } = run(answers);
  try {
    assert.equal(res.status, 1);
    assert.match(res.stderr, /compensation\.currency/);
  } finally { cleanup(dir); }
});

test('a missing required answer exits 1, names the field, and writes nothing', () => {
  const answers = { ...ANSWERS, candidate: { ...ANSWERS.candidate, full_name: '' } };
  const { dir, res } = run(answers);
  try {
    assert.equal(res.status, 1);
    assert.match(res.stderr, /candidate\.full_name/);
    assert.equal(existsSync(join(dir, 'config', 'profile.yml')), false);
    assert.equal(existsSync(join(dir, 'config', 'profile.yml')), false);
  } finally { cleanup(dir); }
});

test('archetypes and narrative replace the example person, and proof points never carry over', () => {
  const answers = {
    ...ANSWERS,
    archetypes: [{ name: 'Product Analyst', level: 'Entry', fit: 'primary' }, { name: 'BI Developer', level: 'Entry', fit: 'adjacent' }],
    narrative: { headline: 'Analyst who ships dashboards people use', superpowers: ['SQL', 'Clear charts'] },
  };
  const { dir, res, read } = run(answers);
  try {
    assert.equal(res.status, 0, res.stderr);
    const p = yaml.load(read('config/profile.yml'));
    assert.deepEqual(p.target_roles.archetypes, answers.archetypes);
    assert.equal(p.narrative.headline, 'Analyst who ships dashboards people use');
    assert.equal(p.narrative.exit_story, '');
    assert.deepEqual(p.narrative.superpowers, ['SQL', 'Clear charts']);
    assert.deepEqual(p.narrative.proof_points, []);
    assert.doesNotMatch(read('config/profile.yml'), /Project Alpha|ML Engineer turned/);
  } finally { cleanup(dir); }
});

test('AGENTS.md onboarding calls the writer and builds the finish from doctor', () => {
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  const first = agents.split('### First Run')[1].split('### Personalization')[0];
  const steps23 = first.split('#### Step 2')[1].split('#### Step 4')[0];
  assert.match(steps23, /node onboard-write\.mjs --answers/);
  assert.match(steps23, /rerun with `--force`/);
  assert.match(first.split('#### Step 2')[1].split('#### Step 3')[0], /salary target range and its currency/i);
  const step6 = first.split('#### Step 6')[1];
  assert.match(step6, /node doctor\.mjs/);
  assert.match(step6, /only[^.]*fail/i);
  assert.match(step6, /playwright install chromium/);
});
