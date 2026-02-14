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

Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` environment variables. The build step (`build.sh`) generates `js/supabase-config.js` from these.

## Test Harness

```bash
# Regenerate golden files
node fixtures/generate-golden.js

# Run regression tests in browser
open http://localhost:8423/test-harness.html
```
