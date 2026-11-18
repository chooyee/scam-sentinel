# Scam Sentinel — Specification

Version 0.3, reverse-engineered from `scam-sentinel.html` on 2026-09-09. Changes: 0.2 split fan-out into 1 h and 24 h windows; 0.3 added three onward-flow shares (non-bank exits, structured slices, young receivers), 19 features.
Status: describes the current proof of concept (POC). Items marked **[proposed]** are not implemented yet; see [VALIDATION-REPORT.md](VALIDATION-REPORT.md).

## 1. Purpose

Detect **authorised-push-payment (APP) scams** on DuitNow transfers. In these scams the customer authorises the payment themselves after being deceived, so device, login and location signals look normal. The two remaining tells are:

1. the transfer breaks the sending account's own pattern, and
2. the **receiver** behaves like a mule account (many unrelated senders paying in, funds flushed onward within minutes).

Scam Sentinel reads an account's recent transfers as a **sequence** and asks a small Transformer model whether the newest transfer "fits the account's story".

## 2. Scope

**In scope (POC)**

- Generate a labelled synthetic corpus of account timelines, and edit it by hand.
- Train a sequence classifier in the browser with TensorFlow.js.
- Score a single hand-entered transfer and explain which transfers drove the score.
- Visualise the learned embedding space.
- Everything runs client-side; no data leaves the page.

**Out of scope**

- Real customer data, persistence, authentication, or any server component.
- Production-grade accuracy claims. Synthetic data separates far more cleanly than real data.
- Graph features over the mule network, multi-head or multi-layer models, self-supervised pretraining. These are listed as production follow-ups in the page footer.

## 3. Users and usage flow

Primary user: a fraud-analytics or product person evaluating whether a sequence model is worth building. The page is a four-step walkthrough.

| Step | Panel | Action | Enabled when |
|---|---|---|---|
| 01 | Generate & edit the corpus | choose account count and scam share, generate, edit rows and transfers, add or delete examples | always |
| 02 | Train the model | choose epochs and learning rate, train; watch loss, accuracy, recall | corpus exists |
| 03 | Score a transfer | fill the form or pick a preset; read gauge, verdict, explanation strip | model trained |
| 04 | Embedding space | project the held-out accounts to 2D | model trained |

The status bar shows the TF.js backend, parameter count, corpus size and model state (untrained / trained).

## 4. Data model

### 4.1 Transfer

One transfer is an object with the fields below. Raw fields are supplied by a user or the generator; derived fields are computed by `createTransfer()` unless overridden.

| Field | Type | Meaning | Raw / derived |
|---|---|---|---|
| `amount` | RM, > 0 | value of the transfer | raw |
| `direction` | 1 / 0 | 1 = outbound from the owner, 0 = inbound | raw |
| `hourOfDay` | 0–23 | local hour the transfer was made | raw |
| `secondsSincePrevious` | seconds, 0 or more | gap since the owner's previous transfer | raw |
| `isNewPayee` | 1 / 0 | first ever transfer from this owner to this receiver | raw |
| `receiverAccountAgeDays` | days, 0 or more | age of the receiver account at the time of transfer | raw |
| `balanceDrainRatio` | 0–1 | amount divided by the owner's available balance before the transfer | raw |
| `receiverFanInLastHour` | integer, 0 or more | distinct unrelated senders into the receiver in the last 1 h | raw |
| `receiverFanInLast24h` | integer, 0 or more | same, last 24 h | raw |
| `receiverFanInLast7d` | integer, 0 or more | same, last 7 days | raw |
| `receiverFanOut1h` | integer, 0 or more | distinct first-time receivers the receiver paid in the last 1 h (burst dispersal) | raw |
| `receiverFanOut24h` | integer, 0 or more | same, last 24 h (daily layering) | raw |
| `passThroughRatio` | 0–1 | share of funds the receiver forwarded within minutes of receipt | raw |
| `onwardNonBankExitShare` | 0–1 | share of the receiver's onward outflow (24 h) leaving via e-wallet, crypto OTC or ATM; optional, default 0 | raw |
| `onwardStructuredShare` | 0–1 | share of the receiver's onward transfers (24 h) that are equal slices or just under a limit; optional, default 0 | raw |
| `onwardYoungReceiverShare` | 0–1 | share of the receiver's onward receivers (24 h) under 90 days old; optional, default 0 | raw |
| `ownerTypicalAmount` | RM | the owner's usual outbound transfer size | raw, account-level |
| `amountVsTypical` | ratio | `amount / ownerTypicalAmount`, forced to 1 for inbound | derived |
| `isRoundAmount` | 1 / 0 | `amount >= 1000 && amount % 500 === 0` | derived |

### 4.2 Timeline

```
{ id, transfers: Transfer[14], label: 0|1, scenario: string, ownerTypicalAmount: number }
```

- Exactly **14 transfers** (`TRANSFERS_PER_TIMELINE`), ordered oldest to newest. Index 13 is the transfer being judged.
- `label` 1 = scam, 0 = legitimate. The label applies to the whole timeline.
- `scenario` is display-only.

### 4.3 Synthetic generator

Per timeline the generator builds an account profile, fills 14 normal transfers, then optionally overwrites the tail.

| Kind | Share of corpus | Construction |
|---|---|---|
| `legit` (routine) | remainder | 14 normal transfers: 18% inbound salary, otherwise outbound to one of 2–4 known payees |
| `legitbig` (hard negative) | 25% | last transfer is a genuine RM 5k–40k payment to a **new** payee with a clean receiver |
| `scam` | scam-share slider (10–60%) | tail replaced by one of the scenarios below, each paying into a mule receiver |

Scam scenarios, weighted choice over `investment, macau, macau, job, ecom, ecom`:

| Scenario | Tail length | Shape |
|---|---|---|
| investment | 4 | escalating round-number top-ups (x1.3–2.0 each) to the same mule over days |
| macau (impersonation) | 1 | one transfer of 60–95% of balance (cap RM 49k), rounded to RM 500, 12 h off the owner's active hour |
| job/task | 4 | alternating small inbound "commissions" (RM 80–300) and outbound "deposits" (RM 800–4,000) |
| ecom (purchase) | 2 | one or two RM 300–2,500 payments to a mule |

Mule receiver signature: fan-in 1h 3–10, 24h 6–20, 7d 10–40; fan-out 1h 2–6, 24h 3–12; pass-through 0.7–1.0; account age 1–60 days; onward non-bank exit share 0.4–1.0, structured share 0.5–1.0, young-receiver share 0.5–1.0. Legitimate receivers keep the three shares at 0–0.2 (0–0.3 for the genuine large payment).

**Receiver-signature library.** When a file with `format: "scam-sentinel-mule-signatures"` is loaded (produced by `tools/ibm-aml-to-scam-sentinel.js`), the generator replaces the ranges above: scam tails draw the eight receiver-side fields (fan-in 1h/24h/7d, fan-out 1h/24h, pass-through, non-bank exit share, structured share) from the library's `scam` pool, and routine, salary and genuine-large transfers draw from its `legit` pool. Receiver account age and the young-receiver share stay synthetic. The status bar shows the active source and a reset control.
Account profile: typical amount RM 30–800, balance RM 2k–60k, active hour 06–19, 2–4 known payees aged 150–1,500 days.

## 5. Feature encoding

Each transfer becomes a vector of 19 floats. Ranges below were measured over 2,000 generated timelines.

| # | Name | Formula | Observed range |
|---|---|---|---|
| 0 | log amount | `log1p(amount) / 12` | 0.23 – 0.90 |
| 1 | log gap | `log1p(secondsSincePrevious) / 12` | 0.40 – 1.08 |
| 2 | hour sin | `sin(2*pi*hour/24)` | -1 – 1 |
| 3 | hour cos | `cos(2*pi*hour/24)` | -1 – 1 |
| 4 | direction | as-is | 0 / 1 |
| 5 | new payee | as-is | 0 / 1 |
| 6 | log receiver age | `log1p(days) / 8` | 0.09 – 0.95 |
| 7 | drain | `min(1, balanceDrainRatio)` | 0 – 0.97 |
| 8 | fan-in 1h | `min(1, n / 10)` | 0 – 1 |
| 9 | fan-in 24h | `min(1, n / 20)` | 0 – 1 |
| 10 | fan-in 7d | `min(1, n / 40)` | 0 – 1 |
| 11 | fan-out 1h | `min(1, n / 6)` | 0 – 1 |
| 12 | fan-out 24h | `min(1, n / 12)` | 0 – 1 |
| 13 | pass-through | as-is | 0 – 1 |
| 14 | log amount vs typical | `clip(log(amountVsTypical + 1e-3), -1, 3) / 3` | -0.33 – 1 |
| 15 | round amount | as-is | 0 / 1 |
| 16 | onward non-bank exit share | as-is | 0 – 1 |
| 17 | onward structured share | as-is | 0 – 1 |
| 18 | onward young-receiver share | as-is | 0 – 1 |

A timeline encodes to a `[14, 19]` matrix; a batch to `[N, 14, 19]`.

## 6. Model

Single-block Transformer encoder with attention pooling, implemented with raw `tf.variable`s (no Keras layers).

```
input [N,14,19]
 -> dense 19->32 (+bias) + sinusoidal positional encoding
 -> single-head self-attention (Q,K,V,O all 32x32, no bias, scale 1/sqrt(32))
 -> residual + LayerNorm
 -> FFN 32->64 ReLU ->32 (+bias)
 -> residual + LayerNorm
 -> attention pooling: softmax(dense 32->1) over the 14 positions -> weighted sum -> [N,32]  (the "embedding")
 -> dense 32->1 + bias -> sigmoid -> scam probability [N]
```

| Constant | Value |
|---|---|
| `TRANSFERS_PER_TIMELINE` | 14 |
| `FEATURES_PER_TRANSFER` | 19 |
| `MODEL_DIM` | 32 |
| `FEEDFORWARD_DIM` | 64 |
| `LAYERNORM_EPSILON` | 1e-5 |
| Trainable parameters | 9,121 |

Weights use Glorot-uniform init; norms start at gain 1 and bias 0. No attention mask, no dropout.

## 7. Training

| Item | Value |
|---|---|
| Split | random 75% train / 25% held-out, not stratified |
| Loss | binary cross-entropy, epsilon 1e-6 |
| Optimiser | Adam, learning rate in {0.01, 0.005 (default), 0.002} |
| Epochs | 30–140 (default 70), full-batch, one step per epoch |
| UI refresh | every 2 epochs via `tf.nextFrame()` |
| Metrics | held-out accuracy and recall at threshold 0.5 |
| Side effects | model rebuilt from scratch each run; held-out tensors kept for panel 04 |

Rules: training is blocked while `isBusy`; Generate and Train are disabled during a run; a successful run enables Score and Project.

## 8. Scoring and explanation

- The scored transfer is appended to a **fixed canonical background** of 13 identical routine transfers (RM 300 outbound, 14:00, 1 day apart, known payee aged 600 d, drain 1.5%, fan-in 0/1/3, fan-out 0/0, pass-through 5%, onward shares 5% each). This makes the score a pure function of the form inputs.
- `secondsSincePrevious` for the scored transfer is fixed at 3,600 s and is not user-editable.
- Form inputs: amount, direction, new payee, receiver age, drain %, hour, fan-in 1h/24h/7d, fan-out 1h/24h, pass-through %, onward non-bank exit %, onward structured %, onward young-receiver %.
- Presets: routine, investment top-up, impersonation payout, genuine big purchase. Values live in `SCORE_PRESETS`.

Risk bands and required action:

| Probability | Headline | Recommended action |
|---|---|---|
| below 0.33 | Fits the account's story | let it through |
| 0.33 – 0.66 | Out of pattern, add friction | in-app scam warning, payee confirmation |
| 0.66 and above | Likely scam to mule | hold, cooling-off, verify with customer |

Explanation: leave-one-out **occlusion**. Each of the 14 positions is replaced in turn by a benign baseline row and the timeline is re-scored. The drop in probability is drawn as a bar (height = absolute change, warmth = positive change). The tooltip shows the transfer summary and the change in percentage points.

## 9. Embedding view

Held-out timelines are run through the model with `returnEmbedding: true`. The 32-d pooled vectors are reduced to 2D with PCA (power iteration, 80 iterations, one deflation) and drawn as a scatter: green = legit, red = scam.

## 10. Non-functional requirements

| Requirement | Current state |
|---|---|
| Runs entirely in the browser; no network calls after load | met (TF.js and two Google Fonts loaded once) |
| Deterministic score for identical inputs | met (fixed background) |
| Reproducible corpus / training | **not met**: unseeded `Math.random()` **[proposed: seed]** |
| Memory safety across repeated runs | partly: model weights disposed; optimiser and held-out tensors leak **[proposed]** |
| Responsive down to 780 px | met |
| Accessibility (WCAG 2.1 AA) | **not met**: unlabeled controls, `th` scope, canvas fallbacks **[proposed]** |
| Supply-chain safety | CDN pinned but no SRI **[proposed]** |
| Browser support | modern evergreen browsers with WebGL; falls back to the CPU backend |

## 11. Interfaces

### 11.1 Training-data import

Panel 01 accepts the CSV / JSON format defined in [TRAINING-DATA-GUIDE.md](../training-data/TRAINING-DATA-GUIDE.md) through a file picker, a "load from path" fetch relative to the page (needs http; `tools/serve.js` provides it), or a `?corpus=<path>` URL parameter. Rules, implemented in `importCorpusText()`:

- group rows by `account_id`, order by `seq` (else by timestamp, else file order), keep the most recent 14;
- fewer than 14: left-pad with the canonical routine transfer at the owner's typical amount; padded rows are flagged on the object but there is no attention mask **[proposed]**;
- derive `hourOfDay` (from the hour as written in the timestamp) and `secondsSincePrevious` when blank; default `receiverAccountAgeDays` to 365 and the three onward shares to 0; derive `amountVsTypical` and `isRoundAmount` when blank, forcing 1 and 0 on inbound rows;
- reject an account if any row has a missing required field, a ratio outside 0–1, an hour outside 0–23, a non-positive amount, an inconsistent label or a non-positive typical amount, and list the reason;
- HTML-escape scenario and account id before rendering; import replaces the corpus and resets model state.

A converter for the public IBM AML dataset emits this format: `tools/ibm-aml-to-scam-sentinel.js` (see the guide, section 8). The same import paths accept a receiver-signature library file (section 4.3), routed by its `format` field.

### 11.2 Corpus export

"Export JSON" writes the current, possibly hand-edited, corpus in the JSON layout with numbers rounded (amounts 2 dp, ratios 3 dp, counts integer). Synthetic timelines get ids `SYN-0001` style and no timestamps.

## 12. Known limitations

- Synthetic data is far cleaner than real DuitNow traffic; reported accuracy is not indicative.
- One bank sees only the senders it hosts; fan-in and pass-through need cross-bank intelligence (National Fraud Portal).
- Point-in-time correctness: receiver features must be computed as of the transfer timestamp, never with hindsight, or the model learns leakage.
- The model has no notion of receiver identity across transfers; "same mule four times" is only visible through the repeated signature.

## 13. Glossary

- **APP scam**: authorised push payment scam; the victim initiates the payment.
- **Mule account**: an account, often newly opened or rented, that collects victims' money and forwards it.
- **Fan-in**: number of distinct sender accounts paying into a receiver in a time window.
- **Fan-out**: number of distinct accounts a receiver pays onward in a window.
- **Pass-through**: share of received funds forwarded again within minutes.
- **DuitNow**: Malaysia's real-time interbank transfer scheme.
