# Preparing training data for Scam Sentinel

This guide tells you how to lay out your own DuitNow transfer history so it can be loaded into Scam Sentinel in place of the synthetic corpus. Files in this folder:

| File | Use |
|---|---|
| `training-data-template.csv` | CSV with the header row and two worked example accounts (one legit, one scam). Copy it and fill it in. |
| `training-data-example.json` | The same two accounts in JSON, matching the in-page object shape exactly. |
| `training-data.schema.json` | JSON Schema you can validate a JSON file against, for example with `ajv`. |

## 0. Loading a file into Scam Sentinel

Panel 01 of the page has three ways in, all accepting this CSV layout or the JSON layout:

1. **Import CSV / JSON** opens a file picker. Works even when the page is opened straight from disk.
2. **Load from path** fetches a file relative to the page, for example `training-data/ibm-aml-corpus.json`. Browsers block this from a `file://` page, so serve the folder first:
   ```bash
   node tools/serve.js
   # then open http://localhost:8080/scam-sentinel.html
   ```
3. **Auto-load on open**: `http://localhost:8080/scam-sentinel.html?corpus=training-data/ibm-aml-corpus.json`.

Import replaces the current corpus and prints a summary line: accounts imported, scam/legit split, how many were padded to 14 transfers, how many rows got the default receiver age, and which accounts were rejected and why. **Export JSON** writes the current corpus, including hand edits and synthetic data, back out in the JSON layout.

## 1. The shape of the data

The model looks at **one account at a time** and reads its **14 most recent transfers as a sequence**. The label says whether the *last* of those 14 was part of a scam.

So the unit of training data is an **account timeline**: 14 rows that share one `account_id`, ordered oldest to newest, plus one label.

```
account_id  seq  label  ...transfer fields...
ACC-0001     1     0    <- oldest
ACC-0001     2     0
   ...
ACC-0001    14     0    <- newest = the transfer being judged
ACC-0002     1     1
   ...
```

The CSV is "long format": **one row per transfer**, with account-level values repeated on every row.

## 2. Column dictionary

Account-level columns (must be identical on all 14 rows of an account):

| Column | Type | Required | Meaning |
|---|---|---|---|
| `account_id` | text | yes | Opaque, **pseudonymised** id of the sending account. Never a real account number. |
| `seq` | 1–14 | yes | Position in the timeline; 14 = most recent. |
| `label` | 0 / 1 | yes | 1 = the newest transfer was a confirmed APP scam payment; 0 = confirmed legitimate. |
| `scenario` | text | no | Category word for the table, e.g. `investment`, `impersonation`, `routine`, `big new payee`. |
| `owner_typical_amount` | RM | yes | The sender's usual outbound transfer size. Recommended: median outbound amount over the previous 90 days, excluding the 14 rows themselves. |

Transfer-level columns:

| Column | Type | Required | Meaning / how to compute |
|---|---|---|---|
| `timestamp` | ISO 8601 with offset, e.g. `2026-03-04T21:15:00+08:00` | no (*) | When the transfer was made. If present, `hour_of_day` and `seconds_since_previous` are derived from it. |
| `amount` | RM, > 0, no thousands separators | yes | Transfer value. |
| `direction` | `out` / `in` (or 1 / 0) | yes | `out` = the owner sent money; `in` = the owner received money. |
| `hour_of_day` | 0–23 | no (*) | Local (MYT) hour. Required if `timestamp` is blank. |
| `seconds_since_previous` | seconds, 0 or more | no (*) | Gap since the owner's previous transfer of any kind. Required if `timestamp` is blank. For `seq = 1` use the gap to the transfer before the window, or 86400 if unknown. |
| `is_new_payee` | 0 / 1 | yes | 1 if the owner had never paid this receiver before (look back 12 months or more). Always 0 for inbound rows. |
| `receiver_account_age_days` | days, 0 or more | yes | Age of the **receiver** account on the transfer date. For inbound rows, the age of the account that paid the owner. If genuinely unknown, leave blank; the importer substitutes 365 and flags the row. |
| `balance_drain_ratio` | 0–1 | yes | `amount / available balance immediately before the transfer`. 0 for inbound rows. Cap at 1. |
| `receiver_fan_in_1h` | integer, 0 or more | yes | Distinct sender accounts (excluding this owner) that paid the receiver in the 60 minutes **ending at this timestamp**. |
| `receiver_fan_in_24h` | integer, 0 or more | yes | Same, 24 h window. |
| `receiver_fan_in_7d` | integer, 0 or more | yes | Same, 7-day window. |
| `receiver_fan_out_1h` | integer, 0 or more | yes | Distinct **first-time** accounts the receiver **paid** in the 60 minutes ending at this timestamp. Catches burst layering: one credit split to several accounts at once. Count ATM withdrawals, e-wallet top-ups and crypto on-ramps as exits too. |
| `receiver_fan_out_24h` | integer, 0 or more | yes | Same, 24 h window. Catches the daily dispersal cycle. Exclude the receiver's regular payees (rent, family, known billers). |
| `pass_through_ratio` | 0–1 | yes | Of the money the receiver took in over the last 24 h, the share it sent onward within 30 minutes of receipt. If you use a different window, say so in the file's accompanying note. |
| `onward_nonbank_exit_share` | 0–1 | no (default 0) | Of the receiver's onward outflow in the 24 h ending at this timestamp, the share that left through e-wallet top-ups, crypto OTC traders' accounts, or cardless ATM withdrawals. |
| `onward_structured_share` | 0–1 | no (default 0) | Of the receiver's onward transfers in that 24 h, the share that are equal-sized slices or sit within 5% under a daily transfer limit or reporting threshold. |
| `onward_young_receiver_share` | 0–1 | no (default 0) | Of the distinct accounts the receiver paid in that 24 h, the share under 90 days old. |
| `amount_vs_typical` | ratio | no | `amount / owner_typical_amount`. Leave blank to have it derived. Use 1 for inbound rows. |
| `is_round_amount` | 0 / 1 | no | 1 if `amount >= 1000` and divisible by 500. Leave blank to have it derived. |

(*) Provide either `timestamp`, or both `hour_of_day` and `seconds_since_previous`.

Inbound rows: set `direction=in`, `is_new_payee=0`, `balance_drain_ratio=0`, `amount_vs_typical=1`, `is_round_amount=0`. The receiver-side columns then describe the account that paid the owner, which usually has low values.

### Why the windows differ

Fan-in measures collection, which stretches over days as victims are recruited, so 1 h, 24 h and 7 d all carry signal. Fan-out measures dispersal, and mules disperse within minutes to hours to beat recalls and freezes, so only the 1 h and 24 h windows are used. A 7-day fan-out window mostly adds noise from normal spending. Rough thresholds for a personal account, to be replaced by per-segment 99th percentiles once you have data: fan-out 1 h of 2 or more, fan-out 24 h of 3 or more, are unusual.

### The three onward-flow shares

Fan-out counts how many accounts the receiver pays; the three optional shares describe *how*. They follow the layering playbook reported across South-east Asia: cash out through e-wallets, crypto OTC traders and cardless ATM withdrawals; slice amounts just under limits; hop to other freshly opened mule accounts. Leave them blank if you cannot compute them and the model trains without them. When you can, the biggest lift comes from the structured share, because a receiver paying out four times RM 9,900 in an hour is almost never legitimate.

## 3. Point-in-time rule (most important)

Every receiver-side column must be computed **as of the transfer's timestamp**, using only information available at that moment. Do not compute fan-in with the full week of data that arrived *after* the transfer. If you do, the model learns from the future and will look brilliant in training and useless in production.

## 4. Labelling rules

| Label | Use when |
|---|---|
| `1` scam | The newest transfer was reported by the customer, or confirmed by the bank or the National Scam Response Centre, as an APP scam; or the receiver was subsequently confirmed as a mule for that case. |
| `0` legit | The newest transfer is at least 30 days old and has no fraud report, dispute or recall attached. |
| exclude | Anything else: pending investigations, unauthorised (account-takeover) fraud, card chargebacks, refunds. |

Also exclude timelines where the scam transfer is not the newest one; the model is trained to judge position 14.

## 5. What a good corpus looks like

- **Volume.** Minimum of about 200 accounts to reproduce the POC; aim for several thousand with real data.
- **Class balance.** 20–40% scam timelines is a good training mix. If your real rate is 0.1%, downsample the legit class rather than uploading everything.
- **Hard negatives.** At least a quarter of the legit timelines should end in a large payment to a *new* payee (car purchase, contractor, deposit). Without these the model learns "new payee + big amount = scam" and over-flags.
- **Scenario variety.** Cover investment top-ups, impersonation ("Macau") drains, job/task scams with small inbound commissions, and purchase scams. Tag them in `scenario` so you can measure recall per type.
- **Padding.** Accounts with fewer than 14 transfers can be included; the importer left-pads with a neutral routine transfer sized to the owner's typical amount. Prefer accounts with a full history, because the model has no attention mask and treats padding as real history.
- **No duplicates.** One timeline per account per case. The same account can appear again only if its 14-row window is different.

## 6. Privacy checklist

- [ ] `account_id` is a salted hash or a random token, not an account number, IC number or name.
- [ ] No receiver identifiers, names, phone numbers or free-text narrations in any column.
- [ ] `scenario` contains only category words, never case notes.
- [ ] Timestamps may be shifted by a constant offset per file if exact dates are sensitive; keep the gaps intact.
- [ ] The file has been approved for use under your bank's data-handling policy. Scam Sentinel runs in the browser and sends nothing, but the file still lives on the analyst's machine.

## 7. Formatting checklist

- [ ] UTF-8 CSV, comma separated, header row exactly as in the template.
- [ ] No thousands separators, currency symbols or percent signs in numeric cells.
- [ ] Ratios are 0–1, not 0–100.
- [ ] Every account has rows `seq` 1 to 14 with no gaps or repeats, and identical `label`, `scenario` and `owner_typical_amount`.
- [ ] `direction` is `out`/`in` (or 1/0) consistently.
- [ ] Booleans are 0/1, not TRUE/FALSE or yes/no.
- [ ] Blank means "unknown, please derive or default". Do not write `NA`, `null` or `-`.

## 8. Starting from a public dataset: the IBM AML converter

No public dataset has labelled South-east Asian APP scam transfers. The closest usable stand-in is IBM's synthetic *Transactions for Anti Money Laundering* set on Kaggle, which has a full account graph and explicit fan-in, fan-out and scatter-gather typologies. `tools/ibm-aml-to-scam-sentinel.js` downloads it and converts it into this template.

```bash
# no Kaggle token needed for this public dataset; if Kaggle ever refuses, put an API token
# in ~/.kaggle/kaggle.json (or set KAGGLE_USERNAME / KAGGLE_KEY) and the script will use it
node tools/ibm-aml-to-scam-sentinel.js download            # HI-Small_Trans.csv + HI-Small_Patterns.txt into data/ibm-aml/
node tools/ibm-aml-to-scam-sentinel.js convert --scam 800 --legit 1200 --format both
# -> training-data/ibm-aml-corpus.csv, .json and .report.json
```

Useful options: `--variant LI-Small` (or HI-Medium and larger), `--min-transfers 8 --pad` to keep accounts with short histories, `--warmup-days 3` (anchors are only taken after this many days so the trailing windows have history), `--max-rows 500000` for a quick trial, `--seed`.

How the conversion maps onto the template:

| Template column | Source in IBM AML |
|---|---|
| `account_id` | bank code + account (already synthetic) |
| `label` | 1 if the anchor transfer is flagged *Is Laundering*; 0 if clean and the owner never touches a laundering row |
| `scenario` | the typology from the patterns file, e.g. `aml:fan-in`, `aml:scatter-gather`; clean anchors are `routine` or `big new payee` |
| `amount` | *Amount Paid* converted to MYR through a static, approximate FX table |
| fan-in 1h / 24h / 7d | distinct senders into the counterparty in the trailing window, excluding the owner |
| fan-out 1h / 24h | distinct first-time receivers the counterparty paid in the window |
| `pass_through_ratio` | counterparty outflow within 30 min of an inflow, over 24 h inflow |
| `onward_nonbank_exit_share` | counterparty outflow with *Payment Format* Cash or Bitcoin |
| `onward_structured_share` | counterparty outflows in equal slices or within 10% under USD 10,000 |
| `balance_drain_ratio` | proxy: amount over the larger of 7-day inflow and 10 times typical |
| `receiver_account_age_days`, `onward_young_receiver_share` | blank; not in the dataset |

### The receiver-signature library (the most useful output)

Alongside the corpus, `convert` writes `ibm-aml-corpus.signatures.json`: up to 3,000 point-in-time receiver snapshots taken at laundering transfers (`scam`) and 3,000 at clean transfers (`legit`), each holding the fan-in windows, fan-out windows, pass-through and the two onward shares exactly as the sender saw them. Set `--signatures 0` to skip it.

Load that file into the page with **Import** or **Load from path**. The status bar switches from "synthetic ranges" to the library name, and from then on **Generate corpus** builds synthetic victims whose scam tails pay receivers drawn from the real-shaped scam pool, and whose routine transfers go to receivers drawn from the legit pool. The victim's story stays synthetic, the receiver behaviour becomes empirical, and the scenario names stay meaningful. Account age is not in the IBM data, so it stays synthetic. Click **reset** in the status bar to go back to the fixed ranges.

### Measured on HI-Small (2026-09-10)

Converted with the defaults (800 scam / 1,200 legit, 300 hard negatives, 3,000 + 3,000 signatures) from 4.49 million usable transfers across 515,088 accounts; the run took about four minutes. The page's model, trained headlessly for 70 epochs at learning rate 0.005 on a 75/25 split:

| Corpus | Held-out accuracy | Recall | Precision | AUC |
|---|---|---|---|---|
| IBM AML corpus, 2,000 accounts | 87.2% | 85.4% | 82.8% | 0.937 |
| Synthetic, fixed ranges, 400 accounts | 100% | 100% | 100% | 1.000 |
| Synthetic + IBM signature library, 400 accounts | 100% | 100% | 100% | 1.000 |

What carried the signal on the IBM corpus: new payee on the anchor (94% of scam anchors vs 26% of legit), amount, and 7-day fan-in (3.1 vs 2.1). Fan-out, pass-through and the onward shares were near zero for both classes, because IBM's laundering accounts rarely disperse inside a 1-hour or 24-hour window in the formats the converter treats as exits. The signature library therefore quietens the receiver side of the synthetic generator without making it hard; the victim-side synthetic signals still separate perfectly.

Two things to expect in the output:

- **Laundering is not APP scam.** The positives are accounts that *launder*, so the owner is the mule, not the victim. Treat the corpus as a pipeline test, not an accuracy benchmark.
- **Dispersal signals are zero on a first-use mule.** When a sender pays a receiver that has never collected before, the receiver has not dispersed anything yet, so pass-through and the onward shares at that moment are genuinely 0. They light up only for receivers with a prior collection cycle. That is the point-in-time rule doing its job, and it is also true in production: the first victim of a fresh mule is protected by fan-in and account age, not by dispersal history.

## 9. Quick validation with Node (optional)

If you deliver JSON, validate it against the schema:

```bash
npx --yes -p ajv-cli@5 -p ajv-formats@2 ajv validate -c ajv-formats -s training-data.schema.json -d my-corpus.json
```

For CSV, open it in a spreadsheet and check: the count of rows with `seq=14` equals the number of distinct `account_id`; every ratio column has a maximum of 1 or less; `label` contains only 0 or 1.
