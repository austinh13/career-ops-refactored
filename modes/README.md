# modes/

The "brain" of career-ops: Markdown prompt files executed by whatever AI
coding CLI you use.

## Purpose

Each mode file defines one workflow (evaluate a job, tailor a CV, ...). The agent
reads the mode plus the shared context and your user files, then executes it.
Routing — which user request triggers which mode — lives in the Skill Modes
table in `AGENTS.md` (mirrored in `CLAUDE.md`).

## Mode catalog

| File | Mode | Purpose |
|---|---|---|
| `oferta.md` | `oferta` | Full A-G evaluation of a single offer (1-5 score, verdict, risk summary) |
| `ofertas.md` | `ofertas` | Multi-job comparison |
| `auto-pipeline.md` | (paste a JD/URL) | Full automatic pipeline (evaluate + tailored CV + tracker row) on a pasted JD/URL |
| `pipeline.md` | `pipeline` | Process the URL inbox (`data/pipeline.md`) |
| `triage.md` | `triage` | Fast first-pass quick score before full evaluation |
| `batch.md` | `batch` | Mass evaluation with headless workers |
| `improve.md` | `improve` | Resume improvement table: original text, replacement text, justification, where (default, no PDF) |
| `pdf.md` | `pdf` | ATS-optimized tailored CV (PDF) |
| `ats.md` | `ats` | ATS-friendliness check of a generated CV (parseability score + issues) |
| `latex.md` | `latex` | LaTeX/Overleaf CV export |
| `latex-tex.md` | `latex-tex` | Tailor your own hand-maintained `.tex` CV in place (opt-in) |
| `text.md` | `text` | Tailored markdown CV (no PDF) |
| `master-profile.md` | `master-profile` | Source-backed Master Career Profile import and review |
| `intake.md` | `intake` | Build or enrich the profile and CV from documents in `documents/` (confirm-before-write) |
| `add.md` | `add` | Add a project, paper, or role to the CV (confirm-before-write) |
| `expand.md` | `expand` | Discover competencies missing from the CV (confirm-before-write) |

## Shared context and user customization

| File | Role |
|---|---|
| `_shared.md` | System context shared across modes: scoring system, global rules, source-of-truth boundary. System-owned — never put personal data here |
| `_profile.template.md` | Seed for your `modes/_profile.md` (archetypes, narrative, negotiation scripts) |
| `_custom.template.md` | Seed for your `modes/_custom.md` (house rules, procedural preferences) |
| `_brief.template.md` | Seed for your `modes/_brief.md` (compact context for `triage`) |
| `_writing.md` | Shared writing guidance (Voice DNA, writing style, ATS rules) loaded by modes that write candidate-facing prose |

Your copies (`_profile.md`, `_custom.md`, `_brief.md`) are user-layer files: gitignored
and are never overwritten by system changes (see
[DATA_CONTRACT.md](../DATA_CONTRACT.md)).

## Subdirectories

| Dir | Contents |
|---|---|
| `heuristics/` | Shared candidate-facing writing heuristics loaded by other modes — `recruiter-side.md` governs PDF summaries and bullets |
| `oferta-signals/` | Block G posting-legitimacy signal checks that `oferta.md` reads on demand, not routable modes |
| `pdf/` | Opt-in passes inside the `pdf` flow, not routable modes — `hm-audit.md` is the hiring-manager read of a tailored CV, run between the fact gate and PDF render when `--hm-audit` is passed |
| `ar/ da/ de/ es/ fr/ hi/ id/ it/ ja/ ko/ nl/ pl/ pt/ ru/ sg/ tr/ ua/ vi/ zh/ zh-TW/` | Language and market modes: the evaluation modes translated or adapted for a market (`sg/` is English for Singapore), with market-specific vocabulary; each has its own README |
