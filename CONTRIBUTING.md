# Contributing to Scam Sentinel

Thanks for your interest. Scam Sentinel is a small, dependency-free proof of concept, and the aim is to keep it that way: one HTML page you can open from disk, and a few Node scripts with no `npm install`.

## Getting started

```bash
git clone <your fork>
cd scam-sentinel
npm start            # serves the folder at http://localhost:8080
npm run check        # syntax and data-shape checks, run before every PR
```

Requirements: Node 18 or newer, a modern browser with WebGL (the CPU backend works too, just slower).

Read [docs/developer-guide.html](docs/developer-guide.html) for how the pieces fit together, and [docs/SPEC.md](docs/SPEC.md) for the exact behaviour.

## What to work on

[docs/VALIDATION-REPORT.md](docs/VALIDATION-REPORT.md) lists known bugs, accessibility gaps and proposed features, in priority order. Pick one, open an issue saying you are on it, then send a pull request.

## Ground rules

- **No real customer data.** Never commit real transactions, account numbers, names, phone numbers or case notes, not even in a test fixture. Use the synthetic generator or the IBM AML converter. See the privacy checklist in [training-data/TRAINING-DATA-GUIDE.md](training-data/TRAINING-DATA-GUIDE.md#6-privacy-checklist).
- **No runtime dependencies or build step.** The page loads TensorFlow.js from a pinned CDN URL and nothing else. Tools use only the Node standard library.
- **Keep the spec in sync.** If you change features, model shape, the training-data format or the scoring rules, update `docs/SPEC.md` in the same PR (and `TRAINING-DATA-GUIDE.md` / `training-data.schema.json` for format changes).
- **Point-in-time correctness.** Any receiver-side feature must be computable from data available at the transfer's timestamp. PRs that leak future information will not be merged.
- **Style.** Two-space indentation, `'use strict'` in Node files, descriptive names over comments, and keep the numbered section layout of the `<script>` block in `scam-sentinel.html`.

## Pull requests

1. Branch from `main`.
2. Run `npm run check`.
3. Open the page, generate a corpus, train, score a preset, and check the browser console is clean.
4. Describe what changed and why; include a screenshot for UI changes.

If you regenerate `training-data/ibm-aml-corpus.*`, say which options you used and include the new `ibm-aml-corpus.report.json`.

## Reporting bugs and security issues

Open a GitHub issue for bugs. For security issues, follow [SECURITY.md](SECURITY.md) instead of filing a public issue.

By contributing you agree that your contributions are licensed under the MIT licence and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
