# Data Contract

This document defines which files belong to the **system** (code, prompts and templates) and which belong to the **user** (your personal data and work product). System files never contain user data; user files are never rewritten by system changes.

## User Layer

These files contain your personal data, customizations, and work product. Only these system-owned `.gitkeep` scaffolds may be created or replaced inside user-layer directories: `data/.gitkeep`, `jds/.gitkeep`, `output/.gitkeep`, and `reports/.gitkeep`. No other user file in those directories is ever modified.

| File | Purpose |
|------|---------|
| `cv.md` | Your CV in markdown |
| `config/profile.yml` | Your identity, targets, comp range |
| `config/cv-facts.json` | Your CV fact-check allowlist and forbidden phrases |
| `modes/_profile.md` | Your archetypes, narrative, location policy |
| `modes/_custom.md` | Your house rules, custom workflows & output preferences (procedural) |
| `modes/_brief.md` | Your compact profile brief (~1.5–2K tokens) read by the two-pass triage first pass |
| `voice-dna.md` | Your writing voice guardrail — banned words, anti-AI-slop rules, tone (optional) |
| `article-digest.md` | Your proof points from portfolio |
| `writing-samples/*` | Your personal writing samples for style calibration (except `writing-samples/README.md`, which is system-owned documentation) |
| `documents/*` | Your profile intake sources — master CV, LinkedIn export, diplomas, reference letters (PII; read locally by `intake.mjs`, see `modes/intake.md`). `documents/README.md` is system-owned |
| `data/applications.md` | Your tracker of graded roles (source of truth) |
| `data/career-profile.yml` | Your source-backed Master Career Profile; written only after explicit review of imported CV facts |
| `data/pipeline.md` | Your URL inbox |
| `data/pdf-index.tsv` | PDF↔report linkage manifest (written by `generate-pdf.mjs`, read by `find.mjs`) |
| `data/intake-state.json` | Fingerprints of already-ingested intake sources (written by `node intake.mjs --commit`; safe to delete, the next intake re-proposes everything) |
| `data/blacklist.md` | Your do-not-apply list (opt-in — absence = no filtering; never auto-populated: only you, or the agent on your explicit instruction, write to it. Its `Scope` is `company` (default) or `domain`; no parent/subsidiary relationship is inferred. Respected by the `auto-pipeline`/`oferta` gates; never a scoring input) |
| `data/status-log.tsv` (sibling of the active tracker file) | Append-only status transition ledger, if present |
| `reports/*` | Your evaluation reports, including optional `job_facts_cache` metadata. `evaluation-cache.mjs` projects only the public allowlist documented in `batch/batch-prompt.md`; candidate-fit data never enters the reusable job-facts payload |
| `batch/tracker-additions/*.tsv` | Pending tracker rows, one TSV per evaluation (gitignored). `merge-tracker.mjs` reads them from the data root, not the checkout |
| `output/*` | Your resume edit tables, generated PDFs and CV HTML |
| `jds/*` | Your saved job descriptions |
| `templates/cv-{candidate}-{company-slug}.html` | Your per-application generated CVs, for installs that save the HTML twin under `templates/` instead of `output/`. Anything under `templates/` starting with `cv-` that is NOT one of the shipped `cv-template*.html` files is your data |
| `templates/cv-template.{name}.html` / `.tex` | Your own named CV template variant, when `{name}` matches `cv.template` in `config/profile.yml` (the convention `cv-templates.mjs`'s `resolveTemplate()` reads). `templates/` is otherwise system-owned |

## System Layer

These files contain system logic, scripts, templates, and instructions.

| File | Purpose |
|------|---------|
| `modes/_shared.md` | Eval-core: scoring system, global rules, tools |
| `modes/_writing.md` | Writing guardrails (Voice DNA / Writing Style / ATS) — loaded by the CV writing modes, not by evaluation |
| `modes/_custom.template.md` / `_profile.template.md` / `_brief.template.md` | Template seeds for the user's `modes/_custom.md` / `_profile.md` / `_brief.md` |
| `modes/oferta.md` / `ofertas.md` / `triage.md` / `pipeline.md` / `batch.md` / `auto-pipeline.md` | Job grading mode instructions |
| `modes/oferta-signals/*` | Block G posting-legitimacy signal checks read on demand by `oferta.md` |
| `modes/improve.md` / `modes/pdf.md` / `modes/pdf/*` / `latex.md` / `latex-tex.md` / `text.md` / `ats.md` | Resume tailoring and checking mode instructions |
| `modes/add.md` / `expand.md` / `master-profile.md` / `intake.md` | Resume content-building mode instructions |
| `modes/heuristics/*` | Shared candidate-facing writing heuristics |
| `modes/{ar,da,de,es,fr,hi,id,it,ja,ko,nl,pl,pt,ru,sg,tr,ua,vi,zh,zh-TW}/*` | Language and market evaluation modes |
| `CLAUDE.md` / `OPENCODE.md` / `CODEX.md` / `KIMI.md` / `GEMINI.md` | Agent instruction wrappers (`GEMINI.md` is a legacy no-op context guard) |
| `AGENTS.md` | Canonical agent instructions (imported by CLI-specific wrappers) |
| `*.mjs`, `lib/*`, `utils/*`, `scripts/*` | Utility scripts |
| `dashboard/*` | Local dashboard page (served by `dashboard.mjs`) |
| `providers/` | Shared HTTP guards and the few ATS parsers used for JD extraction and liveness |
| `batch/batch-prompt.md` / `batch-runner.sh` / `*.mjs` | Batch worker prompt, orchestrator and helpers |
| `evals/*` | Golden evaluation set |
| `templates/*` | Base CV templates, the tracker states table and jurisdiction tables |
| `fonts/*` | Self-hosted fonts |
| `examples/*` | Example CV, profile and report |
| `.agents/skills/*` (and the symlinked per-CLI skill folders) | Skill definitions |
| `VERSION` | Current version number |
| `DATA_CONTRACT.md` | This file |

## The Rule

**If a file is user-owned, no script or system change may modify or delete it.** The only files scripts write inside user-layer directories are the ones documented above (tracker, reports, generated CVs, indexes).

**If a file is in the System Layer, it can be safely replaced with a newer version of the repository.**

## Custom Data Directory

By default, all User Layer files reside inside the project repository root. You can configure a separate, external directory for your personal data.

### Resolution Precedence:
1. **Environment Variables (`CAREER_OPS_ROOT` or `CAREER_OPS_DATA_DIR`):** Set this to the absolute or relative path of your custom data directory.
2. **Marker File (`.career-ops-data`):** A repository-level marker file named `.career-ops-data` containing the path (absolute or relative) to the user data directory.
3. **Repository Default:** Defaults to the codebase/repository root directory.

When resolved, all User Layer files/directories (e.g. `cv.md`, `config/profile.yml`, `modes/_profile.md`, `modes/_custom.md`, `data/`, `reports/`, `output/`, `batch/tracker-additions/`) are resolved relative to that path. System Layer files stay in the repository.

### Tracker Path & Writes:
- **`CAREER_OPS_TRACKER`** can be set to override the applications tracker file path directly (relative paths are resolved relative to the repository root).
- **Read Resolution:** If no tracker override is set, reading resolves to `{DATA_ROOT}/data/applications.md` if it exists; otherwise falls back to `{DATA_ROOT}/applications.md`.
- **Write Resolution:** All writes (including merge operations and first-run creation) target the canonical location `{DATA_ROOT}/data/applications.md`.
