# DealUpdates

A client-side web dashboard for processing and visualizing CRM deal notes from CSV exports.

## Local Setup

1. Create `js/supabase-config.local.js` with your Supabase credentials:

```js
const SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY_HERE';
```

2. Start a local server:

```bash
python3 -m http.server 8423
```

3. Open http://localhost:8423

The app works offline (localStorage only) if no Supabase config is provided.

## Deployment (Vercel)

The build step (`build.sh`) generates `js/supabase-config.js` from environment variables. Set these in your Vercel project settings under **Settings > Environment Variables**:

| Variable | Example |
|---|---|
| `SUPABASE_URL` | `https://abcdefghij.supabase.co` |
| `SUPABASE_ANON_KEY` | `eyJhbGciOiJIUzI1NiIs...` |

If either variable is missing, the build prints an info message and the app runs in offline mode (localStorage only).

## Local Storage

The app caches deal data in your browser's localStorage for offline use. Stored keys are prefixed with `dealUpdates_`. To reset, click **Clear Local Data** in the header, or manually clear site data in your browser's DevTools.

## Web Worker Architecture

CSV parsing and row processing run in a Web Worker (`js/ingest-worker.js`) to keep the UI responsive during large imports. The worker loads `domain.js` and `ingest.js` via `importScripts`, runs the full parse/process/validate/deduplicate pipeline, and posts progress updates back to the main thread. AI summaries and Supabase operations stay on the main thread since they need the Supabase client. To debug the worker, open DevTools and check the worker's console under **Sources > Threads** or the main console for forwarded messages.

## Deal Health Score

Each deal receives a composite health score from 0 (likely dead) to 100 (strong). The score is a weighted average of six components:

| Component | Default Weight | What it measures |
|---|---|---|
| Stage Probability | 25 | Pipeline stage mapped to a win-likelihood (e.g. Discovery 20, Negotiation 75) |
| Velocity | 20 | Time in current stage vs. benchmark (faster = healthier) |
| Activity Recency | 15 | Days since last note update |
| Close Date Integrity | 10 | Whether the closing date is realistic and hasn't slipped |
| ACV | 15 | Deal size relative to the rest of the pipeline |
| Notes Signal | 15 | Positive/negative keyword matches in note content |

**Configuring.** Click **Scoring** in the header to open the settings modal. You can adjust component weights (auto-normalized to 100), edit the stage-to-score mapping, and customize positive/negative keyword lists. Changes persist to localStorage and recompute scores instantly.

**Sorting & filtering.** The Health column is sortable. A minimum-threshold filter (80+, 60+, 40+, All) lets you focus on deals that need attention.

**Caveats.**
- *Stage age* is approximated from "days since last note update" because the data model doesn't track when a deal entered its current stage. Deals with recent notes but long stage tenure may score higher than warranted.
- *Close date slippage* is inferred from keyword signals ("pushed", "delayed", "moved out", "rescheduled") in notes rather than tracked explicitly. A deal whose close date was moved without a note will not be penalized.

## Test Harness

```bash
# Regenerate golden files
node fixtures/generate-golden.js

# Run regression tests in browser
open http://localhost:8423/test-harness.html
```
