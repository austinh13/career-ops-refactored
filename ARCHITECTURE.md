# Architecture

A high-level map of how career-ops is put together. For the precise system/user file boundary, see [DATA_CONTRACT.md](DATA_CONTRACT.md); for contribution mechanics, see [CONTRIBUTING.md](CONTRIBUTING.md).

This fork keeps two functions: **job grading** and **resume improvement**.

## Principles

- **Local-first.** Everything runs on your machine against your files. No account required, no server in the loop.
- **AI-agnostic.** The logic lives in Markdown prompt files under `modes/`, executed by whatever AI coding CLI you use (Claude Code, Codex, OpenCode, Qwen, Grok, Antigravity, Pi, Kimi) or by standalone Node scripts. No single model is hardcoded.
- **Human-in-the-loop.** The tool grades and prepares; the human decides and sends. It never submits anything on your behalf.

## The two layers (the data contract)

**System files** and **user files** are strictly separated.

- **System layer** — the tool itself: `modes/`, scripts (`*.mjs`), `templates/`, `batch/` scripts.
- **User layer** — your data: `cv.md`, `config/profile.yml`, `modes/_profile.md`, `data/`, `reports/`, `jds/`, `output/`, etc.

`DATA_CONTRACT.md` is the source of truth for this boundary.

## Files are canonical

The human-readable, git-diffable files (`data/applications.md`, `reports/`, `data/pipeline.md`) are the permanent source of truth. Nothing here depends on a database.

## Why the flat root

Scripts live at the repository root deliberately: path stability is a feature (`node merge-tracker.mjs`, `node generate-pdf.mjs`). One script = one job. Tests live in `tests/`; `test-all.mjs` discovers `tests/**/*.test.mjs` with no registration list, so a new suite runs the moment it is written. `*.test.mjs` at the repo root is not discovered and will not run.

## Component map

```
AI coding CLI  ─┐
(or scripts)    │  reads prompt files
                ▼
   modes/*.md  ──────────────►  the "brain": scoring, evaluation,
   (_shared.md = scoring core)   CV tailoring prompts
                │
   ┌────────────┼──────────────────────────┐
   ▼            ▼                          ▼
 verify      grade                      tailor
 liveness    oferta.md                  pdf.md / latex.md / text.md
 fetch-jd    (+ eval scripts)           verify-cv-facts / verify-ats
```

### Verification — never grade a dead posting
`check-liveness.mjs` / `liveness-*.mjs` check a posting against public ATS APIs first (zero-token) and a real browser second. `fetch-jd.mjs` and `browser-extract.mjs` fetch the JD text; `archive-posting.mjs` and `check-jd-archive.mjs` keep every report's JD on file.

### Grading — `modes/oferta.md` + `modes/_shared.md`
`oferta.md` defines the A–G evaluation blocks, verdict and risk summary; `_shared.md` defines the 1–5 scoring system, archetype detection, posting-legitimacy signals, and global rules. `modes/oferta-signals/` holds the Block G legitimacy checks read on demand, backed by the jurisdiction tables in `templates/`. `triage.md` is a cheap first pass, `ofertas.md` compares offers, `pipeline.md` and `batch.md` grade many postings, `auto-pipeline.md` chains grading and CV tailoring.

**Standalone evaluators** run the same scoring without an interactive CLI: `gemini-eval.mjs`, `ollama-eval.mjs`, `openai-eval.mjs`, `openrouter-runner.mjs`, and `batch-evaluate-gemini.mjs` for batches. `evals/` and `eval-golden.mjs` hold the golden set that keeps them consistent.

### Resume improvement — CVs, ATS, profile
`modes/improve.md` is the default: it runs the improvement analysis and returns a table of edits to `cv.md` (original, replacement, justification, where), checked by `verify-edit-table.mjs`. `modes/pdf.md` builds a tailored CV payload; `build-cv-html.mjs` / `build-cv-latex.mjs` render it through `templates/`; `generate-pdf.mjs` (Playwright) and `generate-latex.mjs` produce the files. Gates: `verify-cv-facts.mjs` (every claim traces to `cv.md`), `cv-title-check.mjs`, `verify-cv-structure.mjs`, `verify-ats.mjs`, `keyword-match.mjs`, `jd-skill-gap.mjs`. `add`, `expand`, `master-profile` and `intake` grow `cv.md` and the profile from real evidence, always confirm-before-write.

### Tracking — `data/` + `reports/` + tracker scripts
Every graded offer is registered. `data/applications.md` is the tracker table; `reports/{NNN}-{company}-{date}.md` holds full evaluations. `merge-tracker.mjs`, `dedup-tracker.mjs`, `normalize-statuses.mjs`, `fix-report-links.mjs` and `reconcile-pipeline.mjs` keep it consistent (atomic writes). Report numbers are claimed atomically via `reserve-report-num.mjs`.

### Multi-CLI entry files
`CLAUDE.md`, `OPENCODE.md` and `CODEX.md` are thin `@AGENTS.md` wrappers around the canonical `AGENTS.md`. `GEMINI.md` is a legacy no-op guard. The `.agents/skills/` entrypoint follows the [open agent skill standard](https://agentskills.io); the per-CLI skill folders symlink to it.

## Data flow (a typical run)

```
paste JD/URL ──► liveness check ──► oferta + cv.md ──► reports/NNN-*.md ──► data/applications.md
                                                            │
                                                            └──► improve mode ──► fact-checked edit table (pdf mode: fresh CV)
```

## Quality gates

- `test-all.mjs` — the full suite.
- CI: `test` + CodeQL.

## Where to start reading

- The boundary → `DATA_CONTRACT.md`
- The scoring → `modes/_shared.md` + `modes/oferta.md`
- The CV flow → `modes/improve.md` (and `modes/pdf.md` for the fresh-CV path)
