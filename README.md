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

## Test Harness

```bash
# Regenerate golden files
node fixtures/generate-golden.js

# Run regression tests in browser
open http://localhost:8423/test-harness.html
```
