// tests/verify-edit-table.test.mjs — the resume-improvement edit table is
// checked against cv.md (originals) and the fact gate (replacements).
//
// Run:  node --test tests/verify-edit-table.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyEditTable } from '../verify-edit-table.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CV_PATH = join(ROOT, 'examples', 'cv-example.md');
const cv = readFileSync(CV_PATH, 'utf-8');

const HEAD = '| Original text | Replacement text | Justification | Where |\n|---|---|---|---|\n';
const GOOD = '- Set up experiment tracking with MLflow and model versioning';
const table = (...rows) => HEAD + rows.join('\n') + '\n';

test('a truthful reformulation passes', () => {
  const result = verifyEditTable(table(
    '| Set up experiment tracking with MLflow and model versioning | Set up MLOps experiment tracking with MLflow and model versioning | JD asks for MLOps | Work Experience > DataStartup Inc > bullet 3 |',
    '| Implemented search ranking with learning-to-rank models | (move to top of role; text unchanged) | Search ranking is the JD\'s core requirement | Work Experience > DataStartup Inc > bullet 2 -> 1 |',
  ), cv);
  assert.deepEqual(result.findings, []);
  assert.equal(result.rows, 2);
  assert.equal(result.replacements.length, 1);
});

test('an original that cv.md does not contain is rejected', () => {
  const { findings } = verifyEditTable(table('| Led a team of 40 engineers | Led a team of 40 | x | y |'), cv);
  assert.match(findings.join('\n'), /not quoted from cv\.md/);
});

test('empty justification or where is rejected', () => {
  const { findings } = verifyEditTable(table(`| ${GOOD.slice(2)} | Set up MLOps tracking | | |`), cv);
  assert.match(findings.join('\n'), /Justification is empty/);
  assert.match(findings.join('\n'), /Where is empty/);
});

test('a missing table is reported', () => {
  assert.match(verifyEditTable('no table here', cv).findings[0], /no table with columns/);
});

test('the CLI fails an invented metric and passes a clean table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'edit-table-test-'));
  try {
    const run = (rows) => {
      const file = join(dir, 'edits.md');
      writeFileSync(file, table(...rows));
      return spawnSync(process.execPath, [join(ROOT, 'verify-edit-table.mjs'), file, '--cv', CV_PATH], { encoding: 'utf-8', cwd: dir });
    };
    const clean = run(['| Set up experiment tracking with MLflow and model versioning | Set up experiment tracking with MLflow | JD wording | Work Experience > DataStartup Inc > bullet 3 |']);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    const invented = run(['| Set up experiment tracking with MLflow and model versioning | Set up experiment tracking with MLflow for 400 data scientists | JD wording | Work Experience > DataStartup Inc > bullet 3 |']);
    assert.notEqual(invented.status, 0, 'an invented metric must fail the fact gate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
