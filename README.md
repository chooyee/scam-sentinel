# Scam Sentinel

A browser-only proof of concept for spotting **authorised-push-payment (APP) scams** on instant transfers. It reads an account's 14 most recent transfers as a sequence and asks a tiny Transformer (9,121 parameters, TensorFlow.js) whether the newest one fits that account's story.

In an APP scam the victim makes the payment themselves, so device, login and location all look normal. Two signals are left: the payment **breaks the account's own pattern**, and the **receiver behaves like a mule** (many unrelated senders paying in, money forwarded within minutes). Scam Sentinel models both.

> **Status: research demo.** Synthetic data separates far more cleanly than real traffic, so accuracy numbers here are not indicative. Do not use it to make decisions about real payments or real people.

## Quick start

No install and no build step. You only need a modern browser; Node 18+ is needed for the helper scripts.

```bash
# Option A: just open the file
open scam-sentinel.html            # or double-click it

# Option B: serve it, so "Load from path" and ?corpus= work
npm start                          # = node tools/serve.js
# http://localhost:8080/scam-sentinel.html
# http://localhost:8080/scam-sentinel.html?corpus=training-data/ibm-aml-corpus.json
```

Then work through the four panels:

1. **Generate & edit the corpus.** Build synthetic labelled timelines, or import CSV / JSON.
2. **Train the model.** Runs in your browser; watch loss, accuracy and recall.
3. **Score a transfer.** Fill the form or pick a preset; see the risk gauge and which transfers drove the score.
4. **Embedding space.** Project held-out accounts to 2D to see how the model separates them.

Nothing leaves the page. The only network requests are TensorFlow.js and Google Fonts on first load.

## How it works

```
14 transfers ─▶ 19 features each ─▶ [14 × 19] ─▶ Transformer block ─▶ attention pool ─▶ sigmoid ─▶ scam probability
```

Each transfer is encoded as 19 numbers: amount, time gap, hour, direction, new payee, receiver account age, balance drain, receiver fan-in (1 h / 24 h / 7 d), receiver fan-out (1 h / 24 h), pass-through ratio, amount versus the owner's typical amount, round amount, and three onward-flow shares (non-bank exits, structured slices, young receivers). A single-head Transformer encoder reads the sequence, attention pooling squeezes it to one 32-d vector, and a dense layer turns that into a probability. Explanations come from leave-one-out occlusion.

The full walkthrough with diagrams is in **[docs/developer-guide.html](docs/developer-guide.html)** (open it in a browser). The precise behaviour is in [docs/SPEC.md](docs/SPEC.md).

## Training data

| Source | How |
|---|---|
| Synthetic | Built in the page: routine accounts, hard negatives (genuine large payments to new payees), and four scam scenarios (investment, impersonation, job/task, purchase). |
| Your own data | CSV or JSON in the layout in [training-data/TRAINING-DATA-GUIDE.md](training-data/TRAINING-DATA-GUIDE.md); template, example and JSON Schema are in the same folder. |
| IBM AML (public, synthetic) | `tools/ibm-aml-to-scam-sentinel.js` converts IBM's *Transactions for Anti Money Laundering* dataset. A pre-built 2,000-account corpus and a receiver-signature library ship in `training-data/`. |

To rebuild the IBM corpus from scratch:

```bash
npm run data:download    # ~450 MB into data/ibm-aml/ (git-ignored)
npm run data:convert     # writes training-data/ibm-aml-corpus.{csv,json,signatures.json,report.json}
```

The conversion takes a few minutes and is deterministic for a given `--seed`. Run `node tools/ibm-aml-to-scam-sentinel.js --help` for all options.

## Repository layout

```
scam-sentinel.html          the whole app: UI, data generator, model, training, charts
tools/
  serve.js                  localhost-only static server (needed for fetch from the page)
  ibm-aml-to-scam-sentinel.js  IBM AML download + conversion
  check.js                  syntax and data-shape checks (npm run check)
training-data/              format guide, template, schema, pre-built IBM corpus
docs/
  developer-guide.html      how it works, for developers
  SPEC.md                   specification
  VALIDATION-REPORT.md      known issues and improvement backlog
```

## Contributing

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). The backlog in [docs/VALIDATION-REPORT.md](docs/VALIDATION-REPORT.md) is a good place to start. Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## Licence

Code: [MIT](LICENSE). The derived IBM AML corpus files in `training-data/` are under CDLA-Sharing-1.0, the licence of the source dataset; see [training-data/DATA-LICENSE.md](training-data/DATA-LICENSE.md).

DuitNow is a trademark of its owner. This project is independent and is not affiliated with or endorsed by PayNet, Bank Negara Malaysia or any bank.
