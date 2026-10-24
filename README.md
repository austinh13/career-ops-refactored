# career-ops

AI job-fit grading and resume improvement, running locally inside your AI coding CLI.

This is a pared-down fork of [santifer's career-ops](https://santifer.io). It keeps two functions and nothing else:

1. **Job grading.** Paste a job URL or description. career-ops checks the posting is still open, evaluates it against your CV and profile, and writes a report with a 1-5 score, a verdict, a posting-legitimacy check and a risk summary.
2. **Resume improvement.** For a role you graded, career-ops reads your CV against the posting and returns a table of edits (original text, replacement text, justification, where) without inventing anything, fact-checks every replacement against `cv.md`, and can still output a fresh PDF, HTML, LaTeX or markdown CV. It can also grow `cv.md` from evidence you already have.

| Principle | What it means |
|-----------|---------------|
| **Human-in-the-Loop** | AI evaluates and recommends, you decide and act. The system never submits an application -- you always have the final call <!-- hitl: absolute guarantee. Do not add "automatically", "by itself", "without your permission" or any other hedge when translating this row. --> |
| **Local-first** | Everything runs on your machine against your own files. |
| **No fabrication** | CV output reorders and reframes what `cv.md` says; it never invents. |

## Quick start

```bash
git clone <this repo> career-ops && cd career-ops
npm install
npx playwright install chromium      # PDF generation and live-posting checks
node doctor.mjs                      # confirms node, dependencies and setup
```

Open your AI CLI (Claude Code, Codex, OpenCode, Pi, Qwen, Kimi, Antigravity, Grok, ...) in this directory. On first launch it walks you through setup (your CV, profile and target roles) by chatting. Then:

- Paste a job URL or description to grade it and get a resume edit table (`auto-pipeline`).
- `/career-ops <mode>` runs a single mode (see below). In Codex, ask for the mode in plain language, e.g. "Run the career-ops improve mode for the latest evaluated role".

No agent CLI? `node gemini-eval.mjs`, `openai-eval.mjs`, `ollama-eval.mjs` and `openrouter-runner.mjs` grade a job description using an API key (see `.env.example`).

## Modes

### Job grading

| Mode | What it does |
|------|--------------|
| `auto-pipeline` (paste a JD/URL) | Evaluate, write the report, tailor a CV, add a tracker row |
| `oferta` | Full evaluation of one posting: Blocks A-G, verdict, risk summary |
| `ofertas` | Compare and rank several offers |
| `triage` | Fast first-pass go/no-go score, writes no files |
| `pipeline` | Grade every URL in `data/pipeline.md` |
| `batch` | Grade many postings with parallel headless workers |

### Resume improvement

| Mode | What it does |
|------|--------------|
| `improve` | Table of edits to your `cv.md` for a role: original text, replacement text, justification, where |
| `pdf` | Tailored, ATS-optimized CV as PDF (optional hiring-manager audit with `--hm-audit`) |
| `text` | Tailored CV as markdown |
| `latex` / `latex-tex` | LaTeX/Overleaf export, or tailor your own `.tex` CV in place |
| `ats` | ATS parseability score and fixable issues for a generated CV |
| `add` | Add a project, paper or role to `cv.md` (preview, then confirm) |
| `expand` | Find competencies your profile links show but your CV omits |
| `master-profile` | Import, review and validate a source-backed Master Career Profile |
| `intake` | Build or enrich your profile and CV from documents you drop in `documents/` |

## Dashboard

```bash
npm run dashboard      # http://localhost:4173, this computer only
```

A local web app over the same files and scripts: import job links into the inbox, browse graded roles by score with each full report, and read the resume edit tables (original, replacement, justification, where). Its "Grade pending links" and "Improve resume" buttons start your agent CLI headless (`CAREER_OPS_CLI`, or the first installed one), the same as running the mode yourself.

## How grading works

- The score is a holistic 1-5 judgment over CV match, role fit, compensation, culture signals and posting legitimacy, using your archetypes in `modes/_profile.md`. Below 4.0 the report recommends not applying.
- Every report carries the job description verbatim, a Machine Summary block, and a Block G legitimacy assessment (posting age, apply button, repost and ghost-job signals, plus jurisdiction checks).
- `check-liveness.mjs` decides whether a posting is still open from public ATS APIs first and a real browser second, never from a search snippet.
- Evaluations are logged as one TSV per report in `batch/tracker-additions/` and merged into `data/applications.md` by `merge-tracker.mjs`.

## How CV tailoring works

- Content comes only from `cv.md`, `article-digest.md`, `config/profile.yml`, `modes/_profile.md` and what you say in the session. Keywords are reformulated, never fabricated.
- `verify-edit-table.mjs` checks every edit row (originals quoted from `cv.md`, replacements through the fact gate), `verify-cv-facts.mjs` gates every generated CV, `cv-title-check.mjs` and `verify-cv-structure.mjs` warn about drift from `cv.md`, and `verify-ats.mjs` scores the HTML for ATS parsers.

## Your files

Your data lives in `cv.md`, `config/profile.yml`, `modes/_profile.md`, `modes/_custom.md`, `article-digest.md`, `data/`, `reports/`, `output/` and `jds/`. System files (`modes/_shared.md`, scripts, templates) never contain personal data. The full list is in [DATA_CONTRACT.md](DATA_CONTRACT.md); the data directory can live outside the checkout (`CAREER_OPS_ROOT` or a `.career-ops-data` marker file).

Ask your CLI to adapt the system to you: "Change the archetypes to backend engineering roles", "Update my profile with this CV I'm pasting". Customizations go to `modes/_profile.md`, `modes/_custom.md` or `config/profile.yml`, never to `modes/_shared.md`.

## Project layout

```
cv.md                    your CV (you create it)
config/profile.yml       your identity, targets, comp range
modes/                   prompts: grading modes, CV modes, localized market modes
batch/                   batch grading runner and worker prompt
templates/               CV templates, tracker states, jurisdiction tables
evals/                   golden set for the evaluators
*.mjs                    scripts (evaluators, liveness, tracker, CV build and verify)
tests/                   test suite (node test-all.mjs)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit, and [AGENTS.md](AGENTS.md) for the rules agents follow.

## Tests

```bash
node test-all.mjs --quick
```

## License

MIT. See [LICENSE](LICENSE), [LEGAL_DISCLAIMER.md](LEGAL_DISCLAIMER.md) and [SECURITY.md](SECURITY.md).
