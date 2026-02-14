# CLAUDE.md - Claude Code Guidance

## Project Overview
**DealUpdates** - A client-side web application for processing and visualizing CRM deal notes data from CSV exports.

## Tech Stack
- HTML5
- CSS3 (CSS Variables, Grid, Flexbox)
- JavaScript (vanilla ES6+)
- localStorage for data persistence

## Development Commands
```bash
# Start a local development server (Python)
python -m http.server 8000

# Or using Node.js http-server (if installed)
npx http-server -p 8000

# Open in browser
start http://localhost:8000
```

## Project Structure
```
DealUpdates/
├── CLAUDE.md              # This file
├── README.md              # Local setup and deployment docs
├── build.sh               # Vercel build step (generates supabase-config.js)
├── index.html             # Main dashboard page
├── test-harness.html      # Browser-runnable regression tests
├── css/
│   └── styles.css         # All styling including urgency badges
├── js/
│   ├── domain.js          # Pure domain functions (UMD, shared by app + Node)
│   ├── ingest.js          # CSV parsing, row processing, deduplication (UMD)
│   ├── app.js             # UI, Supabase, state management
│   ├── supabase-config.js         # Build-generated (gitignored)
│   └── supabase-config.local.js   # Local override (gitignored)
├── supabase/
│   ├── migrations/        # SQL migration files (not auto-run)
│   └── functions/
│       └── summarize-notes/ # Edge function: cache-first AI summaries
└── fixtures/
    ├── generate-golden.js # Node script to regenerate expected snapshots
    ├── 01_clean_small.csv
    ├── 02_multiline_notes.csv
    ├── 03_malformed_rows.csv
    ├── 04_duplicate_deals.csv
    ├── 05_large_mixed.csv
    └── expected/          # Golden JSON snapshots for regression tests
```

## Key Features
- CSV file upload (drag & drop or file picker)
- Auto-detect header row by finding "Deal Owner" and "Deal Name" columns
- Parse Annual Contract Value (CAD only - filters out USD/EUR)
- Strip time from Modified Date, calculate Days Since
- Remove HTML tags from Note Content
- Deduplicate by Deal Name (keep newest Modified Date)
- Filter malformed rows

## Urgency Thresholds (in js/domain.js)
- Fresh: 0-14 days (green)
- Warning: 15-30 days (orange)
- Stale: 31-60 days (red)
- Critical: 60+ days (dark red)

## Data Storage
- Uses localStorage with keys prefixed `dealUpdates_`
  - `dealUpdates_data` — cached deal array
  - `dealUpdates_schema_version` — integer schema version (currently 1)
- Schema version checked on load; stale data cleared automatically on upgrade
- "Clear Local Data" button in header for manual reset (with confirm dialog)

## CSV Column Expectations
Required columns (detected by header names):
- Deal Owner
- Deal Name
- Stage
- Annual Contract Value
- Closing Date
- Modified Time (Notes)
- Note Content
