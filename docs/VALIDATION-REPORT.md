# Scam Sentinel — HTML validation report & improvement proposals

File reviewed: `scam-sentinel.html` (1,419 lines, single-file app, TensorFlow.js 4.22.0 from cdnjs).
Date: 2026-09-09.

## 1. What was checked

| Check | Tool | Result |
|---|---|---|
| HTML structure / conformance | `html-validate@8` (recommended preset) | 0 structural errors, 26 lint findings (3 rule types) |
| Accessibility | `html-validate@8` (a11y preset) | 18 findings (2 rule types) |
| JavaScript syntax | `node --check` on the extracted `<script>` | OK |
| Data generator + feature encoder + PCA | Node smoke test (2,000 timelines, TF.js stubbed) | OK: every timeline has 14 transfers, all 15 features finite and in range |
| W3C Nu validator | not run; needs Java, which is not installed on this machine | n/a |

The page is well-formed: doctype, `lang`, charset, viewport and `<title>` are all present, tags are balanced, and there are no obsolete elements. Everything below is about quality, not validity.

### Lint findings (html-validate)

| Rule | Count | Lines | Fix |
|---|---|---|---|
| `no-implicit-button-type` | 10 | 120, 127, 128, 144, 160–163, 180, 201 | add `type="button"` to every `<button>` |
| `wcag/h63` (`<th>` without `scope`) | 8 | 132 | add `scope="col"` to the corpus table headers (and the editor grid headers built in JS) |
| `no-inline-style` | 8 | 126, 150, 151, 180, 187, 202, 204, 205 | move to utility classes (`.hidden`, `.accent`, `.flex-1`); stylistic, low priority |

## 2. Bugs found by reading the code

Ordered by impact.

1. **Transfer editor closes after every edit.** Each `onchange` in the inline editor calls `renderCorpusTable()`, which wipes `tbody` and therefore removes the expanded editor row. The user must click "edit" again after every single cell change. Fix: update only the summary cells of the parent row, or remember the expanded index and re-open it after the re-render.
2. **Buttons stay disabled if training throws.** `trainModel()` has no `try/finally`. A WebGL context loss or an out-of-memory error mid-training leaves `isBusy = true` and Generate/Train permanently disabled until reload. Wrap the body in `try { ... } finally { restore UI; isBusy = false }`.
3. **Tensor leaks across repeated training runs.** `tf.train.adam(...)` allocates moment variables that are never disposed, and `heldOutTensors` is overwritten without disposing the previous `x`/`y`. Each run leaks; on WebGL that eventually exhausts GPU memory. Call `optimizer.dispose()` after training and dispose the old held-out tensors before replacing them.
4. **Recall can be meaningless on small corpora.** With a 25% split of an 80-account corpus at 10% scam share, the held-out set may hold 0–2 scams, so recall is noise. Use a stratified split and show the held-out counts next to the metric.
5. **Hour input accepts out-of-range values.** `min`/`max` on `<input type=number>` are only enforced on form submit, and there is no form. Typing 30 silently wraps through `sin/cos`. Clamp in `readScoredTransfer()`.
6. **Gap between transfers is not scorable.** `readScoredTransfer()` hard-codes `secondsSincePrevious: 3600`, though the feature is in the model and is a strong signal for burst scams. Expose it in the score form.

## 3. Accessibility

- Labels are not associated with controls: `.ctl label` is a sibling of the input with no `for`/`id`. Screen readers announce every slider and number box as unlabeled. Either wrap the input inside the `<label>` or add `for`.
- Sliders show their value in a `<span>` only; add `aria-valuetext` or an `<output>` element.
- Both `<canvas>` elements have no fallback text or `aria-label`; the gauge `<svg>` has no `<title>` or `role="img"`.
- Colour is the only cue for legit vs scam in the scatter plot and the verdict. The table is fine because the row carries a label select. The scatter needs marker shapes or a count legend.
- The explanation strip uses `title` tooltips only; they are unreachable by keyboard and touch. Render the top-3 contributing transfers as text under the strip.
- `<i>` is used as a colour swatch in the legend; use `<span aria-hidden="true">`.
- No `prefers-reduced-motion` guard for the `.cell` transition (minor).

## 4. Robustness & security

- **CDN scripts without Subresource Integrity.** Add `integrity` and `crossorigin="anonymous"` to the TF.js tag. The version is already pinned. Without SRI a CDN compromise runs arbitrary code in a page that will one day see real bank data.
- **No offline fallback.** If cdnjs or Google Fonts is unreachable the page silently shows "engine loading…" forever. Detect `typeof tf === 'undefined'` after load and show an error; consider vendoring `tf.min.js` next to the HTML.
- **`innerHTML` with untrusted text.** Today every string rendered via template literals is generated internally, so it is safe. The moment corpus import is added (see section 6), `scenario` and any free-text field must be escaped. Add an `escapeHtml()` helper now.
- Add `<meta name="color-scheme" content="dark">` so form controls and scrollbars match the dark palette, and a `<meta name="description">`.

## 5. Model and ML quality proposals

- **Seeded RNG.** Corpus generation, the train/test split and weight init all use `Math.random()`, so results cannot be reproduced. Add a seed input and a small PRNG (mulberry32), and initialise weights from it.
- **Metrics.** Accuracy at a fixed 0.5 threshold is weak for fraud. Add precision, F1, a confusion matrix and AUC, all cheap on the held-out set, plus a threshold slider that re-evaluates instantly.
- **Stratified split and class weighting.** At 10% scam share the model can reach 90% accuracy by always predicting "legit". Weight the positive class or oversample.
- **Early stopping / validation loss.** Plot held-out loss alongside train loss so overfitting on tiny corpora is visible.
- **Attention visualisation.** The pooling weights already exist inside `forwardPass`. Returning them gives a cheaper and more faithful explanation than the 14-variant occlusion pass, and can be drawn in the same strip.
- **Score against a real history.** Scoring currently drops the transfer onto a canonical "boring" background. Let the user pick a corpus account as the background so the "does it fit this account's story" claim is actually demonstrated.
- **Mask padded positions.** Once real data is imported, accounts with fewer than 14 transfers need left-padding and an attention mask. The model has no mask today.

## 6. Feature proposals (priority order)

1. **Import / export corpus** as CSV or JSON in the format defined in [TRAINING-DATA-GUIDE.md](../training-data/TRAINING-DATA-GUIDE.md). This is the bridge from a synthetic POC to user-supplied data. Export the edited synthetic corpus in the same format so users have a worked example.
2. **Save / load trained weights** (serialise `modelWeights` to JSON via `.arraySync()`, or to `localStorage`) so a demo does not need retraining on every reload.
3. **Filter / sort the corpus table** by scenario, label and peak amount. With 500 rows the table is hard to navigate.
4. **Batch scoring**: score every held-out account and list the false positives and false negatives with their explanation. This is far more convincing than one hand-typed transfer.
5. **HiDPI canvases**: scale by `devicePixelRatio`; the loss curve and scatter are blurry on retina displays.
6. **Light theme** via `prefers-color-scheme`. All colours are already tokens in `:root`.

## 7. Code structure

- Split into `index.html`, `styles.css` and ES modules (`data.js`, `features.js`, `model.js`, `ui.js`, `charts.js`). The file already has the eleven sections marked; the split is mechanical.
- The eleven-section comment header is excellent; keep it as `docs/ARCHITECTURE.md` after the split.
- Add a `package.json` with `html-validate` and a Node test for the pure functions (`encodeTransfer`, `createAccountTimeline`, `projectTo2D`). The smoke test in this review shows they run headless with a two-line stub.
- Extract the risk-band thresholds (0.33 / 0.66) and the preset values into the config section next to the other constants.

## 8. Suggested order of work

| Step | Effort | Items |
|---|---|---|
| Quick wins | under 1 h | button `type`, `th scope`, label `for`, SRI, `try/finally`, optimizer and held-out disposal, hour clamp |
| Editor fix | 1–2 h | keep the editor open across edits |
| Data bridge | half a day | CSV/JSON import and export, `escapeHtml`, padding and mask |
| Evaluation | half a day | stratified split, precision/F1/AUC, confusion matrix, threshold slider, seed |
| Structure | half a day | split into modules, package.json, node tests |
