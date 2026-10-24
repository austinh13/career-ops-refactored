#!/usr/bin/env node
// Writes config/profile.yml from one JSON file of onboarding answers. The
// template is copied line for line and only the answered fields change, so
// every comment survives.

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadYaml } from './lib/yaml-document.mjs';
import { getCareerOpsRoot, getProfilePath } from './path-resolver.mjs';
import { writeFileAtomic } from './tracker-utils.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const PROFILE_TEMPLATE = join(CODE_ROOT, 'config', 'profile.example.yml');
const CONTACT_KEYS = ['phone', 'linkedin', 'portfolio_url', 'github', 'twitter'];

const USAGE = `
  onboard-write.mjs: write config/profile.yml from onboarding answers

  node onboard-write.mjs --answers <file.json | -> [--target <dir>] [--force]

  An existing file is kept unless --force. Prints {"written":[],"kept":[]} as JSON.
  Answers shape:
  {
    "candidate": { "full_name", "email", "location", "phone"?, "linkedin"?, "portfolio_url"?, "github"?, "twitter"? },
    "target_roles": ["..."],
    "compensation": { "target_range", "currency"?, "minimum"?, "location_flexibility"? },
    "location": { "country", "timezone", "city"?, "visa_status"?, "authorized_in"?, "needs_sponsorship"? },
    "spend_tier": "economy" | "standard" | "premium",
    "archetypes": [{ "name", "level", "fit": "primary" | "secondary" | "adjacent" }]?,
    "narrative": { "headline"?, "exit_story"?, "superpowers"?: ["..."], "proof_points"?: [{ "name", "url"?, "hero_metric"? }] }?
  }
`;

class AnswerError extends Error {}

function parseArgs(argv) {
  const opts = { force: false };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || (v.startsWith('-') && v !== '-')) throw new AnswerError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--answers') opts.answers = value(++i, a);
    else if (a === '--target') opts.target = value(++i, a);
    else if (a === '--force') opts.force = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new AnswerError(`unknown argument: ${a}`);
  }
  return opts;
}

function list(value) {
  return Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : [];
}

function required(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new AnswerError(`missing answer: ${field}`);
  return text;
}

export function normalizeAnswers(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const candidate = a.candidate || {};
  const location = a.location || {};
  const compensation = a.compensation || {};
  const roles = list(a.target_roles);
  if (!roles.length) throw new AnswerError('missing answer: target_roles');
  const tier = a.spend_tier ?? 'standard';
  if (!['economy', 'standard', 'premium'].includes(tier)) {
    throw new AnswerError(`spend_tier must be economy, standard or premium, got "${tier}"`);
  }
  const archetypes = Array.isArray(a.archetypes) ? a.archetypes.map((x, i) => ({
    name: required(x?.name, `archetypes[${i}].name`),
    level: x?.level?.trim() || '',
    fit: ['primary', 'secondary', 'adjacent'].includes(x?.fit) ? x.fit : 'primary',
  })) : [];
  const narrative = a.narrative || {};
  return {
    candidate: {
      full_name: required(candidate.full_name, 'candidate.full_name'),
      email: required(candidate.email, 'candidate.email'),
      location: required(candidate.location, 'candidate.location'),
      ...Object.fromEntries(CONTACT_KEYS.map((k) => [k, typeof candidate[k] === 'string' ? candidate[k].trim() : ''])),
    },
    target_roles: roles,
    compensation: {
      target_range: required(compensation.target_range, 'compensation.target_range'),
      currency: required(compensation.currency, 'compensation.currency'),
      minimum: compensation.minimum?.trim() || '',
      location_flexibility: compensation.location_flexibility?.trim() || '',
    },
    location: {
      country: required(location.country, 'location.country'),
      city: location.city?.trim() || '',
      timezone: required(location.timezone, 'location.timezone'),
      visa_status: location.visa_status?.trim() || '',
      authorized_in: list(location.authorized_in),
      needs_sponsorship: location.needs_sponsorship === true,
    },
    spend_tier: tier,
    archetypes,
    narrative: {
      headline: narrative.headline?.trim() || '',
      exit_story: narrative.exit_story?.trim() || '',
      superpowers: list(narrative.superpowers),
      proof_points: (Array.isArray(narrative.proof_points) ? narrative.proof_points : []).map((x, i) => ({
        name: required(x?.name, `narrative.proof_points[${i}].name`),
        url: x?.url?.trim() || '',
        hero_metric: x?.hero_metric?.trim() || '',
      })),
    },
  };
}

const q = (s) => JSON.stringify(s);

function sectionBounds(lines, section) {
  const start = lines.findIndex((l) => l === `${section}:`);
  if (start < 0) throw new Error(`template has no top-level "${section}:"`);
  let end = start + 1;
  while (end < lines.length && !/^[A-Za-z_]/.test(lines[end])) end++;
  return [start, end];
}

function keyLine(lines, section, key) {
  const [start, end] = sectionBounds(lines, section);
  for (let i = start + 1; i < end; i++) {
    if (lines[i].startsWith(`  ${key}:`)) return i;
  }
  throw new Error(`template has no ${section}.${key}`);
}

function setScalar(lines, section, key, value) {
  const i = keyLine(lines, section, key);
  const comment = lines[i].match(/\s+#[^"]*$/)?.[0] ?? '';
  lines[i] = `  ${key}: ${value}${comment}`;
}

function replaceNested(lines, at, nested) {
  let end = at + 1;
  while (end < lines.length && lines[end].startsWith('    ')) end++;
  lines.splice(at + 1, end - at - 1, ...nested);
}

function setList(lines, section, key, items) {
  const at = keyLine(lines, section, key);
  if (items.length) {
    lines[at] = `  ${key}:`;
    replaceNested(lines, at, items);
  } else {
    lines[at] = `  ${key}: []`;
    replaceNested(lines, at, []);
  }
}

function replaceItems(lines, at, items, indent) {
  let end = at + 1;
  while (end < lines.length && lines[end].startsWith(`${indent}- `)) end++;
  lines.splice(at + 1, end - at - 1, ...items.map((s) => `${indent}- ${q(s)}`));
}

export function buildProfile(template, a) {
  const lines = template.split('\n');
  for (const [k, v] of Object.entries(a.candidate)) setScalar(lines, 'candidate', k, q(v));
  replaceItems(lines, keyLine(lines, 'target_roles', 'primary'), a.target_roles, '    ');
  setList(lines, 'target_roles', 'archetypes', a.archetypes.map((x) => `    - { name: ${q(x.name)}, level: ${q(x.level)}, fit: ${x.fit} }`));
  setScalar(lines, 'narrative', 'headline', q(a.narrative.headline));
  setScalar(lines, 'narrative', 'exit_story', q(a.narrative.exit_story));
  setList(lines, 'narrative', 'superpowers', a.narrative.superpowers.map((x) => `    - ${q(x)}`));
  setList(lines, 'narrative', 'proof_points', a.narrative.proof_points.map((x) => `    - { name: ${q(x.name)}, url: ${q(x.url)}, hero_metric: ${q(x.hero_metric)} }`));
  for (const [k, v] of Object.entries(a.compensation)) setScalar(lines, 'compensation', k, q(v));
  const { authorized_in, needs_sponsorship, ...loc } = a.location;
  for (const [k, v] of Object.entries(loc)) setScalar(lines, 'location', k, q(v));
  setScalar(lines, 'location', 'authorized_in', `[${authorized_in.map(q).join(', ')}]`);
  setScalar(lines, 'location', 'needs_sponsorship', String(needs_sponsorship));
  const tier = lines.findIndex((l) => l.startsWith('spend_tier:'));
  if (tier < 0) throw new Error('template has no spend_tier');
  lines[tier] = `spend_tier: ${a.spend_tier}`;
  return lines.join('\n');
}

function checkProfile(text, a) {
  const p = loadYaml(text);
  const ok = p.candidate.full_name === a.candidate.full_name
    && JSON.stringify(p.target_roles.primary) === JSON.stringify(a.target_roles)
    && p.location.country === a.location.country
    && p.spend_tier === a.spend_tier;
  if (!ok) throw new Error('profile.yml did not read back as written');
}

function readAnswers(source) {
  if (!source) throw new AnswerError('--answers <file.json | -> is required');
  const text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(source), 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new AnswerError(`answers are not valid JSON: ${err.message}`);
  }
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  const answers = normalizeAnswers(readAnswers(opts.answers));
  const root = opts.target ? resolve(opts.target) : getCareerOpsRoot();
  const target = {
    rel: 'config/profile.yml',
    path: getProfilePath(opts.target ? root : undefined),
  };
  const keep = existsSync(target.path) && !opts.force;
  if (!keep) {
    const text = buildProfile(readFileSync(PROFILE_TEMPLATE, 'utf8'), answers);
    checkProfile(text, answers);
    mkdirSync(dirname(target.path), { recursive: true });
    writeFileAtomic(target.path, text);
  }
  console.log(JSON.stringify({
    written: keep ? [] : [target.rel],
    kept: keep ? [target.rel] : [],
  }));
  return 0;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`onboard-write: ${err.message}`);
    if (err instanceof AnswerError) console.error(USAGE);
    process.exitCode = 1;
  }
}
