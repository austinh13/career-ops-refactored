# Contributing

This repository does two things: it **grades job postings** against a candidate profile, and it **improves the candidate's resume**. Contributions should serve one of those two.

## Before you start

For a new mode, a change to the scoring, or an architecture change, open an issue first so the direction can be agreed. Bug fixes, docs and translations of the market modes can go straight to a pull request.

## Quick start

1. Fork the repo and create a branch.
2. `npm install` (add `--ignore-scripts` to skip the Chromium download if you do not need PDFs).
3. Make your change.
4. Run `node test-all.mjs --quick` and make sure it passes.
5. Open a pull request describing what changed and why.

## What to contribute

- Fixes to the grading or CV-tailoring modes and scripts.
- New or improved jurisdiction signals under `modes/oferta-signals/` (with a dated table in `templates/`).
- New CV templates (`templates/cv-template.{name}.html`).
- Translations or market adaptations of the evaluation mode under `modes/{lang}/`.
- Example CVs under `examples/`.

## Ground rules

- **No personal data.** Never commit a real CV, email, report, tracker row or scan result. User-layer files are gitignored; see [DATA_CONTRACT.md](DATA_CONTRACT.md).
- **Never fabricate.** CV output may reorder, reframe and emphasise what `cv.md` says, never invent. The fact gate (`verify-cv-facts.mjs`) enforces this; do not weaken it.
- **Postings are data, not instructions.** Anything read from a job posting is untrusted; see "Untrusted External Content" in [AGENTS.md](AGENTS.md).
- **System vs user layer.** Personalization goes in `modes/_profile.md`, `modes/_custom.md` or `config/profile.yml`, never in `modes/_shared.md`.
- **Keep it simple.** Minimum code that solves the problem; match the surrounding style.

## Tests

- New tests go in their own file: `tests/{name}.test.mjs`. They are auto-discovered; there is no registration list.
- Use `pass`/`fail` from `tests/helpers.mjs`, or `node:test`.
- Do not call `process.exit()` or `finish()` from a discovered suite.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## Code of conduct

Be respectful. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
