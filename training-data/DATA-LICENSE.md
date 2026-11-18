# Data licensing

The code in this repository is MIT licensed (see [../LICENSE](../LICENSE)). Some files in this folder are under a different licence.

| File | Origin | Licence |
|---|---|---|
| `training-data-template.csv`, `training-data-example.json`, `training-data.schema.json`, `TRAINING-DATA-GUIDE.md` | written for this project | MIT |
| `ibm-aml-corpus.csv`, `ibm-aml-corpus.json`, `ibm-aml-corpus.signatures.json`, `ibm-aml-corpus.report.json` | derived from IBM *Transactions for Anti Money Laundering (AML)* by `tools/ibm-aml-to-scam-sentinel.js` | [CDLA-Sharing-1.0](https://cdla.dev/sharing-1-0/), same as the source |

## Source dataset

- **Title:** Transactions for Anti Money Laundering (AML)
- **Authors:** Erik Altman et al., IBM
- **Published on:** Kaggle, `ealtman2019/ibm-transactions-for-anti-money-laundering-aml`
- **Paper:** E. Altman, J. Blanuša, L. von Niederhäusern, B. Egressy, A. Anghel, K. Atasu. *Realistic Synthetic Financial Transactions for Anti-Money Laundering Models.* NeurIPS 2023 Datasets and Benchmarks.
- **Licence:** Community Data License Agreement – Sharing, Version 1.0 (check the Kaggle page for the current terms before redistributing).

The source data is fully synthetic; it contains no real people or accounts. The raw files are not committed here (`data/` is git-ignored). Regenerate them with:

```bash
npm run data:download   # fetches HI-Small into data/ibm-aml/
npm run data:convert    # rebuilds the ibm-aml-corpus.* files in this folder
```

If you redistribute the derived corpus files, keep this notice with them and share any changes to them under CDLA-Sharing-1.0.
