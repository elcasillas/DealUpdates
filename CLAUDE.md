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
├── CLAUDE.md          # This file
├── index.html         # Main dashboard page
├── css/
│   └── styles.css     # All styling including urgency badges
└── js/
    └── app.js         # Core application logic
```

## Key Features
- CSV file upload (drag & drop or file picker)
- Auto-detect header row by finding "Deal Owner" and "Deal Name" columns
- Parse Annual Contract Value (CAD only - filters out USD/EUR)
- Strip time from Modified Date, calculate Days Since
- Remove HTML tags from Note Content
- Deduplicate by Deal Name (keep newest Modified Date)
- Filter malformed rows

## Urgency Thresholds (in js/app.js)
- Fresh: 0-14 days (green)
- Warning: 15-30 days (orange)
- Stale: 31-60 days (red)
- Critical: 60+ days (dark red)

## Data Storage
- Uses localStorage with key `dealUpdates_data`
- Data persists across browser sessions
- Clear Data button removes all stored data

## CSV Column Expectations
Required columns (detected by header names):
- Deal Owner
- Deal Name
- Stage
- Annual Contract Value
- Closing Date
- Modified Time (Notes)
- Note Content
