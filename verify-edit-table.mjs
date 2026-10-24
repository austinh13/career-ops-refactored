#!/usr/bin/env node

/**
 * Verify a resume-improvement edit table (`modes/improve.md`).
 *
 * The table has four columns: Original text | Replacement text | Justification | Where.
 *   1. Every Original cell must be quoted from cv.md (markup and whitespace
 *      normalized), so an edit can never be anchored to text the CV does not have.
 *   2. Every Replacement cell is run through the fact gate (verify-cv-facts.mjs),
 *      the same hard gate the other CV modes use. A Replacement that starts with
 *      "(" is a directive such as "(move to top of role)" and carries no new text.
 *   3. Justification and Where must not be empty.
 *
 * Usage:
 *   node verify-edit-table.mjs <edit-table.md> [--cv cv.md]
 *
 * Exit 0 when clean, 1 on any finding.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const HEADER = ['original text', 'replacement text', 'justification', 'where'];

const normalize = (text) => text
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/\*\*|__|`/g, '')
  .replace(/^[-*•]\s+/, '')
  .replace(/[“”]/g, '"')
  .replace(/[‘’]/g, "'")
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

function splitRow(line) {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/);
  return cells.map((cell) => cell.replace(/\\\|/g, '|').trim());
}

/** Parse the first four-column table whose header matches HEADER. */
export function parseEditTable(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const cells = splitRow(line).map((cell) => cell.toLowerCase());
    return line.includes('|') && HEADER.every((name, i) => cells[i] === name);
  });
  if (start === -1) return null;
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.trim().startsWith('|')) break;
    rows.push(splitRow(line));
  }
  return rows;
}

export function verifyEditTable(tableMarkdown, cvMarkdown) {
  const rows = parseEditTable(tableMarkdown);
  if (!rows) return { rows: 0, findings: [`no table with columns: ${HEADER.join(' | ')}`], replacements: [] };
  const cv = normalize(cvMarkdown);
  const findings = [];
  const replacements = [];
  rows.forEach((cells, i) => {
    const n = i + 1;
    if (cells.length !== 4) return findings.push(`row ${n}: expected 4 columns, found ${cells.length}`);
    const [original, replacement, justification, where] = cells;
    if (!original || !cv.includes(normalize(original))) findings.push(`row ${n}: Original text is not quoted from cv.md: "${original.slice(0, 80)}"`);
    if (!replacement) findings.push(`row ${n}: Replacement text is empty`);
    else if (!replacement.startsWith('(')) replacements.push(replacement.replace(/<br\s*\/?>/gi, '\n'));
    if (!justification) findings.push(`row ${n}: Justification is empty`);
    if (!where) findings.push(`row ${n}: Where is empty`);
  });
  if (rows.length === 0) findings.push('the table has no rows');
  return { rows: rows.length, findings, replacements };
}

function runCli(args) {
  const cvIndex = args.indexOf('--cv');
  const cvPath = cvIndex === -1 ? join(getCareerOpsRoot(), 'cv.md') : args[cvIndex + 1];
  const file = args.filter((_, i) => i !== cvIndex && i !== cvIndex + 1)[0];
  if (!file || !existsSync(file) || !existsSync(cvPath)) {
    console.error('Usage: node verify-edit-table.mjs <edit-table.md> [--cv cv.md]');
    return 1;
  }
  const { rows, findings, replacements } = verifyEditTable(readFileSync(file, 'utf-8'), readFileSync(cvPath, 'utf-8'));
  for (const finding of findings) console.error(`❌ ${finding}`);

  let gateFailed = false;
  if (replacements.length) {
    const dir = mkdtempSync(join(tmpdir(), 'edit-table-'));
    try {
      const replacementFile = join(dir, 'replacements.md');
      writeFileSync(replacementFile, replacements.map((text) => `- ${text}`).join('\n') + '\n');
      const gate = spawnSync(process.execPath, [fileURLToPath(new URL('./verify-cv-facts.mjs', import.meta.url)), replacementFile, '--source', cvPath, '--source', join(getCareerOpsRoot(), 'article-digest.md')], { encoding: 'utf-8' });
      process.stdout.write(gate.stdout || '');
      process.stderr.write(gate.stderr || '');
      gateFailed = gate.status !== 0;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (findings.length || gateFailed) return 1;
  console.log(`✅ ${rows} edit rows verified: originals quoted from cv.md, replacements pass the fact gate`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = runCli(process.argv.slice(2));
